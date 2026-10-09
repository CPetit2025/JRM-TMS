-- Portal público: cada acceso identifica a su destinatario (label) y puede autorizar clientes completos
-- (client_ids): todas sus OT, subcontratos y errores, también las que se registren después.
BEGIN;
ALTER TABLE public.tracking_portal_links
 ADD COLUMN IF NOT EXISTS label text,
 ADD COLUMN IF NOT EXISTS client_ids uuid[] NOT NULL DEFAULT '{}';

-- OT autorizadas por un acceso: OT elegidas + OT de los clientes elegidos, con su familia. NULL = toda la sede.
CREATE OR REPLACE FUNCTION public.tracking_portal_scope_ids(p_contracts uuid[], p_clients uuid[]) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT CASE WHEN COALESCE(cardinality(p_contracts),0) = 0 AND COALESCE(cardinality(p_clients),0) = 0 THEN NULL
 ELSE COALESCE(public.tracking_portal_contract_family(ARRAY(
   SELECT c.id FROM public.contracts c WHERE c.id = ANY(COALESCE(p_contracts,'{}')) OR c.client_id = ANY(COALESCE(p_clients,'{}')))),'{}'::uuid[]) END;
$$;
REVOKE ALL ON FUNCTION public.tracking_portal_scope_ids(uuid[],uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tracking_portal_scope_ids(uuid[],uuid[]) TO service_role;

CREATE OR REPLACE FUNCTION public.generate_tracking_portal_link(p_scope jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE site uuid:=(p_scope->>'site_id')::uuid; ids uuid[]; clients uuid[]; pin text; tok uuid;
 v_label text:=NULLIF(left(btrim(COALESCE(p_scope->>'label','')),120),'');
BEGIN
 IF NOT public.has_tms_permission('despacho') OR NOT public.can_access_site(site) THEN RAISE EXCEPTION 'Sin permiso para compartir esta sede'; END IF;
 SELECT COALESCE(array_agg(value::uuid),'{}') INTO ids FROM jsonb_array_elements_text(COALESCE(p_scope->'contract_ids','[]'));
 SELECT COALESCE(array_agg(value::uuid),'{}') INTO clients FROM jsonb_array_elements_text(COALESCE(p_scope->'client_ids','[]'));
 IF cardinality(ids)>100 OR EXISTS(SELECT 1 FROM unnest(ids) x WHERE NOT EXISTS(SELECT 1 FROM public.contracts c WHERE c.id=x AND c.site_id=site)) THEN RAISE EXCEPTION 'OT fuera del alcance autorizado'; END IF;
 IF cardinality(clients)>20 OR EXISTS(SELECT 1 FROM unnest(clients) x WHERE NOT EXISTS(SELECT 1 FROM public.contracts c WHERE c.client_id=x AND c.site_id=site)) THEN RAISE EXCEPTION 'Cliente sin OT en esta sede'; END IF;
 pin:=lpad((('x'||substr(replace(gen_random_uuid()::text,'-',''),1,8))::bit(32)::bigint % 100000000)::text,8,'0');
 INSERT INTO public.tracking_portal_links(site_id,contract_ids,client_ids,label,pin_hash,created_by)
 VALUES(site,ids,clients,v_label,extensions.crypt(pin,extensions.gen_salt('bf',8)),auth.uid()) RETURNING token INTO tok;
 RETURN jsonb_build_object('token',tok,'pin',pin,'label',v_label,'scope',jsonb_build_object('site_id',site,'contract_ids',ids,'client_ids',clients));
END $$;
REVOKE ALL ON FUNCTION public.generate_tracking_portal_link(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_tracking_portal_link(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_tracking_portal_links() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object('token',token,'site_id',site_id,'contract_ids',contract_ids,'client_ids',client_ids,'label',label,
  'created_at',created_at,'revoked_at',revoked_at,'rotated_at',rotated_at) ORDER BY created_at DESC),'[]')
 FROM public.tracking_portal_links WHERE public.has_tms_permission('despacho') AND public.can_access_site(site_id);
$$;
REVOKE ALL ON FUNCTION public.list_tracking_portal_links() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_tracking_portal_links() TO authenticated;

-- Opciones del creador: clientes con OT en cada sede y OT con cliente, tipo y OT madre.
CREATE OR REPLACE FUNCTION public.get_tracking_portal_scope_options() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT public.has_tms_permission('despacho') THEN RAISE EXCEPTION 'Sin permiso'; END IF;
 RETURN jsonb_build_object('sites',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',s.id,'name',COALESCE(to_jsonb(s)->>'name',to_jsonb(s)->>'code',s.id::text))),'[]') FROM public.sites s WHERE public.can_access_site(s.id)),
 'clients',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',cl.id,'name',cl.business_name) ORDER BY cl.business_name),'[]') FROM public.clients cl
   WHERE EXISTS(SELECT 1 FROM public.contracts c WHERE c.client_id=cl.id AND public.can_access_site(c.site_id))),
 'contracts',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',c.id,'code',c.code,'site_id',c.site_id,'client_id',c.client_id,'type',to_jsonb(c)->>'type','parent_id',c.parent_contract_id) ORDER BY c.code),'[]') FROM public.contracts c WHERE public.can_access_site(c.site_id)));
END $$;
REVOKE ALL ON FUNCTION public.get_tracking_portal_scope_options() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_tracking_portal_scope_options() TO authenticated;

-- Las funciones públicas usan el nuevo alcance (OT + clientes) y la consulta devuelve el destinatario.
-- Se reescriben sobre su definición vigente para conservar el esquema de pgcrypto ya resuelto.
DO $scope$
DECLARE signature regprocedure; source text; changed text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['public.get_public_tracking_portal_info(uuid,text,date,date)'::regprocedure,
   'public.get_public_tracking_document(uuid,text,text,uuid,uuid,integer)'::regprocedure] LOOP
  SELECT pg_get_functiondef(signature) INTO source;
  changed:=replace(source,'v_all:=cardinality(link.contract_ids)=0;','v_all:=cardinality(link.contract_ids)=0 AND cardinality(link.client_ids)=0;');
  changed:=replace(changed,'public.tracking_portal_contract_family(link.contract_ids)','public.tracking_portal_scope_ids(link.contract_ids,link.client_ids)');
  changed:=replace(changed,'RETURN jsonb_build_object(''mode'',''permanent'',','RETURN jsonb_build_object(''mode'',''permanent'',''label'',link.label,');
  IF changed=source OR position('tracking_portal_scope_ids' IN changed)=0 THEN RAISE EXCEPTION 'No se pudo actualizar el alcance de %', signature; END IF;
  EXECUTE changed;
 END LOOP;
END $scope$;

-- pgcrypto puede estar en otro esquema (ver 20261009020000): calificar generate_tracking_portal_link igual que allí.
DO $crypto_schema$
DECLARE crypto_schema text; source text;
BEGIN
 SELECT n.nspname INTO crypto_schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto';
 IF crypto_schema IS NULL THEN RAISE EXCEPTION 'Se requiere pgcrypto para proteger los códigos de acceso'; END IF;
 IF crypto_schema <> 'extensions' THEN
  SELECT pg_get_functiondef('public.generate_tracking_portal_link(jsonb)'::regprocedure) INTO source;
  source:=replace(source,'extensions.crypt(',format('%I.crypt(',crypto_schema));
  source:=replace(source,'extensions.gen_salt(',format('%I.gen_salt(',crypto_schema));
  EXECUTE source;
 END IF;
END $crypto_schema$;
COMMIT;
