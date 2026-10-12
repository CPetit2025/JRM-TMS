-- Solicitudes: alta acotada de variantes y vinculación obligatoria a OT madre.
BEGIN;

CREATE OR REPLACE FUNCTION public.create_transport_request_component(
  p_root_id uuid, p_component_type text, p_suffix text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_root public.contracts%ROWTYPE;
  v_type text := upper(trim(coalesce(p_component_type,'')));
  v_suffix text := upper(trim(coalesce(p_suffix,'')));
  v_id uuid;
  v_code text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_tms_user() OR NOT public.has_tms_permission('solicitudes') THEN
    RAISE EXCEPTION 'Sin permiso para registrar componentes de solicitudes';
  END IF;
  IF v_type NOT IN ('SUBCONTRATO','ERROR') THEN
    RETURN jsonb_build_object('success',false,'error','Seleccione Subcontrato o Error');
  END IF;
  IF v_suffix !~ (CASE WHEN v_type='SUBCONTRATO' THEN '^S[0-9]{1,10}$' ELSE '^E[0-9]{1,10}$' END) THEN
    RETURN jsonb_build_object('success',false,'error',CASE WHEN v_type='SUBCONTRATO'
      THEN 'Indique el código del subcontrato, por ejemplo S001' ELSE 'Indique el código del error, por ejemplo E014' END);
  END IF;
  SELECT * INTO v_root FROM public.contracts WHERE id=p_root_id FOR UPDATE;
  IF v_root.id IS NULL OR v_root.parent_contract_id IS NOT NULL OR v_root.type NOT IN ('CONTRATO','OT_INDEPENDIENTE')
     OR v_root.status IS DISTINCT FROM 'ACTIVO' OR NOT public.can_access_site(v_root.site_id)
     OR (public.is_contract_administrator() AND NOT public.has_assigned_contract(v_root.id,true)) THEN
    RAISE EXCEPTION 'Seleccione una OT madre asignada y activa';
  END IF;
  IF nullif(trim(v_root.code),'') IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','La OT madre no tiene código. Corríjalo antes de registrar un componente');
  END IF;
  v_code:=v_root.code||'-'||v_suffix;
  IF length(v_code)>100 THEN RETURN jsonb_build_object('success',false,'error','El código supera 100 caracteres'); END IF;
  IF EXISTS(SELECT 1 FROM public.contracts WHERE code=v_code) THEN
    RETURN jsonb_build_object('success',false,'error','El código ya existe. Selecciónelo entre los componentes de la OT');
  END IF;
  -- Herencia de cliente/sede/destino; no se concede permiso para modificar partidas.
  -- Todos estos campos están verificados en production-shape.sql.
  INSERT INTO public.contracts(code,type,parent_contract_id,site_id,client_id,status,created_by,
    destination_address,destination_department,destination_province,destination_district)
  VALUES(v_code,v_type,v_root.id,v_root.site_id,v_root.client_id,'ACTIVO',auth.uid(),
    v_root.destination_address,v_root.destination_department,v_root.destination_province,v_root.destination_district)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('success',true,'id',v_id,'code',v_code,'root_id',v_root.id,'type',v_type);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success',false,'error','El código ya existe. Selecciónelo entre los componentes de la OT');
END $$;
REVOKE ALL ON FUNCTION public.create_transport_request_component(uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_transport_request_component(uuid,text,text) TO authenticated;

-- La API de guardado valida incluso bajo SECURITY DEFINER. Las escrituras
-- directas del cliente autenticado tampoco pueden omitir o sustituir la madre.
-- Las reparaciones administrativas de históricos conservan su vía existente.
CREATE OR REPLACE FUNCTION public.enforce_request_mother_client_write()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF current_user='authenticated' AND NOT EXISTS(SELECT 1 FROM public.contracts c
      WHERE c.id=NEW.contract_id AND c.parent_contract_id IS NULL
        AND c.type IN ('CONTRATO','OT_INDEPENDIENTE') AND c.status='ACTIVO'
        AND c.site_id=NEW.site_id) THEN
    RAISE EXCEPTION 'Seleccione una OT madre activa para registrar la solicitud';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.enforce_request_mother_client_write() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS enforce_request_mother_client_write ON public.transport_requests;
CREATE TRIGGER enforce_request_mother_client_write BEFORE INSERT OR UPDATE OF contract_id,site_id
  ON public.transport_requests FOR EACH ROW EXECUTE FUNCTION public.enforce_request_mother_client_write();

-- Adaptar la definición vigente conserva las capas posteriores (anticipación,
-- proveedor/cliente y aprobación) sin reemplazarlas con una versión antigua.
DO $patch$
DECLARE source text; marker text := 'IF NULLIF(p_payload->>''contract_id'','''') IS NULL AND';
BEGIN
  SELECT pg_get_functiondef('public.save_transport_request(uuid,jsonb,jsonb)'::regprocedure) INTO source;
  IF position(marker IN source)=0 THEN RAISE EXCEPTION 'No se encontró la validación de OT en save_transport_request'; END IF;
  source:=replace(source,marker,
    'IF NULLIF(p_payload->>''contract_id'','''') IS NULL THEN RAISE EXCEPTION ''Seleccione una OT madre activa para registrar la solicitud''; END IF;'||chr(10)||'  '||marker);
  EXECUTE source;
END $patch$;
NOTIFY pgrst,'reload schema';
COMMIT;
