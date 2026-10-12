-- Independent ERP/physical observations. Never updates FIFO, movements or inferred opening.
BEGIN;
CREATE TABLE IF NOT EXISTS public.apt_stock_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 cutoff date NOT NULL,
 almacen text NOT NULL CHECK(almacen IN ('647','540','ST')),
 lote text NOT NULL CHECK(length(lote) BETWEEN 1 AND 120),
 producto text NOT NULL CHECK(length(producto) BETWEEN 1 AND 160),
 peso_kg numeric(18,6) NOT NULL CHECK(peso_kg >= 0 AND peso_kg < 1000000000000),
 source text NOT NULL CHECK(source IN ('ERP','FISICO')),
 reference text NOT NULL CHECK(length(reference) BETWEEN 1 AND 500),
 notes text CHECK(length(notes)<=2000),
 created_by uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS apt_stock_observations_key ON public.apt_stock_observations(cutoff,almacen,lote,producto,source,created_at DESC,id DESC);
ALTER TABLE public.apt_stock_observations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.apt_stock_observations;
CREATE POLICY security_active_account ON public.apt_stock_observations AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.apt_stock_observations FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.apt_stock_observations TO service_role;

CREATE OR REPLACE FUNCTION public.apt_stock_observation_save(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_cut date; v_id uuid; v_user uuid:=auth.uid(); v_weight numeric;
BEGIN
 IF v_user IS NULL OR NOT public.is_active_tms_user() OR NOT public.apt_can_load() THEN RETURN jsonb_build_object('success',false,'error','Sin permiso para registrar conciliaciones APT'); END IF;
 IF p IS NULL OR jsonb_typeof(p)<>'object' THEN RETURN jsonb_build_object('success',false,'error','Registro inválido'); END IF;
 v_cut:=public.apt_date(p->'cutoff');
 IF v_cut IS NULL OR v_cut>(now() AT TIME ZONE 'America/Lima')::date THEN RETURN jsonb_build_object('success',false,'error','Seleccione una fecha de corte válida, hasta hoy'); END IF;
 IF COALESCE(p->>'almacen','') NOT IN ('647','540','ST') OR COALESCE(p->>'source','') NOT IN ('ERP','FISICO') THEN
  RETURN jsonb_build_object('success',false,'error','Indique almacén y fuente ERP o FISICO'); END IF;
 IF length(btrim(COALESCE(p->>'lote',''))) NOT BETWEEN 1 AND 120 OR length(btrim(COALESCE(p->>'producto',''))) NOT BETWEEN 1 AND 160
 OR length(btrim(COALESCE(p->>'reference',''))) NOT BETWEEN 1 AND 500 OR length(COALESCE(p->>'notes',''))>2000 THEN
  RETURN jsonb_build_object('success',false,'error','Complete lote, producto y referencia de evidencia dentro de los límites'); END IF;
 IF COALESCE(p->>'peso_kg','') !~ '^[0-9]{1,12}(\.[0-9]{1,6})?$' THEN
  RETURN jsonb_build_object('success',false,'error','Peso en kg inválido: debe ser no negativo con hasta seis decimales'); END IF;
 v_weight:=(p->>'peso_kg')::numeric;
 INSERT INTO public.apt_stock_observations(cutoff,almacen,lote,producto,peso_kg,source,reference,notes,created_by)
 VALUES(v_cut,p->>'almacen',upper(btrim(p->>'lote')),btrim(p->>'producto'),v_weight,p->>'source',btrim(p->>'reference'),NULLIF(btrim(p->>'notes'),''),v_user)
 RETURNING id INTO v_id;
 RETURN jsonb_build_object('success',true,'id',v_id,'message','Observación registrada; el inventario reconstruido no fue modificado');
END $$;

CREATE OR REPLACE FUNCTION public.apt_stock_reconciliation(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.apt_flow_state%ROWTYPE; v_cut date; v_rows jsonb; v_count integer; v_limit integer; v_offset integer; v_available boolean; v_fresh boolean; v_applied timestamptz;
BEGIN
 IF NOT public.is_active_tms_user() OR NOT public.apt_can_view() THEN RETURN jsonb_build_object('success',false,'error','Sin acceso al módulo APT'); END IF;
 p:=COALESCE(p,'{}'::jsonb);
 IF jsonb_typeof(p)<>'object' THEN RETURN jsonb_build_object('success',false,'error','Filtros inválidos'); END IF;
 SELECT * INTO s FROM public.apt_flow_state WHERE id=1;
 SELECT max(applied_at) INTO v_applied FROM public.apt_uploads WHERE status='APLICADA';
 v_cut:=COALESCE(public.apt_date(p->'cutoff'),s.cutoff);
 IF p ? 'cutoff' AND public.apt_date(p->'cutoff') IS NULL THEN RETURN jsonb_build_object('success',false,'error','Corte inválido'); END IF;
 IF NULLIF(p->>'almacen','') IS NOT NULL AND p->>'almacen' NOT IN ('647','540','ST') THEN RETURN jsonb_build_object('success',false,'error','Almacén inválido'); END IF;
 IF NULLIF(p->>'source','') IS NOT NULL AND p->>'source' NOT IN ('ERP','FISICO') THEN RETURN jsonb_build_object('success',false,'error','Fuente inválida'); END IF;
 IF COALESCE(p->>'limit','25') !~ '^[0-9]{1,6}$' OR COALESCE(p->>'offset','0') !~ '^[0-9]{1,9}$' THEN RETURN jsonb_build_object('success',false,'error','Paginación inválida'); END IF;
 v_limit:=LEAST(GREATEST(COALESCE((p->>'limit')::integer,25),1),100);
 v_offset:=GREATEST(COALESCE((p->>'offset')::integer,0),0);
 -- A same-date replacement can invalidate the model without changing its cutoff.
 -- Observations remain visible, but cannot be certified against old movements.
 v_fresh:=s.cutoff IS NOT NULL AND s.rebuilt_at IS NOT NULL AND (v_applied IS NULL OR s.rebuilt_at>=v_applied);
 v_available:=COALESCE(v_cut BETWEEN s.data_min AND s.cutoff,false) AND v_fresh;
 WITH latest AS (
 SELECT DISTINCT ON(almacen,lote,producto,source) * FROM public.apt_stock_observations
 WHERE cutoff=v_cut AND (NULLIF(p->>'almacen','') IS NULL OR almacen=p->>'almacen')
 AND (NULLIF(p->>'source','') IS NULL OR source=p->>'source')
 AND (NULLIF(p->>'lote','') IS NULL OR lote ILIKE '%'||btrim(p->>'lote')||'%')
 ORDER BY almacen,lote,producto,source,created_at DESC,id DESC)
 SELECT count(*) INTO v_count FROM latest;
 WITH latest AS (
 SELECT DISTINCT ON(almacen,lote,producto,source) * FROM public.apt_stock_observations
 WHERE cutoff=v_cut AND (NULLIF(p->>'almacen','') IS NULL OR almacen=p->>'almacen')
 AND (NULLIF(p->>'source','') IS NULL OR source=p->>'source')
 AND (NULLIF(p->>'lote','') IS NULL OR lote ILIKE '%'||btrim(p->>'lote')||'%')
 ORDER BY almacen,lote,producto,source,created_at DESC,id DESC),
 page AS(SELECT * FROM latest ORDER BY almacen,lote,producto,source LIMIT v_limit OFFSET v_offset),
 compared AS(SELECT o.*, CASE WHEN v_available THEN
 COALESCE((SELECT sum(l.kg_in) FROM public.apt_flow_layers l WHERE l.almacen=o.almacen AND l.lote=o.lote AND l.producto=o.producto AND (l.fecha IS NULL OR l.fecha<=v_cut)),0)
 - COALESCE((SELECT sum(x.kg) FROM public.apt_flow_exits x WHERE x.almacen=o.almacen AND x.lote=o.lote AND x.producto=o.producto AND x.fecha<=v_cut),0)
 END AS documentary_kg FROM page o)
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'cutoff',cutoff,'almacen',almacen,'lote',lote,'producto',producto,
 'source',source,'reference',reference,'notes',notes,'observed_kg',peso_kg,'documentary_kg',documentary_kg,
 'difference_kg',peso_kg-documentary_kg,'created_at',created_at,
 'status',CASE WHEN NOT v_fresh AND v_cut BETWEEN s.data_min AND s.cutoff THEN 'MODELO_PENDIENTE' WHEN documentary_kg IS NULL THEN 'MODELO_NO_DISPONIBLE' WHEN abs(peso_kg-documentary_kg)<=0.0005 THEN 'COINCIDE_DOCUMENTAL' ELSE 'DIFERENCIA' END)
 ORDER BY almacen,lote,producto,source),'[]') INTO v_rows FROM compared;
 RETURN jsonb_build_object('success',true,'cutoff',v_cut,'model_cutoff',s.cutoff,'rebuilt_at',s.rebuilt_at,'documentary_available',v_available,
 'model_fresh',v_fresh,'latest_applied_at',v_applied,'scope','OBSERVACIONES_REGISTRADAS','certifies_full_inventory',false,'rows',v_rows,'total',v_count,'limit',v_limit,'offset',v_offset);
END $$;
REVOKE ALL ON FUNCTION public.apt_stock_observation_save(jsonb),public.apt_stock_reconciliation(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.apt_stock_observation_save(jsonb),public.apt_stock_reconciliation(jsonb) TO authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
