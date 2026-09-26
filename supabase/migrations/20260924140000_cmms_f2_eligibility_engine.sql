BEGIN;

-- 1. Tablas y columnas de control
CREATE TABLE IF NOT EXISTS public.vehicle_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_plate TEXT NOT NULL,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('SOAT','REVISION_TECNICA','TARJETA_PROPIEDAD','SEGURO_VEHICULAR')),
  doc_number TEXT,
  issue_date DATE,
  expiry_date DATE NOT NULL,
  file_url TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN DEFAULT false;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS block_reason TEXT;

-- 2. Motor Central de Elegibilidad
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
    RETURN jsonb_build_object('status', 'NO_APTO', 'motives', jsonb_build_array('Vehículo no encontrado'));
  END IF;

  -- OTs abiertas (Mantenimiento)
  BEGIN
      SELECT count(*) INTO v_open_mo_count
      FROM public.maintenance_orders
      WHERE vehicle_plate = p_plate AND status NOT IN ('FINALIZADA', 'COMPLETADO', 'CANCELADO');
      IF v_open_mo_count > 0 THEN
          v_motives := v_motives || jsonb_build_array('Tiene órdenes de trabajo (OTs) abiertas');
      END IF;
  EXCEPTION WHEN undefined_table THEN
      BEGIN
          SELECT count(*) INTO v_open_mo_count
          FROM public.maintenance_work_orders
          WHERE vehicle_plate = p_plate AND status NOT IN ('COMPLETADO', 'FINALIZADO', 'CANCELADO');
          IF v_open_mo_count > 0 THEN
              v_motives := v_motives || jsonb_build_array('Tiene órdenes de trabajo (OTs) abiertas');
          END IF;
      EXCEPTION WHEN undefined_table THEN NULL;
      END;
  END;

  -- SOAT vencido
  BEGIN
      SELECT expiry_date INTO v_soat_expiry FROM public.vehicle_documents
      WHERE vehicle_plate = p_plate AND doc_type = 'SOAT' AND is_active = true
      ORDER BY expiry_date DESC LIMIT 1;
      
      IF v_soat_expiry IS NULL THEN
          BEGIN
              v_soat_expiry := v_vehicle.soat_expiration;
          EXCEPTION WHEN undefined_column THEN NULL;
          END;
      END IF;

      IF v_soat_expiry IS NULL OR v_soat_expiry < CURRENT_DATE THEN
          v_motives := v_motives || jsonb_build_array('SOAT vencido o no registrado');
      ELSIF v_soat_expiry < CURRENT_DATE + 7 THEN
          v_observations := v_observations || jsonb_build_array('SOAT próximo a vencer');
      END IF;
  EXCEPTION WHEN undefined_table THEN NULL;
  END;

  -- Revisión técnica vencida
  BEGIN
      SELECT expiry_date INTO v_rt_expiry FROM public.vehicle_documents
      WHERE vehicle_plate = p_plate AND doc_type = 'REVISION_TECNICA' AND is_active = true
      ORDER BY expiry_date DESC LIMIT 1;
      
      IF v_rt_expiry IS NULL THEN
          BEGIN
              v_rt_expiry := v_vehicle.technical_review_expiration;
          EXCEPTION WHEN undefined_column THEN NULL;
          END;
      END IF;

      IF v_rt_expiry IS NULL OR v_rt_expiry < CURRENT_DATE THEN
          v_motives := v_motives || jsonb_build_array('Revisión Técnica vencida o no registrada');
      ELSIF v_rt_expiry < CURRENT_DATE + 7 THEN
          v_observations := v_observations || jsonb_build_array('Revisión Técnica próxima a vencer');
      END IF;
  EXCEPTION WHEN undefined_table THEN NULL;
  END;

  -- Fallas críticas abiertas
  BEGIN
      SELECT count(*) INTO v_open_faults FROM public.maintenance_requests
      WHERE vehicle_plate = p_plate AND severity = 'CRITICA' AND status = 'PENDIENTE';
      IF v_open_faults > 0 THEN
          v_motives := v_motives || jsonb_build_array('Falla crítica pendiente de resolución');
      END IF;
  EXCEPTION WHEN undefined_table THEN NULL;
  END;

  -- Viajes activos
  BEGIN
      SELECT count(*) INTO v_active_dispatch FROM public.dispatches
      WHERE vehicle_plate = p_plate
        AND status NOT IN ('LIQUIDADO','CERRADO','CANCELADO','RETORNO_COMPLETADO','FINALIZADO');
      IF v_active_dispatch > 0 THEN
          v_motives := v_motives || jsonb_build_array('Vehículo tiene un viaje/despacho activo');
      END IF;
  EXCEPTION WHEN undefined_column OR undefined_table THEN NULL;
  END;

  -- Preventivo vencido
  BEGIN
      IF EXISTS (
          SELECT 1 FROM public.maintenance_plans
          WHERE vehicle_plate = p_plate 
            AND is_active = true
            AND (
                (next_due_km IS NOT NULL AND v_vehicle.current_odometer IS NOT NULL AND v_vehicle.current_odometer >= next_due_km)
                OR (next_due_date IS NOT NULL AND CURRENT_DATE >= next_due_date)
            )
      ) THEN
          v_motives := v_motives || jsonb_build_array('Preventivo Vencido');
      END IF;
  EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
  END;

  -- Bloqueos administrativos
  BEGIN
      IF v_vehicle.is_blocked THEN
          v_motives := v_motives || jsonb_build_array('Bloqueo administrativo activo: ' || COALESCE(v_vehicle.block_reason, 'Sin motivo detallado'));
      END IF;
      IF v_vehicle.status = 'INACTIVA' THEN
          v_motives := v_motives || jsonb_build_array('Vehículo en estado INACTIVA');
      END IF;
  EXCEPTION WHEN undefined_column THEN NULL;
  END;

  IF jsonb_array_length(v_motives) > 0 THEN
      v_status := 'NO_APTO';
  ELSIF jsonb_array_length(v_observations) > 0 THEN
      v_status := 'APTO_CON_OBSERVACION';
  ELSE
      v_status := 'APTO';
  END IF;

  RETURN jsonb_build_object(
      'status', v_status,
      'motives', v_motives,
      'observations', v_observations
  );
END;
$$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.check_asset_eligibility(text) TO authenticated, service_role;

-- 3. Update transition_vehicle_status
CREATE OR REPLACE FUNCTION public.transition_vehicle_status(
    p_vehicle_plate text, 
    p_new_status text, 
    p_reason text DEFAULT NULL
) RETURNS jsonb AS $$$
DECLARE
    v_current_status text;
    v_valid_transition boolean := false;
    v_open_mo_count int;
    v_eligibility jsonb;
BEGIN
    SELECT status INTO v_current_status
    FROM public.vehicles
    WHERE plate = p_vehicle_plate;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Vehicle not found');
    END IF;

    -- Validate transition
    IF v_current_status = 'DISPONIBLE' AND p_new_status IN ('ASIGNADA', 'MANTENIMIENTO', 'BLOQUEADA', 'FUERA_DE_SERVICIO', 'OBSERVADA') THEN
        v_valid_transition := true;
    ELSIF v_current_status = 'ASIGNADA' AND p_new_status IN ('EN_RUTA', 'DISPONIBLE', 'MANTENIMIENTO', 'BLOQUEADA') THEN
        v_valid_transition := true;
    ELSIF v_current_status = 'EN_RUTA' AND p_new_status IN ('ASIGNADA', 'DISPONIBLE', 'MANTENIMIENTO', 'BLOQUEADA') THEN
        v_valid_transition := true;
    ELSIF v_current_status = 'OBSERVADA' AND p_new_status IN ('DISPONIBLE', 'MANTENIMIENTO', 'BLOQUEADA', 'FUERA_DE_SERVICIO') THEN
        v_valid_transition := true;
    ELSIF v_current_status = 'MANTENIMIENTO' AND p_new_status IN ('DISPONIBLE', 'OBSERVADA', 'FUERA_DE_SERVICIO') THEN
        v_valid_transition := true;
    ELSIF v_current_status = 'BLOQUEADA' AND p_new_status = 'DISPONIBLE' THEN
        v_valid_transition := true;
    ELSIF v_current_status = 'FUERA_DE_SERVICIO' AND p_new_status = 'DISPONIBLE' THEN
        v_valid_transition := true;
    END IF;

    IF NOT v_valid_transition THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid transition from ' || v_current_status || ' to ' || p_new_status);
    END IF;

    -- BLOQUEO CMMS: Verificar elegibilidad al pasar a DISPONIBLE
    IF p_new_status = 'DISPONIBLE' THEN
        v_eligibility := public.check_asset_eligibility(p_vehicle_plate);
        IF (v_eligibility->>'status') = 'NO_APTO' THEN
            RETURN jsonb_build_object('success', false, 'error', 'No elegible para DISPONIBLE. Motivos: ' || (v_eligibility->>'motives'));
        END IF;
    END IF;

    UPDATE public.vehicles
    SET status = p_new_status
    WHERE plate = p_vehicle_plate;

    RETURN jsonb_build_object('success', true, 'new_status', p_new_status);
END;
$$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.transition_vehicle_status(text, text, text) TO authenticated, service_role;

-- 4. Update complete_maintenance_order
CREATE OR REPLACE FUNCTION public.complete_maintenance_order(
    p_order_id UUID,
    p_used_parts JSONB,
    p_closing_notes TEXT
)
RETURNS jsonb AS $$$
DECLARE
    v_order RECORD;
    v_part JSONB;
    v_part_id UUID;
    v_qty INTEGER;
    v_transition_result JSONB;
    v_current_odometer NUMERIC(10,2);
    v_unit_price DECIMAL(10,2);
    v_part_name TEXT;
BEGIN
    SELECT * INTO v_order 
    FROM public.maintenance_work_orders 
    WHERE id = p_order_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Orden de trabajo no encontrada');
    END IF;

    IF v_order.status IN ('COMPLETADO', 'FINALIZADO') THEN
        RETURN jsonb_build_object('success', false, 'error', 'La orden de trabajo ya está completada');
    END IF;

    UPDATE public.maintenance_work_orders
    SET 
        status = 'COMPLETADO',
        actual_end_date = NOW(),
        diagnostic = COALESCE(diagnostic, '') || CHR(10) || 'Notas de Cierre: ' || COALESCE(p_closing_notes, '')
    WHERE id = p_order_id;

    IF p_used_parts IS NOT NULL AND jsonb_array_length(p_used_parts) > 0 THEN
        FOR v_part IN SELECT * FROM jsonb_array_elements(p_used_parts)
        LOOP
            v_part_id := (v_part->>'part_id')::UUID;
            v_qty := (v_part->>'quantity')::INTEGER;
            
            IF v_part_id IS NOT NULL AND v_qty > 0 THEN
                INSERT INTO public.inventory_transactions (part_id, quantity, transaction_type, reference_id, date)
                VALUES (v_part_id, v_qty, 'OUT', p_order_id, NOW());
                
                SELECT name, COALESCE(unit_price, 0) INTO v_part_name, v_unit_price
                FROM public.spare_parts
                WHERE id = v_part_id;

                INSERT INTO public.work_order_costs (
                    work_order_id,
                    cost_type,
                    amount,
                    description
                ) VALUES (
                    p_order_id,
                    'REPUESTOS',
                    v_qty * v_unit_price,
                    'Repuesto consumido: ' || v_part_name || ' (Cant: ' || v_qty || ')'
                );
            END IF;
        END LOOP;
    END IF;

    v_transition_result := public.transition_vehicle_status(
        v_order.vehicle_plate, 
        'DISPONIBLE', 
        'Mantenimiento finalizado por OT: ' || COALESCE(v_order.ot_number, '')
    );

    IF NOT (v_transition_result->>'success')::boolean THEN
        RAISE EXCEPTION 'No se puede liberar el vehículo a DISPONIBLE: %', v_transition_result->>'error';
    END IF;

    IF v_order.plan_id IS NOT NULL THEN
        SELECT COALESCE(current_odometer, 0) INTO v_current_odometer
        FROM public.vehicles
        WHERE plate = v_order.vehicle_plate;

        UPDATE public.maintenance_plans
        SET 
            last_performed_date = CURRENT_DATE,
            last_performed_km = v_current_odometer,
            last_performed_odometer = v_current_odometer
        WHERE id = v_order.plan_id;
    END IF;

    RETURN jsonb_build_object(
        'success', true, 
        'message', 'Orden de mantenimiento completada exitosamente',
        'vehicle_transition', v_transition_result
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.complete_maintenance_order(UUID, JSONB, TEXT) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
