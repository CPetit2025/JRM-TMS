-- Recojos y servicios punto a punto se sustentan con OC/OS/RQ y no requieren OT.
-- Entregas de contrato conservan la OT madre; el control financiero no se altera.
BEGIN;
DO $patch$
DECLARE source text;
  marker text := 'IF NULLIF(p_payload->>''contract_id'','''') IS NULL THEN RAISE EXCEPTION ''Seleccione una OT madre activa para registrar la solicitud''; END IF;';
  area_marker text := 'IF NULLIF(p_payload->>''contract_id'','''') IS NULL AND';
  reference_check text := $guard$
  IF p_payload->>'request_type' IN ('RECOJO','TRASLADO') AND (
    coalesce(upper(trim(p_payload->>'reference_type')),'') NOT IN ('OC','OS','RQ') OR
    nullif(trim(p_payload->>'reference_number'),'') IS NULL OR length(trim(p_payload->>'reference_number'))>100
  ) THEN RAISE EXCEPTION 'Seleccione OC, OS o RQ e ingrese su número para el recojo o servicio punto a punto'; END IF;
  IF NULLIF(p_payload->>'contract_id','') IS NULL AND coalesce(p_payload->>'request_type','') NOT IN ('RECOJO','TRASLADO')
    THEN RAISE EXCEPTION 'Seleccione una OT madre activa para registrar la solicitud'; END IF;
  $guard$;
BEGIN
  SELECT pg_get_functiondef('public.save_transport_request(uuid,jsonb,jsonb)'::regprocedure) INTO source;
  IF position(marker IN source)=0 OR position(area_marker IN source)=0 OR position('RETURN v_request_id;' IN source)=0 THEN
    RAISE EXCEPTION 'No se encontraron las validaciones esperadas en save_transport_request';
  END IF;
  source:=replace(source,area_marker,
    'IF coalesce(p_payload->>''request_type'','''') NOT IN (''RECOJO'',''TRASLADO'') AND NULLIF(p_payload->>''contract_id'','''') IS NULL AND');
  source:=replace(source,marker,reference_check);
  source:=replace(source,'RETURN v_request_id;',
    'IF p_payload->>''request_type'' IN (''RECOJO'',''TRASLADO'') THEN'||chr(10)||
    ' UPDATE public.transport_requests SET reference_type=upper(trim(p_payload->>''reference_type'')), reference_number=trim(p_payload->>''reference_number'') WHERE id=v_request_id;'||chr(10)||
    ' END IF;'||chr(10)||' RETURN v_request_id;');
  EXECUTE source;
END $patch$;

DO $area_patch$
DECLARE source text; marker text := 'IF NEW.attention_mode IS NOT NULL AND public.request_area_requires_ot(NEW.department) AND NEW.contract_id IS NULL THEN';
BEGIN
 SELECT pg_get_functiondef('public.request_attention_guard()'::regprocedure) INTO source;
 IF position(marker IN source)=0 THEN RAISE EXCEPTION 'No se encontró el control de área en request_attention_guard'; END IF;
 source:=replace(source,marker,'IF NEW.request_type NOT IN (''RECOJO'',''TRASLADO'') AND NEW.attention_mode IS NOT NULL AND public.request_area_requires_ot(NEW.department) AND NEW.contract_id IS NULL THEN');
 EXECUTE source;
END $area_patch$;

-- La cartera de un Administrador de Contratos incluye sus propios recojos y
-- traslados sustentados en compras. No se abre el acceso a solicitudes ajenas.
CREATE OR REPLACE FUNCTION public.has_assigned_request(p_request_id uuid,p_write boolean DEFAULT false)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.transport_requests r WHERE r.id=p_request_id AND (
   public.has_assigned_contract(r.contract_id,p_write) OR (
     r.contract_id IS NULL AND r.created_by=auth.uid() AND public.is_active_tms_user()
     AND public.can_access_site(r.site_id) AND r.request_type IN ('RECOJO','TRASLADO')
     AND r.reference_type IN ('OC','OS','RQ') AND nullif(trim(r.reference_number),'') IS NOT NULL
     AND length(trim(r.reference_number))<=100
   )
 ));
$$;
REVOKE ALL ON FUNCTION public.has_assigned_request(uuid,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.has_assigned_request(uuid,boolean) TO authenticated;
DROP POLICY IF EXISTS portfolio_request ON public.transport_requests;
CREATE POLICY portfolio_request ON public.transport_requests AS RESTRICTIVE FOR ALL TO authenticated
 USING(NOT public.is_contract_administrator() OR public.has_assigned_contract(contract_id)
   OR public.has_assigned_request(id,false))
 WITH CHECK(NOT public.is_contract_administrator() OR public.has_assigned_contract(contract_id,true)
   OR (contract_id IS NULL AND created_by=auth.uid() AND public.is_active_tms_user()
     AND public.can_access_site(site_id) AND request_type IN ('RECOJO','TRASLADO')
     AND reference_type IN ('OC','OS','RQ') AND nullif(trim(reference_number),'') IS NOT NULL
     AND length(trim(reference_number))<=100));

CREATE OR REPLACE FUNCTION public.enforce_request_mother_client_write()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF current_user<>'authenticated' THEN RETURN NEW; END IF;
  IF NEW.request_type IN ('RECOJO','TRASLADO') THEN
    IF coalesce(NEW.reference_type,'') NOT IN ('OC','OS','RQ') OR nullif(trim(NEW.reference_number),'') IS NULL
       OR length(trim(NEW.reference_number))>100 THEN
      RAISE EXCEPTION 'Seleccione OC, OS o RQ e ingrese su número para el recojo o servicio punto a punto';
    END IF;
  ELSIF NEW.contract_id IS NULL THEN
    RAISE EXCEPTION 'Seleccione una OT madre activa para registrar la solicitud';
  END IF;
  IF NEW.contract_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.contracts c
      WHERE c.id=NEW.contract_id AND c.parent_contract_id IS NULL
        AND c.type IN ('CONTRATO','OT_INDEPENDIENTE') AND c.status='ACTIVO' AND c.site_id=NEW.site_id) THEN
    RAISE EXCEPTION 'Seleccione una OT madre activa para registrar la solicitud';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.enforce_request_mother_client_write() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS enforce_request_mother_client_write ON public.transport_requests;
CREATE TRIGGER enforce_request_mother_client_write BEFORE INSERT OR UPDATE OF contract_id,site_id,request_type,reference_type,reference_number
  ON public.transport_requests FOR EACH ROW EXECUTE FUNCTION public.enforce_request_mother_client_write();
NOTIFY pgrst,'reload schema';
COMMIT;
