-- Preserve PIN, limits and site/contract scope; expose only selected authorized components.
BEGIN;
DO $portal$
DECLARE source text; changed text;
BEGIN
 SELECT pg_get_functiondef('public.get_public_tracking_portal_info(uuid,text,date,date)'::regprocedure) INTO source;
 changed:=replace(source,'''parent_ot'',pc.code,',
  $projection$'parent_ot',(WITH RECURSIVE ancestors AS (
    SELECT c.id,c.code,c.parent_contract_id,0 AS depth
    UNION ALL SELECT p.id,p.code,p.parent_contract_id,a.depth+1
    FROM public.contracts p JOIN ancestors a ON p.id=a.parent_contract_id WHERE a.depth<20)
    SELECT code FROM ancestors ORDER BY depth DESC LIMIT 1),
  'components',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',cc.id,'code',cc.code,'type',to_jsonb(cc)->>'type') ORDER BY cc.code),'[]'::jsonb)
    FROM public.transport_request_components rc JOIN public.contracts cc ON cc.id=rc.component_contract_id
    WHERE rc.request_id=t.id AND cc.site_id=link.site_id AND (v_all OR cc.id=ANY(v_ids))),$projection$);
 IF changed=source THEN RAISE EXCEPTION 'No se pudo agregar la familia y los componentes al calendario'; END IF;
 source:=changed;
 changed:=replace(source,'''ot_type'',ot_type,''reference_type'',ref_type,',
  $projection$'ot_type',ot_type,
  'parent_ot',(WITH RECURSIVE ancestors AS (
    SELECT cc.id,cc.code,cc.parent_contract_id,0 AS depth FROM public.transport_requests rt JOIN public.contracts cc ON cc.id=rt.contract_id WHERE rt.id=stops.request_id
    UNION ALL SELECT p.id,p.code,p.parent_contract_id,a.depth+1 FROM public.contracts p JOIN ancestors a ON p.id=a.parent_contract_id WHERE a.depth<20)
    SELECT code FROM ancestors ORDER BY depth DESC LIMIT 1),
  'components',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',cc.id,'code',cc.code,'type',to_jsonb(cc)->>'type') ORDER BY cc.code),'[]'::jsonb)
    FROM public.transport_request_components rc JOIN public.contracts cc ON cc.id=rc.component_contract_id
    WHERE rc.request_id=stops.request_id AND cc.site_id=link.site_id AND (v_all OR cc.id=ANY(v_ids))),
  'reference_type',ref_type,$projection$);
 IF changed=source THEN RAISE EXCEPTION 'No se pudo agregar la familia y los componentes a las rutas'; END IF;
 EXECUTE changed;
END $portal$;
NOTIFY pgrst,'reload schema';
COMMIT;
