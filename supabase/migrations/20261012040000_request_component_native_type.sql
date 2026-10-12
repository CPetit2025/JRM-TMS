-- Production contracts.type is contract_type, while older schemas use text.
-- Resolve the INSERT variable against the actual column type; preserve permissions and validation.
BEGIN;

CREATE OR REPLACE FUNCTION public.create_transport_request_component(
  p_root_id uuid, p_component_type text, p_suffix text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_root public.contracts%ROWTYPE;
  v_insert_type public.contracts.type%TYPE;
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
  v_insert_type:=v_type;
  INSERT INTO public.contracts(code,type,parent_contract_id,site_id,client_id,status,created_by,
    destination_address,destination_department,destination_province,destination_district)
  VALUES(v_code,v_insert_type,v_root.id,v_root.site_id,v_root.client_id,'ACTIVO',auth.uid(),
    v_root.destination_address,v_root.destination_department,v_root.destination_province,v_root.destination_district)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('success',true,'id',v_id,'code',v_code,'root_id',v_root.id,'type',v_type);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success',false,'error','El código ya existe. Selecciónelo entre los componentes de la OT');
END $$;
REVOKE ALL ON FUNCTION public.create_transport_request_component(uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_transport_request_component(uuid,text,text) TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
