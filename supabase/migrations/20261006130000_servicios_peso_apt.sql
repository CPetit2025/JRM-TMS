-- Servicios de contrato: peso (TON) según la SALIDA cargada en «Control y estadía — Almacén de Producto Terminado».
--   Cada servicio suma el peso (apt_movements.peso_kg) de sus guías de remisión: las escritas en el servicio
--   (referral_guide, separadas por coma) y las del despacho vinculado (dispatch_documents GUIA_REMISION vigentes).
--   Misma regla de guía que apt_guia_detalle: T001-00006696 = T001-6696; solo número = cualquier serie.
--   El valor se guarda en una tabla aparte, contract_service_peso_apt (no se actualizan las filas de contract_services ni
--   la descripción/KG escrita a mano): kg, guías encontradas, guías no encontradas en APT y fecha del cálculo.
--   Se recalcula al registrar o cambiar la guía, al aplicar una carga de APT, cada día y con el botón de la pantalla.
-- Lectura defensiva: referral_guide y dispatch_id se leen con to_jsonb (el historial de producción no es reproducible).
BEGIN;

CREATE TABLE IF NOT EXISTS public.contract_service_peso_apt (
  service_id uuid PRIMARY KEY REFERENCES public.contract_services(id) ON DELETE CASCADE,
  guias text NOT NULL,
  kg numeric,
  encontradas int NOT NULL DEFAULT 0,
  faltan text,
  calculado_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.contract_service_peso_apt ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contract_service_peso_apt_read ON public.contract_service_peso_apt;
-- Visible si el servicio es visible (la subconsulta respeta las políticas de contract_services)
CREATE POLICY contract_service_peso_apt_read ON public.contract_service_peso_apt FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.contract_services cs WHERE cs.id = service_id));
GRANT SELECT ON public.contract_service_peso_apt TO authenticated;

CREATE OR REPLACE FUNCTION public.servicio_peso_apt_guardar(p_id uuid, p_j jsonb)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_g text := public.servicio_guias_texto(p_j); r record;
BEGIN
  IF v_g IS NULL THEN DELETE FROM public.contract_service_peso_apt WHERE service_id = p_id; RETURN false; END IF;
  SELECT * INTO r FROM public.apt_guias_peso(v_g);
  INSERT INTO public.contract_service_peso_apt (service_id, guias, kg, encontradas, faltan, calculado_at)
  VALUES (p_id, v_g, r.kg, COALESCE(r.encontradas, 0), r.faltan, now())
  ON CONFLICT (service_id) DO UPDATE SET guias = EXCLUDED.guias, kg = EXCLUDED.kg, encontradas = EXCLUDED.encontradas,
    faltan = EXCLUDED.faltan, calculado_at = now();
  RETURN true;
END $$;

-- Guías de un servicio (texto libre + guías del despacho vinculado)
CREATE OR REPLACE FUNCTION public.servicio_guias_texto(j jsonb)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v text := COALESCE(j ->> 'referral_guide', ''); d uuid; x text;
BEGIN
  d := public.kpi_uuid(j ->> 'dispatch_id');
  IF d IS NOT NULL AND to_regclass('public.dispatch_documents') IS NOT NULL THEN
    BEGIN
      EXECUTE $q$SELECT string_agg(document_number, ',') FROM public.dispatch_documents
                 WHERE dispatch_id = $1 AND voided_at IS NULL AND doc_type = 'GUIA_REMISION' AND NULLIF(btrim(document_number), '') IS NOT NULL$q$
        INTO x USING d;
      IF x IS NOT NULL THEN v := v || ',' || x; END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
  RETURN NULLIF(btrim(v, ', '), '');
END $$;
REVOKE ALL ON FUNCTION public.servicio_guias_texto(jsonb) FROM PUBLIC, anon, authenticated;

CREATE INDEX IF NOT EXISTS apt_movements_guia_num_idx ON public.apt_movements (split_part(public.apt_guia_key(documento), '-', 2))
  WHERE active AND valid AND kind = 'SALIDA';

-- Peso de una lista de guías en la SALIDA de APT
CREATE OR REPLACE FUNCTION public.apt_guias_peso(p_guias text)
RETURNS TABLE (kg numeric, encontradas int, faltan text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH k AS (
    SELECT DISTINCT public.apt_guia_key(g) AS clave
    FROM regexp_split_to_table(COALESCE(p_guias, ''), '[,;/\s]+') g WHERE btrim(g) <> ''),
  m AS (   -- dos búsquedas por índice: guía completa, o solo número (cualquier serie)
    SELECT k.clave, mv.documento FROM k JOIN public.apt_movements mv
      ON mv.active AND mv.valid AND mv.kind = 'SALIDA' AND public.apt_guia_key(mv.documento) = k.clave
    UNION
    SELECT k.clave, mv.documento FROM k JOIN public.apt_movements mv
      ON mv.active AND mv.valid AND mv.kind = 'SALIDA' AND split_part(public.apt_guia_key(mv.documento), '-', 2) = k.clave
    WHERE k.clave !~ '-'),
  d AS (SELECT DISTINCT documento FROM m)
  SELECT (SELECT sum(mv.peso_kg) FROM public.apt_movements mv WHERE mv.active AND mv.valid AND mv.kind = 'SALIDA' AND mv.documento IN (SELECT documento FROM d)),
         (SELECT count(DISTINCT clave) FROM m)::int,
         (SELECT string_agg(k.clave, ', ' ORDER BY k.clave) FROM k WHERE NOT EXISTS (SELECT 1 FROM m WHERE m.clave = k.clave));
$$;
REVOKE ALL ON FUNCTION public.apt_guias_peso(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.servicio_peso_apt_guardar(uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- Al registrar o cambiar las guías de un servicio (AFTER: no modifica la fila)
CREATE OR REPLACE FUNCTION public.contract_services_trg_peso_apt()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_new jsonb := to_jsonb(NEW); v_old jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);
    IF (v_new ->> 'referral_guide') IS NOT DISTINCT FROM (v_old ->> 'referral_guide')
       AND (v_new ->> 'dispatch_id') IS NOT DISTINCT FROM (v_old ->> 'dispatch_id') THEN
      RETURN NULL;
    END IF;
  END IF;
  BEGIN PERFORM public.servicio_peso_apt_guardar(NEW.id, v_new);
  EXCEPTION WHEN OTHERS THEN NULL;   -- el peso nunca impide registrar el servicio
  END;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_contract_services_peso_apt ON public.contract_services;
CREATE TRIGGER trg_contract_services_peso_apt AFTER INSERT OR UPDATE ON public.contract_services
  FOR EACH ROW EXECUTE FUNCTION public.contract_services_trg_peso_apt();

-- Recalcular todos (o uno)
CREATE OR REPLACE FUNCTION public.servicios_sync_peso_apt(p_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s record; n int := 0;
BEGIN
  FOR s IN SELECT cs.id, to_jsonb(cs) AS j FROM public.contract_services cs WHERE p_id IS NULL OR cs.id = p_id LOOP
    IF public.servicio_peso_apt_guardar(s.id, s.j) THEN n := n + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('success', true, 'con_guia', n,
    'con_peso', (SELECT count(*) FROM public.contract_service_peso_apt WHERE kg IS NOT NULL AND (p_id IS NULL OR service_id = p_id)),
    'con_guias_faltantes', (SELECT count(*) FROM public.contract_service_peso_apt WHERE faltan IS NOT NULL AND (p_id IS NULL OR service_id = p_id)),
    'datos_apt_hasta', (SELECT max(fecha) FROM public.apt_movements WHERE active AND valid AND kind = 'SALIDA'));
END $$;
REVOKE ALL ON FUNCTION public.servicios_sync_peso_apt(uuid) FROM PUBLIC, anon, authenticated;

-- Botón «Actualizar peso desde APT»
CREATE OR REPLACE FUNCTION public.servicios_actualizar_peso_apt()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT (public.is_tms_admin() OR public.has_tms_permission('contratos-servicios') OR public.has_tms_permission('clientes')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso sobre los servicios de contrato');
  END IF;
  RETURN public.servicios_sync_peso_apt(NULL);
EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.servicios_actualizar_peso_apt() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.servicios_actualizar_peso_apt() TO authenticated;

-- Al aplicar una carga de APT (nueva SALIDA), recalcular los servicios
CREATE OR REPLACE FUNCTION public.apt_uploads_trg_peso_servicios()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status = 'APLICADA' AND OLD.status IS DISTINCT FROM 'APLICADA' THEN
    BEGIN PERFORM public.servicios_sync_peso_apt(NULL); EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_apt_uploads_peso_servicios ON public.apt_uploads;
CREATE TRIGGER trg_apt_uploads_peso_servicios AFTER UPDATE OF status ON public.apt_uploads
  FOR EACH ROW EXECUTE FUNCTION public.apt_uploads_trg_peso_servicios();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN PERFORM cron.unschedule('servicios-peso-apt'); EXCEPTION WHEN OTHERS THEN NULL; END;
    PERFORM cron.schedule('servicios-peso-apt', '40 11 * * *', $cron$SELECT public.servicios_sync_peso_apt(NULL)$cron$);   -- 06:40 Lima
  END IF;
END $$;

-- Carga inicial con la data de APT ya cargada
DO $$
BEGIN
  PERFORM public.servicios_sync_peso_apt(NULL);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'servicios_sync_peso_apt: %', SQLERRM;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
