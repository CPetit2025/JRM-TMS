-- Migration for Fase 4 - Work Orders Manager

ALTER TABLE IF NOT EXISTS public.maintenance_work_orders 
ADD COLUMN IF NOT EXISTS order_type VARCHAR(50),
ADD COLUMN IF NOT EXISTS priority VARCHAR(50),
ADD COLUMN IF NOT EXISTS responsible_id UUID REFERENCES auth.users(id),
ADD COLUMN IF NOT EXISTS mechanic_id UUID REFERENCES auth.users(id),
ADD COLUMN IF NOT EXISTS provider_id UUID,
ADD COLUMN IF NOT EXISTS diagnosis TEXT,
ADD COLUMN IF NOT EXISTS tasks JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS labor_cost DECIMAL(10,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS parts_cost DECIMAL(10,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS services_cost DECIMAL(10,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_cost DECIMAL(10,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS evidence_urls JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS downtime_start TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS downtime_end TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES auth.users(id);

ALTER TABLE public.maintenance_work_orders DROP CONSTRAINT IF EXISTS maintenance_work_orders_status_check;
ALTER TABLE public.maintenance_work_orders DROP CONSTRAINT IF EXISTS maintenance_work_orders_order_type_check;

ALTER TABLE public.maintenance_work_orders ADD CONSTRAINT maintenance_work_orders_order_type_check CHECK (order_type IN ('CORRECTIVA', 'PREVENTIVA', 'EMERGENCIA', 'INSPECCION', 'MEJORA'));

UPDATE public.maintenance_work_orders SET status = 'EN_PROCESO' WHERE status = 'PENDIENTE';
UPDATE public.maintenance_work_orders SET status = 'TERMINADA' WHERE status = 'COMPLETADO';
UPDATE public.maintenance_work_orders SET status = 'CANCELADA' WHERE status = 'CANCELADO';
UPDATE public.maintenance_work_orders SET status = 'BORRADOR' WHERE status NOT IN ('BORRADOR', 'APROBADA', 'PROGRAMADA', 'EN_PROCESO', 'EN_ESPERA', 'TERMINADA', 'VALIDACION', 'CERRADA', 'CANCELADA');

ALTER TABLE public.maintenance_work_orders ADD CONSTRAINT maintenance_work_orders_status_check CHECK (status IN ('BORRADOR', 'APROBADA', 'PROGRAMADA', 'EN_PROCESO', 'EN_ESPERA', 'TERMINADA', 'VALIDACION', 'CERRADA', 'CANCELADA'));

CREATE OR REPLACE FUNCTION public.update_ot_downtime()
RETURNS TRIGGER AS $$$
BEGIN
    IF NEW.status = 'EN_PROCESO' AND OLD.status != 'EN_PROCESO' THEN
        IF NEW.downtime_start IS NULL THEN
            NEW.downtime_start := CURRENT_TIMESTAMP;
        END IF;
    END IF;
    IF NEW.status IN ('TERMINADA', 'CERRADA') AND OLD.status NOT IN ('TERMINADA', 'CERRADA') THEN
        IF NEW.downtime_end IS NULL THEN
            NEW.downtime_end := CURRENT_TIMESTAMP;
        END IF;
    END IF;
    RETURN NEW;
END;
$$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_ot_downtime ON public.maintenance_work_orders;
CREATE TRIGGER trg_update_ot_downtime
BEFORE UPDATE ON public.maintenance_work_orders
FOR EACH ROW
EXECUTE FUNCTION public.update_ot_downtime();

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
    v_eligibility jsonb;
BEGIN
    SELECT * INTO v_order 
    FROM public.maintenance_work_orders 
    WHERE id = p_order_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Orden de trabajo no encontrada');
    END IF;

    IF v_order.status IN ('CERRADA', 'TERMINADA') THEN
        RETURN jsonb_build_object('success', false, 'error', 'La orden de trabajo ya esta cerrada o terminada');
    END IF;

    UPDATE public.maintenance_work_orders
    SET 
        status = 'CERRADA',
        diagnosis = COALESCE(diagnosis, '') || CHR(10) || 'Notas de Cierre: ' || COALESCE(p_closing_notes, '')
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

    v_eligibility := public.check_asset_eligibility(v_order.vehicle_plate);
    IF v_eligibility->>'status' = 'APTO' THEN
        v_transition_result := public.transition_vehicle_status(
            v_order.vehicle_plate, 
            'DISPONIBLE', 
            'Mantenimiento finalizado por OT: ' || COALESCE(v_order.ot_number, '')
        );
        
        IF NOT (v_transition_result->>'success')::boolean THEN
            RETURN jsonb_build_object(
                'success', true, 
                'message', 'Orden de mantenimiento cerrada exitosamente, pero no se pudo liberar vehiculo.',
                'vehicle_transition', v_transition_result
            );
        END IF;
    ELSE
        RETURN jsonb_build_object(
            'success', true, 
            'message', 'Orden cerrada. Vehiculo sigue ' || (v_eligibility->>'status') || ' por otros motivos.',
            'eligibility', v_eligibility
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true, 
        'message', 'Orden de mantenimiento completada exitosamente. Vehiculo liberado.',
        'vehicle_transition', v_transition_result
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.complete_maintenance_order(UUID, JSONB, TEXT) TO authenticated, service_role;

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
          v_observations := v_observations || jsonb_build_array('SOAT proximo a vencer');
      END IF;
  EXCEPTION WHEN undefined_table THEN NULL;
  END;

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

NOTIFY pgrst, 'reload schema';
