-- ============================================================
-- Nada sin cliente o proveedor (según el caso)
-- ============================================================
-- * OT madre / independiente: cliente obligatorio. Subcontratos y errores heredan el cliente de su OT raíz.
-- * Entregas (y recojo por el cliente): cliente obligatorio; con OT se toma de la OT, sin OT se elige en la solicitud
--   (nueva columna transport_requests.client_id).
-- * Recojos y traslados: proveedor obligatorio (ya lo exige enforce_request_supplier de 20261009120000).
-- * No se programa en ruta una solicitud sin su cliente o proveedor.
-- * Un cliente ya asignado no se quita, y solo el Administrador lo cambia. Completar uno que faltaba lo puede hacer
--   quien tenga escritura en el módulo (set_contract_client / set_request_party).
-- Los controles son disparadores diferidos (se validan al confirmar, como el de proveedor): cubren cualquier vía
-- (formulario, Excel, JRM IA, RPC) y dejan editar los registros antiguos mientras no se toquen estos campos.
-- Corrección puntual: OT 16533 → cliente con RUC 20615877116 (solo si es único y la OT sigue sin cliente).
BEGIN;

-- Cliente de la OT raíz de cualquier registro de la familia
CREATE OR REPLACE FUNCTION public.contract_root_client(p_contract uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.client_id FROM public.contracts c WHERE c.id = COALESCE(public.contract_root_id(p_contract), p_contract)
$$;
REVOKE ALL ON FUNCTION public.contract_root_client(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.contract_root_client(uuid) TO authenticated, service_role;

-- Cliente vigente (is_active en producción; si la columna no existe se considera vigente)
CREATE OR REPLACE FUNCTION public.client_is_active(p_client uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.clients cl WHERE cl.id = p_client
                  AND COALESCE((to_jsonb(cl)->>'is_active')::boolean, true))
$$;
REVOKE ALL ON FUNCTION public.client_is_active(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.client_is_active(uuid) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 1. Corrección puntual de la OT 16533
-- ------------------------------------------------------------
DO $fix$
DECLARE v_n int; v_client uuid; v_ot uuid; v_root uuid;
BEGIN
  SELECT count(*), (array_agg(cl.id))[1] INTO v_n, v_client FROM public.clients cl
   WHERE regexp_replace(COALESCE(to_jsonb(cl)->>'tax_id', to_jsonb(cl)->>'ruc', ''), '\D', '', 'g') = '20615877116';
  SELECT id INTO v_ot FROM public.contracts WHERE btrim(code::text) = '16533' ORDER BY parent_contract_id NULLS FIRST LIMIT 1;
  IF v_n = 1 AND v_ot IS NOT NULL THEN
    v_root := COALESCE(public.contract_root_id(v_ot), v_ot);
    UPDATE public.contracts SET client_id = v_client WHERE id = v_root AND client_id IS NULL;
    RAISE NOTICE 'OT 16533: cliente con RUC 20615877116 asignado a la OT raíz %', v_root;
  ELSE
    RAISE NOTICE 'OT 16533 sin corregir: clientes con ese RUC = %, OT encontrada = %', v_n, v_ot;
  END IF;
END $fix$;

-- ------------------------------------------------------------
-- 2. Herencia y regularización de la familia
-- ------------------------------------------------------------
UPDATE public.contracts ch SET client_id = public.contract_root_client(ch.id)
 WHERE ch.parent_contract_id IS NOT NULL AND public.contract_root_client(ch.id) IS NOT NULL
   AND ch.client_id IS DISTINCT FROM public.contract_root_client(ch.id);

CREATE OR REPLACE FUNCTION public.contracts_inherit_client() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v uuid;
BEGIN
  IF NEW.parent_contract_id IS NOT NULL THEN
    v := public.contract_root_client(NEW.parent_contract_id);
    IF v IS NOT NULL THEN NEW.client_id := v; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.contracts_inherit_client() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS contracts_inherit_client ON public.contracts;
CREATE TRIGGER contracts_inherit_client BEFORE INSERT OR UPDATE OF parent_contract_id, client_id ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION public.contracts_inherit_client();

-- Al asignar o cambiar el cliente de una OT raíz se propaga a su familia y a sus solicitudes
CREATE OR REPLACE FUNCTION public.contracts_propagate_client() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.client_id IS NOT NULL THEN
    UPDATE public.contracts SET client_id = NEW.client_id
     WHERE parent_contract_id = NEW.id AND client_id IS DISTINCT FROM NEW.client_id;
    IF to_regclass('public.transport_requests') IS NOT NULL THEN
      UPDATE public.transport_requests SET client_id = NEW.client_id
       WHERE contract_id = NEW.id AND client_id IS DISTINCT FROM NEW.client_id;
    END IF;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.contracts_propagate_client() FROM PUBLIC, anon, authenticated;

-- Invariante de la OT, validado al confirmar
CREATE OR REPLACE FUNCTION public.enforce_contract_client() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record;
BEGIN
  SELECT c.id, c.code::text AS code, c.client_id, c.parent_contract_id INTO r FROM public.contracts c WHERE c.id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF r.client_id IS NULL THEN
    IF TG_OP = 'UPDATE' AND OLD.client_id IS NOT NULL THEN
      RAISE EXCEPTION 'No se puede quitar el cliente de la OT %', r.code USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
      IF r.parent_contract_id IS NULL THEN
        RAISE EXCEPTION 'La OT % necesita un cliente: selecciónelo por RUC o razón social', r.code USING ERRCODE = '23514';
      ELSE
        RAISE EXCEPTION 'La OT madre de % no tiene cliente: asígnelo primero en Contratos y OTs', r.code USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND OLD.client_id IS NOT NULL AND r.client_id IS DISTINCT FROM OLD.client_id
        AND r.parent_contract_id IS NULL AND auth.uid() IS NOT NULL AND NOT public.is_tms_admin() THEN
    RAISE EXCEPTION 'Solo el Administrador puede cambiar el cliente ya asignado a la OT %', r.code USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.enforce_contract_client() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. Cliente en las solicitudes
-- ------------------------------------------------------------
ALTER TABLE public.transport_requests ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES public.clients(id);
CREATE INDEX IF NOT EXISTS transport_requests_client_idx ON public.transport_requests (client_id);
COMMENT ON COLUMN public.transport_requests.client_id IS 'Cliente de la entrega: el de la OT si tiene OT; sin OT se elige en la solicitud';

UPDATE public.transport_requests t SET client_id = public.contract_root_client(t.contract_id)
 WHERE t.contract_id IS NOT NULL AND public.contract_root_client(t.contract_id) IS NOT NULL
   AND t.client_id IS DISTINCT FROM public.contract_root_client(t.contract_id);

CREATE OR REPLACE FUNCTION public.transport_requests_inherit_client() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v uuid;
BEGIN
  IF NEW.contract_id IS NOT NULL THEN
    v := public.contract_root_client(NEW.contract_id);
    IF v IS NOT NULL THEN NEW.client_id := v; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.transport_requests_inherit_client() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS transport_requests_inherit_client ON public.transport_requests;
CREATE TRIGGER transport_requests_inherit_client BEFORE INSERT OR UPDATE OF contract_id, client_id ON public.transport_requests
  FOR EACH ROW EXECUTE FUNCTION public.transport_requests_inherit_client();

-- ¿La solicitud se identifica por proveedor (recojo/traslado) o por cliente (entrega, recojo por el cliente)?
CREATE OR REPLACE FUNCTION public.request_party_missing(p_request uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record;
BEGIN
  SELECT t.request_number, t.request_type, t.contract_id, t.client_id, to_jsonb(t)->>'supplier_id' AS supplier_id,
         COALESCE(to_jsonb(t)->>'attention_mode', '') AS mode
    INTO r FROM public.transport_requests t WHERE t.id = p_request;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF r.request_type IN ('RECOJO', 'TRASLADO') AND r.mode <> 'RECOJO_CLIENTE' THEN
    RETURN CASE WHEN r.supplier_id IS NULL THEN 'PROVEEDOR' END;
  END IF;
  RETURN CASE WHEN r.client_id IS NULL THEN 'CLIENTE' END;
END $$;
REVOKE ALL ON FUNCTION public.request_party_missing(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_party_missing(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enforce_request_client() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record;
BEGIN
  SELECT t.request_number, t.contract_id, t.client_id INTO r FROM public.transport_requests t WHERE t.id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF public.request_party_missing(NEW.id) = 'CLIENTE' THEN
    IF r.contract_id IS NOT NULL THEN
      RAISE EXCEPTION 'La OT de la solicitud % no tiene cliente: asígnelo en Contratos y OTs', COALESCE(r.request_number, '')
        USING ERRCODE = '23514';
    END IF;
    RAISE EXCEPTION 'Seleccione el cliente de la entrega %', COALESCE(r.request_number, '') USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.client_id IS NOT NULL AND r.client_id IS DISTINCT FROM OLD.client_id
     AND r.contract_id IS NULL AND auth.uid() IS NOT NULL AND NOT public.is_tms_admin() THEN
    RAISE EXCEPTION 'Solo el Administrador puede cambiar el cliente ya asignado a la solicitud %', COALESCE(r.request_number, '')
      USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.enforce_request_client() FROM PUBLIC, anon, authenticated;

-- Al programar: ninguna solicitud entra a una ruta sin su cliente o proveedor
CREATE OR REPLACE FUNCTION public.enforce_dispatch_request_party() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_missing text; v_number text;
BEGIN
  v_missing := public.request_party_missing(NEW.transport_request_id);
  IF v_missing IS NOT NULL THEN
    SELECT request_number INTO v_number FROM public.transport_requests WHERE id = NEW.transport_request_id;
    RAISE EXCEPTION 'La solicitud % no tiene %: vincúlelo antes de programarla', COALESCE(v_number, ''),
      CASE v_missing WHEN 'PROVEEDOR' THEN 'proveedor' ELSE 'cliente' END USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.enforce_dispatch_request_party() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 4. Disparadores (después de regularizar)
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS contracts_propagate_client ON public.contracts;
CREATE TRIGGER contracts_propagate_client AFTER UPDATE OF client_id ON public.contracts
  FOR EACH ROW WHEN (OLD.client_id IS DISTINCT FROM NEW.client_id) EXECUTE FUNCTION public.contracts_propagate_client();
DROP TRIGGER IF EXISTS contracts_client_insert ON public.contracts;
CREATE CONSTRAINT TRIGGER contracts_client_insert AFTER INSERT ON public.contracts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_contract_client();
DROP TRIGGER IF EXISTS contracts_client_update ON public.contracts;
CREATE CONSTRAINT TRIGGER contracts_client_update AFTER UPDATE ON public.contracts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.client_id IS DISTINCT FROM NEW.client_id)
  EXECUTE FUNCTION public.enforce_contract_client();

DROP TRIGGER IF EXISTS transport_requests_client_insert ON public.transport_requests;
CREATE CONSTRAINT TRIGGER transport_requests_client_insert AFTER INSERT ON public.transport_requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_request_client();
DROP TRIGGER IF EXISTS transport_requests_client_update ON public.transport_requests;
CREATE CONSTRAINT TRIGGER transport_requests_client_update AFTER UPDATE ON public.transport_requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.client_id IS DISTINCT FROM NEW.client_id OR OLD.contract_id IS DISTINCT FROM NEW.contract_id
    OR OLD.request_type IS DISTINCT FROM NEW.request_type
    OR to_jsonb(OLD)->>'attention_mode' IS DISTINCT FROM to_jsonb(NEW)->>'attention_mode')
  EXECUTE FUNCTION public.enforce_request_client();

DROP TRIGGER IF EXISTS dispatch_requests_party ON public.dispatch_requests;
CREATE CONSTRAINT TRIGGER dispatch_requests_party AFTER INSERT ON public.dispatch_requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_dispatch_request_party();

-- ------------------------------------------------------------
-- 5. Completar o corregir el cliente / proveedor
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_contract_client(p_contract_id uuid, p_client_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c record; v_root uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sin sesión'; END IF;
  IF NOT (public.is_tms_admin() OR public.has_tms_permission('ot')) THEN
    RAISE EXCEPTION 'Sin permiso: requiere Contratos y OTs con escritura';
  END IF;
  v_root := COALESCE(public.contract_root_id(p_contract_id), p_contract_id);
  SELECT x.id, x.code::text AS code, x.client_id, x.site_id INTO c FROM public.contracts x WHERE x.id = v_root FOR UPDATE;
  IF c.id IS NULL OR NOT public.can_access_site(c.site_id) THEN RAISE EXCEPTION 'OT no disponible'; END IF;
  IF public.is_contract_administrator() AND NOT public.has_assigned_contract(c.id, true) THEN
    RAISE EXCEPTION 'La OT % no está asignada a usted', c.code;
  END IF;
  IF p_client_id IS NULL OR NOT public.client_is_active(p_client_id) THEN
    RAISE EXCEPTION 'Cliente inexistente o inactivo';
  END IF;
  IF c.client_id IS NOT NULL AND c.client_id <> p_client_id AND NOT public.is_tms_admin() THEN
    RAISE EXCEPTION 'La OT % ya tiene cliente; solo el Administrador puede cambiarlo', c.code;
  END IF;
  UPDATE public.contracts SET client_id = p_client_id WHERE id = c.id AND client_id IS DISTINCT FROM p_client_id;
  RETURN jsonb_build_object('success', true, 'contract_id', c.id, 'code', c.code, 'client_id', p_client_id,
    'changed', c.client_id IS DISTINCT FROM p_client_id);
END $$;
REVOKE ALL ON FUNCTION public.set_contract_client(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_contract_client(uuid, uuid) TO authenticated, service_role;

-- Vincula el cliente (entrega sin OT / recojo por el cliente) o el proveedor (recojo / traslado) de una solicitud
CREATE OR REPLACE FUNCTION public.set_request_party(p_request_id uuid, p_client_id uuid DEFAULT NULL, p_supplier_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t record; v_needs_supplier boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sin sesión'; END IF;
  IF NOT (public.is_tms_admin() OR public.has_tms_permission('solicitudes') OR public.has_tms_permission('despacho')) THEN
    RAISE EXCEPTION 'Sin permiso: requiere Solicitudes o Despacho con escritura';
  END IF;
  SELECT x.id, x.request_number, x.request_type, x.contract_id, x.client_id, x.site_id,
         public.notif_uuid(to_jsonb(x)->>'supplier_id') AS supplier_id, COALESCE(to_jsonb(x)->>'attention_mode', '') AS mode
    INTO t FROM public.transport_requests x WHERE x.id = p_request_id FOR UPDATE;
  IF t.id IS NULL OR NOT public.can_access_site(t.site_id) THEN RAISE EXCEPTION 'Solicitud no disponible'; END IF;
  v_needs_supplier := t.request_type IN ('RECOJO', 'TRASLADO') AND t.mode <> 'RECOJO_CLIENTE';
  IF v_needs_supplier THEN
    IF p_supplier_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.suppliers WHERE id = p_supplier_id AND is_active) THEN
      RAISE EXCEPTION 'Proveedor inexistente o inactivo';
    END IF;
    IF t.supplier_id IS NOT NULL AND t.supplier_id <> p_supplier_id AND NOT public.is_tms_admin() THEN
      RAISE EXCEPTION 'La solicitud % ya tiene proveedor; solo el Administrador puede cambiarlo', t.request_number;
    END IF;
    UPDATE public.transport_requests SET supplier_id = p_supplier_id WHERE id = t.id;
  ELSE
    IF t.contract_id IS NOT NULL THEN
      RAISE EXCEPTION 'La solicitud % toma el cliente de su OT: asígnelo en Contratos y OTs', t.request_number;
    END IF;
    IF p_client_id IS NULL OR NOT public.client_is_active(p_client_id) THEN
      RAISE EXCEPTION 'Cliente inexistente o inactivo';
    END IF;
    IF t.client_id IS NOT NULL AND t.client_id <> p_client_id AND NOT public.is_tms_admin() THEN
      RAISE EXCEPTION 'La solicitud % ya tiene cliente; solo el Administrador puede cambiarlo', t.request_number;
    END IF;
    UPDATE public.transport_requests SET client_id = p_client_id WHERE id = t.id;
  END IF;
  RETURN jsonb_build_object('success', true, 'request_id', t.id, 'party', CASE WHEN v_needs_supplier THEN 'PROVEEDOR' ELSE 'CLIENTE' END);
END $$;
REVOKE ALL ON FUNCTION public.set_request_party(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_request_party(uuid, uuid, uuid) TO authenticated, service_role;

-- El guardado de la solicitud aplica también el cliente elegido (entregas sin OT)
CREATE OR REPLACE FUNCTION public.save_transport_request_full(p_request_id uuid, p_payload jsonb, p_components jsonb, p_unloading jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_result jsonb; v_client uuid;
BEGIN
  v_result := public.save_transport_request_attention(p_request_id, p_payload, p_components, p_unloading);
  PERFORM public.apply_request_supplier((v_result->>'id')::uuid, p_payload);
  v_client := NULLIF(p_payload->>'client_id', '')::uuid;
  IF v_client IS NOT NULL THEN
    IF NOT public.client_is_active(v_client) THEN
      RAISE EXCEPTION 'Cliente inexistente o inactivo';
    END IF;
    -- Con OT el cliente lo fija la OT (transport_requests_inherit_client); sin OT se guarda el elegido
    UPDATE public.transport_requests SET client_id = v_client
     WHERE id = (v_result->>'id')::uuid AND contract_id IS NULL AND client_id IS DISTINCT FROM v_client;
  END IF;
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.save_transport_request_full(uuid, jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_transport_request_full(uuid, jsonb, jsonb, jsonb) TO authenticated, service_role;

-- Pendientes de regularizar (se ven en el registro del despliegue)
DO $report$
DECLARE v_ot int; v_req int; v_sup int;
BEGIN
  SELECT count(*) INTO v_ot FROM public.contracts WHERE parent_contract_id IS NULL AND client_id IS NULL
    AND upper(COALESCE(status::text, '')) NOT IN ('CANCELADO', 'ANULADO', 'CERRADO');
  SELECT count(*) FILTER (WHERE public.request_party_missing(id) = 'CLIENTE'),
         count(*) FILTER (WHERE public.request_party_missing(id) = 'PROVEEDOR')
    INTO v_req, v_sup FROM public.transport_requests WHERE upper(COALESCE(status, '')) NOT IN ('CANCELADA', 'RECHAZADA', 'CERRADA', 'LIQUIDADA');
  RAISE NOTICE 'Pendientes: OT sin cliente %, solicitudes sin cliente %, solicitudes sin proveedor %', v_ot, v_req, v_sup;
END $report$;

NOTIFY pgrst, 'reload schema';
COMMIT;
