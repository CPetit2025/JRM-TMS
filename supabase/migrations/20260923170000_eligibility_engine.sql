-- FASE 2: MOTOR DE ELEGIBILIDAD
-- 20260923170000_eligibility_engine.sql

BEGIN;

-- ==========================================
-- SECCIÓN 1: Tablas de documentos
-- ==========================================

CREATE TABLE IF NOT EXISTS public.vehicle_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_plate TEXT NOT NULL REFERENCES public.vehicles(plate) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('SOAT','REVISION_TECNICA','TARJETA_PROPIEDAD','SEGURO_VEHICULAR')),
  doc_number TEXT,
  issue_date DATE,
  expiry_date DATE NOT NULL,
  file_url TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_veh_docs_plate_type ON public.vehicle_documents(vehicle_plate, doc_type) WHERE is_active=true;
CREATE INDEX IF NOT EXISTS idx_veh_docs_expiry ON public.vehicle_documents(expiry_date) WHERE is_active=true;

ALTER TABLE public.vehicle_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY veh_docs_read ON public.vehicle_documents FOR SELECT TO authenticated USING (true);
CREATE POLICY veh_docs_write ON public.vehicle_documents FOR ALL TO authenticated USING (public.has_tms_permission('mantenimiento'));

CREATE TABLE IF NOT EXISTS public.driver_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('LICENCIA','EXAMEN_MEDICO','SEGURO_VIDA','BREVETE')),
  doc_number TEXT,
  category TEXT,
  issue_date DATE,
  expiry_date DATE NOT NULL,
  file_url TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_drv_docs_driver_type ON public.driver_documents(driver_id, doc_type) WHERE is_active=true;
CREATE INDEX IF NOT EXISTS idx_drv_docs_expiry ON public.driver_documents(expiry_date) WHERE is_active=true;

ALTER TABLE public.driver_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY drv_docs_read ON public.driver_documents FOR SELECT TO authenticated USING (true);
CREATE POLICY drv_docs_write ON public.driver_documents FOR ALL TO authenticated USING (public.has_tms_permission('mantenimiento'));

-- ==========================================
-- SECCIÓN 2: RPC check_vehicle_eligibility
-- ==========================================
CREATE OR REPLACE FUNCTION public.check_vehicle_eligibility(
  p_vehicle_plate TEXT,
  p_required_capacity NUMERIC DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public
AS $$
DECLARE
  v_vehicle RECORD;
  v_soat_expiry DATE;
  v_rt_expiry DATE;
  v_open_faults INT := 0;
  v_active_dispatch INT := 0;
  v_blocking jsonb := '[]'::jsonb;
  v_observations jsonb := '[]'::jsonb;
  v_checks jsonb;
BEGIN
  -- Get vehicle
  SELECT * INTO v_vehicle FROM public.vehicles WHERE plate = p_vehicle_plate;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('eligible', false, 'status', 'BLOQUEADO',
      'blocking_reasons', jsonb_build_array('Vehículo no encontrado'));
  END IF;

  -- Check 1: vehicle status
  IF v_vehicle.status NOT IN ('DISPONIBLE') THEN
    v_blocking := v_blocking || jsonb_build_array('Estado del vehículo: ' || v_vehicle.status);
  END IF;

  -- Check 2: SOAT
  SELECT expiry_date INTO v_soat_expiry FROM public.vehicle_documents
  WHERE vehicle_plate=p_vehicle_plate AND doc_type='SOAT' AND is_active=true
  ORDER BY expiry_date DESC LIMIT 1;
  -- Fallback: si vehicle tiene campo soat_expiration
  IF v_soat_expiry IS NULL THEN
    BEGIN
      v_soat_expiry := v_vehicle.soat_expiration;
    EXCEPTION WHEN undefined_column THEN NULL;
    END;
  END IF;

  IF v_soat_expiry IS NULL OR v_soat_expiry < CURRENT_DATE THEN
    v_blocking := v_blocking || jsonb_build_array('SOAT vencido o no registrado');
  ELSIF v_soat_expiry < CURRENT_DATE + 7 THEN
    v_observations := v_observations || jsonb_build_array('SOAT vence en ' || (v_soat_expiry - CURRENT_DATE) || ' días');
  END IF;

  -- Check 3: Revisión Técnica
  SELECT expiry_date INTO v_rt_expiry FROM public.vehicle_documents
  WHERE vehicle_plate=p_vehicle_plate AND doc_type='REVISION_TECNICA' AND is_active=true
  ORDER BY expiry_date DESC LIMIT 1;
  -- Fallback: si vehicle tiene campo technical_review_expiration
  IF v_rt_expiry IS NULL THEN
    BEGIN
      v_rt_expiry := v_vehicle.technical_review_expiration;
    EXCEPTION WHEN undefined_column THEN NULL;
    END;
  END IF;

  IF v_rt_expiry IS NULL OR v_rt_expiry < CURRENT_DATE THEN
    v_blocking := v_blocking || jsonb_build_array('Revisión Técnica vencida o no registrada');
  ELSIF v_rt_expiry < CURRENT_DATE + 7 THEN
    v_observations := v_observations || jsonb_build_array('Revisión Técnica vence en ' || (v_rt_expiry - CURRENT_DATE) || ' días');
  END IF;

  -- Check 4: Open critical faults
  BEGIN
    SELECT count(*) INTO v_open_faults FROM public.maintenance_requests
    WHERE vehicle_plate=p_vehicle_plate AND severity='CRITICA' AND status='PENDIENTE';
    IF v_open_faults > 0 THEN
      v_blocking := v_blocking || jsonb_build_array('Falla crítica pendiente de resolución');
    END IF;
  EXCEPTION WHEN undefined_table THEN
    NULL; -- table not yet available in current environment
  END;

  -- Check 5: Active dispatch
  BEGIN
    SELECT count(*) INTO v_active_dispatch FROM public.dispatches
    WHERE vehicle_plate=p_vehicle_plate
      AND status NOT IN ('LIQUIDADO','CERRADO','CANCELADO','RETORNO_COMPLETADO','FINALIZADO');
    IF v_active_dispatch > 0 THEN
      v_blocking := v_blocking || jsonb_build_array('Vehículo tiene despacho activo');
    END IF;
  EXCEPTION WHEN undefined_column OR undefined_table THEN
    NULL;
  END;

  -- Check 6: Capacity
  IF p_required_capacity IS NOT NULL THEN
    BEGIN
      IF (v_vehicle.weight_capacity IS NOT NULL AND v_vehicle.weight_capacity < p_required_capacity) THEN
        v_blocking := v_blocking || jsonb_build_array('Capacidad insuficiente');
      END IF;
    EXCEPTION WHEN undefined_column THEN
      NULL;
    END;
  END IF;

  v_checks := jsonb_build_object(
    'status_ok', v_vehicle.status = 'DISPONIBLE',
    'soat_ok', v_soat_expiry IS NOT NULL AND v_soat_expiry >= CURRENT_DATE,
    'revision_tecnica_ok', v_rt_expiry IS NOT NULL AND v_rt_expiry >= CURRENT_DATE,
    'no_open_faults', v_open_faults = 0,
    'no_active_dispatch', v_active_dispatch = 0
  );

  RETURN jsonb_build_object(
    'eligible', jsonb_array_length(v_blocking) = 0,
    'status', CASE
      WHEN jsonb_array_length(v_blocking) > 0 THEN 'BLOQUEADO'
      WHEN jsonb_array_length(v_observations) > 0 THEN 'APTO_CON_OBSERVACION'
      ELSE 'APTO' END,
    'blocking_reasons', v_blocking,
    'observation_reasons', v_observations,
    'vehicle_status', v_vehicle.status,
    'checks', v_checks
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.check_vehicle_eligibility(text, numeric) TO authenticated, service_role;

-- ==========================================
-- SECCIÓN 3: RPC check_driver_eligibility
-- ==========================================
CREATE OR REPLACE FUNCTION public.check_driver_eligibility(
  p_driver_id UUID
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public
AS $$
DECLARE
  v_driver RECORD;
  v_lic_expiry DATE;
  v_med_expiry DATE;
  v_active_dispatch INT := 0;
  v_blocking jsonb := '[]'::jsonb;
  v_observations jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_driver FROM public.drivers WHERE id = p_driver_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('eligible', false, 'status', 'BLOQUEADO',
      'blocking_reasons', jsonb_build_array('Conductor no encontrado'));
  END IF;

  -- Status check
  BEGIN
    IF v_driver.status IS DISTINCT FROM 'ACTIVE' AND v_driver.status IS NOT NULL THEN
      v_blocking := v_blocking || jsonb_build_array('Conductor inactivo: ' || COALESCE(v_driver.status, 'desconocido'));
    END IF;
  EXCEPTION WHEN undefined_column THEN NULL;
  END;

  -- Licencia
  SELECT expiry_date INTO v_lic_expiry FROM public.driver_documents
  WHERE driver_id=p_driver_id AND doc_type='LICENCIA' AND is_active=true
  ORDER BY expiry_date DESC LIMIT 1;
  
  -- Fallback: si driver tiene campo license_expiration directo
  IF v_lic_expiry IS NULL THEN
    BEGIN
      v_lic_expiry := v_driver.license_expiration;
    EXCEPTION WHEN undefined_column THEN NULL;
    END;
  END IF;

  IF v_lic_expiry IS NULL OR v_lic_expiry < CURRENT_DATE THEN
    v_blocking := v_blocking || jsonb_build_array('Licencia vencida o no registrada');
  ELSIF v_lic_expiry < CURRENT_DATE + 30 THEN
    v_observations := v_observations || jsonb_build_array('Licencia vence en ' || (v_lic_expiry - CURRENT_DATE) || ' días');
  END IF;

  -- Examen médico
  SELECT expiry_date INTO v_med_expiry FROM public.driver_documents
  WHERE driver_id=p_driver_id AND doc_type='EXAMEN_MEDICO' AND is_active=true
  ORDER BY expiry_date DESC LIMIT 1;
  
  IF v_med_expiry IS NULL OR v_med_expiry < CURRENT_DATE THEN
    v_observations := v_observations || jsonb_build_array('Examen médico vencido o no registrado');
  ELSIF v_med_expiry < CURRENT_DATE + 30 THEN
    v_observations := v_observations || jsonb_build_array('Examen médico vence en ' || (v_med_expiry - CURRENT_DATE) || ' días');
  END IF;

  -- Despacho activo
  BEGIN
    SELECT count(*) INTO v_active_dispatch FROM public.dispatches
    WHERE driver_id=p_driver_id
      AND status NOT IN ('LIQUIDADO','CERRADO','CANCELADO','RETORNO_COMPLETADO','FINALIZADO');
    IF v_active_dispatch > 0 THEN
      v_blocking := v_blocking || jsonb_build_array('Conductor tiene despacho activo');
    END IF;
  EXCEPTION WHEN undefined_column OR undefined_table THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'eligible', jsonb_array_length(v_blocking) = 0,
    'status', CASE
      WHEN jsonb_array_length(v_blocking) > 0 THEN 'BLOQUEADO'
      WHEN jsonb_array_length(v_observations) > 0 THEN 'APTO_CON_OBSERVACION'
      ELSE 'APTO' END,
    'blocking_reasons', v_blocking,
    'observation_reasons', v_observations,
    'checks', jsonb_build_object(
      'driver_active', true,
      'licencia_ok', v_lic_expiry IS NOT NULL AND v_lic_expiry >= CURRENT_DATE,
      'examen_medico_ok', v_med_expiry IS NOT NULL AND v_med_expiry >= CURRENT_DATE,
      'no_active_dispatch', v_active_dispatch = 0
    )
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.check_driver_eligibility(uuid) TO authenticated, service_role;

-- ==========================================
-- SECCIÓN 4: RPC check_dispatch_eligibility
-- ==========================================
CREATE OR REPLACE FUNCTION public.check_dispatch_eligibility(
  p_vehicle_plate TEXT,
  p_driver_id UUID,
  p_required_capacity NUMERIC DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public
AS $$
DECLARE
  v_vehicle_result jsonb;
  v_driver_result jsonb;
  v_all_blocking jsonb := '[]'::jsonb;
  v_all_obs jsonb := '[]'::jsonb;
  v_final_status TEXT;
BEGIN
  v_vehicle_result := check_vehicle_eligibility(p_vehicle_plate, p_required_capacity);
  v_driver_result := check_driver_eligibility(p_driver_id);

  v_all_blocking := (v_vehicle_result->'blocking_reasons') || (v_driver_result->'blocking_reasons');
  v_all_obs := (v_vehicle_result->'observation_reasons') || (v_driver_result->'observation_reasons');

  IF jsonb_array_length(v_all_blocking) > 0 THEN v_final_status := 'BLOQUEADO';
  ELSIF jsonb_array_length(v_all_obs) > 0 THEN v_final_status := 'APTO_CON_OBSERVACION';
  ELSE v_final_status := 'APTO';
  END IF;

  RETURN jsonb_build_object(
    'eligible', v_final_status != 'BLOQUEADO',
    'status', v_final_status,
    'vehicle', v_vehicle_result,
    'driver', v_driver_result,
    'blocking_reasons', v_all_blocking,
    'observation_reasons', v_all_obs
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.check_dispatch_eligibility(text, uuid, numeric) TO authenticated, service_role;

COMMIT;
