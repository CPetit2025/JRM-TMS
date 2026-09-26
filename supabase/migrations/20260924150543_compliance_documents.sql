BEGIN;

-- 1. Modify vehicle_documents columns
DO $DO$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='vehicle_documents' AND column_name='doc_type') THEN
        ALTER TABLE public.vehicle_documents RENAME COLUMN doc_type TO document_type;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='vehicle_documents' AND column_name='doc_number') THEN
        ALTER TABLE public.vehicle_documents RENAME COLUMN doc_number TO document_number;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='vehicle_documents' AND column_name='expiry_date') THEN
        ALTER TABLE public.vehicle_documents RENAME COLUMN expiry_date TO expiration_date;
    END IF;
END;
$DO$;

-- 2. Drop old constraint and add new
DO $DO$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT conname 
    FROM pg_constraint 
    WHERE conrelid = 'public.vehicle_documents'::regclass 
      AND contype = 'c'
  ) LOOP
    EXECUTE 'ALTER TABLE public.vehicle_documents DROP CONSTRAINT ' || quote_ident(r.conname);
  END LOOP;
END;
$DO$;

ALTER TABLE public.vehicle_documents 
  ADD CONSTRAINT vehicle_documents_document_type_check 
  CHECK (document_type IN ('SOAT', 'REVISION_TECNICA', 'POLIZA_SEGURO', 'TARJETA_PROPIEDAD', 'PERMISO_CIRCULACION'));

ALTER TABLE public.vehicle_documents ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'VIGENTE';

-- 3. Create view vw_document_alerts
CREATE OR REPLACE VIEW public.vw_document_alerts AS
SELECT 
    id,
    vehicle_plate,
    document_type,
    document_number,
    issue_date,
    expiration_date,
    file_url,
    is_active,
    created_at,
    updated_at,
    CASE 
        WHEN expiration_date < CURRENT_DATE THEN 'VENCIDO'
        WHEN expiration_date <= CURRENT_DATE + INTERVAL '15 days' THEN 'POR_VENCER'
        ELSE 'VIGENTE'
    END AS status
FROM public.vehicle_documents;

-- 4. Update check_asset_eligibility function
CREATE OR REPLACE FUNCTION public.check_asset_eligibility(p_plate text)
RETURNS jsonb AS $$$
DECLARE
  v_vehicle RECORD;
  v_soat_expiry DATE;
  v_rt_expiry DATE;
  v_open_mo_count INT := 0;
  v_open_faults INT := 0;
  v_active_dispatch INT := 0;
  v_motives jsonb := '[]'::jsonb;
  v_observations jsonb := '[]'::jsonb;
  v_status text := 'APTO';
BEGIN
  SELECT * INTO v_vehicle FROM public.vehicles WHERE plate = p_plate;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'NO_APTO', 'motives', jsonb_build_array('Vehiculo no encontrado'));
  END IF;

  BEGIN
      SELECT count(*) INTO v_open_mo_count
      FROM public.maintenance_orders
      WHERE vehicle_plate = p_plate AND status NOT IN ('FINALIZADA', 'COMPLETADO', 'CANCELADO');
      IF v_open_mo_count > 0 THEN
          v_motives := v_motives || jsonb_build_array('Tiene ordenes de trabajo (OTs) abiertas');
      END IF;
  EXCEPTION WHEN undefined_table THEN
      BEGIN
          SELECT count(*) INTO v_open_mo_count
          FROM public.maintenance_work_orders
          WHERE vehicle_plate = p_plate AND status NOT IN ('TERMINADA', 'CERRADA', 'CANCELADA');
          IF v_open_mo_count > 0 THEN
              v_motives := v_motives || jsonb_build_array('Tiene ordenes de trabajo (OTs) abiertas');
          END IF;
      EXCEPTION WHEN undefined_table THEN NULL;
      END;
  END;

  BEGIN
      SELECT expiration_date INTO v_soat_expiry FROM public.vehicle_documents
      WHERE vehicle_plate = p_plate AND document_type = 'SOAT' AND is_active = true
      ORDER BY expiration_date DESC LIMIT 1;
      
      IF v_soat_expiry IS NULL THEN
          BEGIN
              v_soat_expiry := v_vehicle.soat_expiration;
          EXCEPTION WHEN undefined_column THEN NULL;
          END;
      END IF;

      IF v_soat_expiry IS NULL OR v_soat_expiry < CURRENT_DATE THEN
          v_motives := v_motives || jsonb_build_array('SOAT vencido o no registrado');
      ELSIF v_soat_expiry < CURRENT_DATE + 7 THEN
          v_observations := v_observations || jsonb_build_array('SOAT proximo a vencer');
      END IF;
  EXCEPTION WHEN undefined_table THEN NULL;
  END;

  BEGIN
      SELECT expiration_date INTO v_rt_expiry FROM public.vehicle_documents
      WHERE vehicle_plate = p_plate AND document_type = 'REVISION_TECNICA' AND is_active = true
      ORDER BY expiration_date DESC LIMIT 1;
      
      IF v_rt_expiry IS NULL THEN
          BEGIN
              v_rt_expiry := v_vehicle.technical_review_expiration;
          EXCEPTION WHEN undefined_column THEN NULL;
          END;
      END IF;

      IF v_rt_expiry IS NULL OR v_rt_expiry < CURRENT_DATE THEN
          v_motives := v_motives || jsonb_build_array('Revision Tecnica vencida o no registrada');
      ELSIF v_rt_expiry < CURRENT_DATE + 7 THEN
          v_observations := v_observations || jsonb_build_array('Revision Tecnica proxima a vencer');
      END IF;
  EXCEPTION WHEN undefined_table THEN NULL;
  END;

  BEGIN
      SELECT count(*) INTO v_open_faults FROM public.maintenance_requests
      WHERE vehicle_plate = p_plate AND severity = 'CRITICA' AND status = 'PENDIENTE';
      IF v_open_faults > 0 THEN
          v_motives := v_motives || jsonb_build_array('Falla critica pendiente de resolucion');
      END IF;
  EXCEPTION WHEN undefined_table THEN NULL;
  END;

  BEGIN
      SELECT count(*) INTO v_active_dispatch FROM public.dispatches
      WHERE vehicle_plate = p_plate
        AND status NOT IN ('LIQUIDADO','CERRADO','CANCELADO','RETORNO_COMPLETADO','FINALIZADO');
      IF v_active_dispatch > 0 THEN
          v_motives := v_motives || jsonb_build_array('Vehiculo tiene un viaje/despacho activo');
      END IF;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL;
  END;

  IF jsonb_array_length(v_motives) > 0 THEN
    v_status := 'NO_APTO';
  ELSIF jsonb_array_length(v_observations) > 0 THEN
    v_status := 'APTO_CON_OBSERVACION';
  END IF;

  RETURN jsonb_build_object(
    'status', v_status,
    'motives', v_motives,
    'observations', v_observations
  );
END;
$$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.check_asset_eligibility(TEXT) TO authenticated, service_role;
GRANT SELECT ON public.vw_document_alerts TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
