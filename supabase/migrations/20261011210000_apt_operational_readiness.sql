-- Explicit operational review, distinct from reconstructed inventory and delivery conformity.
CREATE TABLE IF NOT EXISTS public.apt_operational_readiness (
 almacen text NOT NULL CHECK (almacen IN ('647','540','ST')),
 lote text NOT NULL CHECK (length(lote) BETWEEN 1 AND 120),
 producto text NOT NULL DEFAULT '*' CHECK (length(producto) BETWEEN 1 AND 120),
 status text NOT NULL DEFAULT 'NO_EVALUADO' CHECK (status IN ('NO_EVALUADO','DISPONIBLE','BLOQUEADO')),
 reason text, responsible_name text, next_action text,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
 PRIMARY KEY(almacen,lote,producto),
 CHECK (status='NO_EVALUADO' OR (length(trim(COALESCE(reason,'')))>0 AND length(trim(COALESCE(responsible_name,'')))>0 AND length(trim(COALESCE(next_action,'')))>0))
);
CREATE TABLE IF NOT EXISTS public.apt_operational_readiness_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 almacen text NOT NULL,lote text NOT NULL,producto text NOT NULL,
 before_data jsonb,after_data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),created_by uuid
);
ALTER TABLE public.apt_operational_readiness ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.apt_operational_readiness_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.apt_operational_readiness;
CREATE POLICY security_active_account ON public.apt_operational_readiness AS RESTRICTIVE FOR ALL TO authenticated
 USING((SELECT public.is_active_tms_user())) WITH CHECK((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS security_active_account ON public.apt_operational_readiness_history;
CREATE POLICY security_active_account ON public.apt_operational_readiness_history AS RESTRICTIVE FOR ALL TO authenticated
 USING((SELECT public.is_active_tms_user())) WITH CHECK((SELECT public.is_active_tms_user()));
CREATE OR REPLACE FUNCTION public.apt_readiness_history_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'El historial de revisión es inmutable'; END $$;
DROP TRIGGER IF EXISTS apt_readiness_history_immutable ON public.apt_operational_readiness_history;
CREATE TRIGGER apt_readiness_history_immutable BEFORE UPDATE OR DELETE ON public.apt_operational_readiness_history FOR EACH ROW EXECUTE FUNCTION public.apt_readiness_history_immutable();
DROP POLICY IF EXISTS apt_readiness_read ON public.apt_operational_readiness;
CREATE POLICY apt_readiness_read ON public.apt_operational_readiness FOR SELECT TO authenticated USING(public.apt_can_view());
DROP POLICY IF EXISTS apt_readiness_history_read ON public.apt_operational_readiness_history;
CREATE POLICY apt_readiness_history_read ON public.apt_operational_readiness_history FOR SELECT TO authenticated USING(public.apt_can_view());
REVOKE ALL ON public.apt_operational_readiness FROM anon, authenticated;
REVOKE ALL ON public.apt_operational_readiness_history FROM anon, authenticated;
GRANT SELECT ON public.apt_operational_readiness,public.apt_operational_readiness_history TO authenticated;

CREATE OR REPLACE FUNCTION public.apt_readiness_list(p_keys jsonb DEFAULT '[]') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_rows jsonb;
BEGIN
 IF NOT public.is_active_tms_user() OR NOT public.apt_can_view() THEN RETURN jsonb_build_object('success',false,'error','Sin acceso al módulo APT'); END IF;
 IF jsonb_typeof(p_keys)<>'array' OR jsonb_array_length(p_keys)>100 THEN RETURN jsonb_build_object('success',false,'error','Seleccione hasta 100 registros'); END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]') INTO v_rows FROM public.apt_operational_readiness r
 WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(p_keys) k WHERE r.almacen=k->>'almacen' AND r.lote=k->>'lote' AND r.producto=COALESCE(NULLIF(k->>'producto',''),'*'));
 RETURN jsonb_build_object('success',true,'rows',v_rows,'can_edit',public.apt_can_load());
END $$;

CREATE OR REPLACE FUNCTION public.apt_readiness_save(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_almacen text:=p->>'almacen';v_lote text:=trim(p->>'lote');v_producto text:=COALESCE(NULLIF(trim(p->>'producto'),''),'*');v_before jsonb;v_after jsonb;v_expected text:=p->>'expected_updated_at';
BEGIN
 IF NOT public.is_active_tms_user() OR NOT public.apt_can_load() OR auth.uid() IS NULL THEN RETURN jsonb_build_object('success',false,'error','Sin permiso para registrar la revisión APT'); END IF;
 IF v_almacen NOT IN('647','540','ST') OR v_lote IS NULL OR length(v_lote) NOT BETWEEN 1 AND 120 OR length(v_producto)>120 OR COALESCE(p->>'status','') NOT IN('NO_EVALUADO','DISPONIBLE','BLOQUEADO') THEN RETURN jsonb_build_object('success',false,'error','Revise almacén, lote y estado'); END IF;
 IF length(COALESCE(p->>'reason',''))>2000 OR length(COALESCE(p->>'responsible_name',''))>200 OR length(COALESCE(p->>'next_action',''))>2000 THEN RETURN jsonb_build_object('success',false,'error','El texto supera el tamaño permitido'); END IF;
 IF p->>'status'<>'NO_EVALUADO' AND (length(trim(COALESCE(p->>'reason','')))=0 OR length(trim(COALESCE(p->>'responsible_name','')))=0 OR length(trim(COALESCE(p->>'next_action','')))=0) THEN RETURN jsonb_build_object('success',false,'error','Registre motivo, responsable y próxima acción'); END IF;
 -- Serialize new keys as well as updates, so two reviewers cannot silently overwrite one another.
 PERFORM pg_advisory_xact_lock(hashtextextended(v_almacen||'|'||v_lote||'|'||v_producto,0));
 SELECT to_jsonb(r) INTO v_before FROM public.apt_operational_readiness r WHERE almacen=v_almacen AND lote=v_lote AND producto=v_producto FOR UPDATE;
 IF (v_before IS NOT NULL AND (v_expected IS NULL OR (v_before->>'updated_at')::timestamptz<>v_expected::timestamptz)) OR (v_before IS NULL AND v_expected IS NOT NULL) THEN RETURN jsonb_build_object('success',false,'error','La revisión cambió. Actualice y vuelva a revisar.'); END IF;
 INSERT INTO public.apt_operational_readiness(almacen,lote,producto,status,reason,responsible_name,next_action,updated_by) VALUES(v_almacen,v_lote,v_producto,p->>'status',NULLIF(trim(p->>'reason'),''),NULLIF(trim(p->>'responsible_name'),''),NULLIF(trim(p->>'next_action'),''),auth.uid())
 ON CONFLICT(almacen,lote,producto) DO UPDATE SET status=EXCLUDED.status,reason=EXCLUDED.reason,responsible_name=EXCLUDED.responsible_name,next_action=EXCLUDED.next_action,updated_at=clock_timestamp(),updated_by=auth.uid()
 RETURNING to_jsonb(apt_operational_readiness) INTO v_after;
 INSERT INTO public.apt_operational_readiness_history(almacen,lote,producto,before_data,after_data,created_by) VALUES(v_almacen,v_lote,v_producto,v_before,v_after,auth.uid());
 RETURN jsonb_build_object('success',true,'row',v_after);
END $$;
REVOKE ALL ON FUNCTION public.apt_readiness_list(jsonb),public.apt_readiness_save(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.apt_readiness_list(jsonb),public.apt_readiness_save(jsonb) TO authenticated;
