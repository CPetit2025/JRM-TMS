-- ============================================================
-- Flota: SOAT y revisión técnica editables desde la ficha del vehículo + código interno automático
-- ============================================================
-- * La ficha del vehículo vuelve a editar el vencimiento de SOAT y revisión técnica. Los documentos siguen siendo la
--   fuente única (Cumplimiento → Documentos): una fecha posterior registra la renovación (el anterior queda en el
--   historial) y una anterior corrige el documento vigente. El espejo del vehículo lo actualiza el trigger existente.
-- * Código interno: si se deja vacío al registrar una unidad, se asigna por tipo (CAM-001, TRC-001…). Las unidades
--   que hoy no tienen código lo reciben con la misma regla.
BEGIN;

-- ------------------------------------------------------------
-- 1. Vencimientos de SOAT y revisión técnica desde la ficha
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_vehicle_compliance_dates(p_vehicle_id uuid, p_soat date, p_rt date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v record; t text; v_new date; v_doc_id uuid; v_doc_exp date; v_changes integer := 0;
BEGIN
  IF NOT (public.has_tms_permission('flota') OR public.has_tms_permission('mantenimiento-flota')
          OR public.has_cmms_permission('vencimientos')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para editar los documentos de la unidad');
  END IF;
  SELECT id, site_id INTO v FROM public.vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'La unidad no existe'); END IF;
  IF NOT public.can_access_site(v.site_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'La unidad pertenece a una sede fuera de su alcance');
  END IF;

  FOREACH t IN ARRAY ARRAY['SOAT', 'REVISION_TECNICA'] LOOP
    v_new := CASE t WHEN 'SOAT' THEN p_soat ELSE p_rt END;
    CONTINUE WHEN v_new IS NULL;
    v_doc_id := NULL; v_doc_exp := NULL;
    SELECT id, expiration_date INTO v_doc_id, v_doc_exp FROM public.vehicle_documents
    WHERE vehicle_id = v.id AND document_type = t AND is_active ORDER BY expiration_date DESC LIMIT 1;
    CONTINUE WHEN v_doc_exp = v_new;
    IF v_doc_id IS NULL OR v_new > v_doc_exp THEN
      -- Renovación: el documento anterior queda en el historial
      INSERT INTO public.vehicle_documents (vehicle_id, document_type, expiration_date, notes, created_by)
      VALUES (v.id, t, v_new, 'Actualizado desde la ficha del vehículo', auth.uid());
    ELSE
      -- Corrección de una fecha mal registrada
      UPDATE public.vehicle_documents SET expiration_date = v_new,
        notes = concat_ws(' · ', NULLIF(notes, ''), 'Fecha corregida desde la ficha del vehículo')
      WHERE id = v_doc_id;
    END IF;
    v_changes := v_changes + 1;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'cambios', v_changes,
    'soat_expiration', (SELECT soat_expiration FROM public.vehicles WHERE id = v.id),
    'technical_review_expiration', (SELECT technical_review_expiration FROM public.vehicles WHERE id = v.id));
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;

REVOKE ALL ON FUNCTION public.update_vehicle_compliance_dates(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_vehicle_compliance_dates(uuid, date, date) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 2. Código interno automático por tipo de unidad
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.vehicle_code_prefix(p_type text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE upper(btrim(COALESCE(p_type, '')))
    WHEN 'CAMION' THEN 'CAM' WHEN 'CAMIONETA' THEN 'CMT' WHEN 'FURGON' THEN 'FUR' WHEN 'TRAILER' THEN 'TRL'
    WHEN 'TRACTO' THEN 'TRC' WHEN 'SEMIRREMOLQUE' THEN 'SMR' WHEN 'MONTACARGAS' THEN 'MTC' WHEN 'APILADOR' THEN 'API'
    WHEN 'TRANSPALETA' THEN 'TPL' ELSE 'EQP' END;
$$;

CREATE OR REPLACE FUNCTION public.next_vehicle_internal_code(p_type text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.pfx || '-' || lpad((COALESCE(max(substring(v.internal_code FROM '^[A-Z]+-([0-9]+)$')::int), 0) + 1)::text, 3, '0')
  FROM (SELECT public.vehicle_code_prefix(p_type) AS pfx) p
  LEFT JOIN public.vehicles v ON upper(v.internal_code) ~ ('^' || p.pfx || '-[0-9]+$')
  GROUP BY p.pfx;
$$;

CREATE OR REPLACE FUNCTION public.assign_vehicle_internal_code()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NULLIF(btrim(COALESCE(NEW.internal_code, '')), '') IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('vehicle_internal_code'));
    NEW.internal_code := public.next_vehicle_internal_code(NEW.type::text);
  ELSE
    NEW.internal_code := upper(btrim(NEW.internal_code));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_assign_vehicle_internal_code ON public.vehicles;
CREATE TRIGGER trg_assign_vehicle_internal_code BEFORE INSERT ON public.vehicles
FOR EACH ROW EXECUTE FUNCTION public.assign_vehicle_internal_code();

REVOKE ALL ON FUNCTION public.next_vehicle_internal_code(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.next_vehicle_internal_code(text) TO authenticated, service_role;

-- Unidades sin código: se asigna con la misma regla (por tipo, en orden de placa)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id, type::text AS type FROM public.vehicles
           WHERE NULLIF(btrim(COALESCE(internal_code, '')), '') IS NULL ORDER BY plate LOOP
    UPDATE public.vehicles SET internal_code = public.next_vehicle_internal_code(r.type) WHERE id = r.id;
  END LOOP;
END $$;

COMMIT;
