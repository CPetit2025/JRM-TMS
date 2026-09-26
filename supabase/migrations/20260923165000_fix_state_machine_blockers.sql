BEGIN;

-- ==============================================================================
-- B1: transition_vehicle_status sin validación de permisos & B2: maintenance_orders tabla/columna incorrecta
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.transition_vehicle_status(
  p_vehicle_plate text,
  p_new_status text,
  p_reason text,
  p_user_id uuid,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_current_status text;
  v_open_mo_count int := 0;
  v_is_admin boolean := has_tms_permission('admin') OR has_tms_permission('mantenimiento') OR has_tms_permission('despacho');
  v_is_driver boolean := EXISTS (SELECT 1 FROM public.drivers WHERE user_id = auth.uid());
BEGIN
  -- Permission check (B1)
  -- Solo admin puede pasar a DISPONIBLE desde MANTENIMIENTO o BLOQUEADA
  IF p_new_status = 'DISPONIBLE' AND NOT v_is_admin THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient permissions to release vehicle');
  END IF;
  
  -- Solo admin puede pasar a FUERA_DE_SERVICIO
  IF p_new_status = 'FUERA_DE_SERVICIO' AND NOT has_tms_permission('admin') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient permissions');
  END IF;
  
  -- Conductores solo pueden bloquear (severidad critica), no liberar
  IF v_is_driver AND NOT v_is_admin AND p_new_status NOT IN ('BLOQUEADA', 'OBSERVADA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Drivers can only report critical faults');
  END IF;

  -- Get current status
  SELECT status INTO v_current_status
  FROM public.vehicles
  WHERE plate = p_vehicle_plate;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Vehicle not found');
  END IF;

  -- B2: Fix maintenance_orders query to handle uuid vs text plate, and catch undefined_table
  BEGIN
    SELECT count(*) INTO v_open_mo_count
    FROM public.maintenance_orders mo
    JOIN public.vehicles v ON v.id = mo.vehicle_id
    WHERE v.plate = p_vehicle_plate 
      AND mo.status NOT IN ('COMPLETADO', 'CANCELADO', 'FINALIZADO');
  EXCEPTION WHEN undefined_table THEN
    v_open_mo_count := 0;
  END;

  IF p_new_status = 'DISPONIBLE' AND v_open_mo_count > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot transition to DISPONIBLE with open maintenance orders');
  END IF;

  -- Execute transition
  UPDATE public.vehicles
  SET 
    status = p_new_status,
    updated_at = NOW()
  WHERE plate = p_vehicle_plate;

  -- Log transition
  INSERT INTO public.vehicle_status_logs (
    vehicle_plate, 
    old_status, 
    new_status, 
    reason, 
    changed_by, 
    metadata
  ) VALUES (
    p_vehicle_plate,
    v_current_status,
    p_new_status,
    p_reason,
    p_user_id,
    p_metadata
  );

  RETURN jsonb_build_object(
    'success', true, 
    'old_status', v_current_status,
    'new_status', p_new_status
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- Ensure grants
GRANT EXECUTE ON FUNCTION public.transition_vehicle_status(text, text, text, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transition_vehicle_status(text, text, text, uuid, jsonb) TO service_role;

-- ==============================================================================
-- B3: maintenance_requests sin política INSERT
-- ==============================================================================
-- Allow drivers to insert their own requests
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE schemaname = 'public' AND tablename = 'maintenance_requests' AND policyname = 'Conductores insertan sus reportes'
    ) THEN
        CREATE POLICY "Conductores insertan sus reportes"
        ON public.maintenance_requests FOR INSERT
        TO authenticated
        WITH CHECK (driver_id IN (SELECT id FROM public.drivers WHERE user_id = auth.uid()));
    END IF;
END $$;

-- Allow maintenance to manage requests
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE schemaname = 'public' AND tablename = 'maintenance_requests' AND policyname = 'Mantenimiento gestiona requests'
    ) THEN
        CREATE POLICY "Mantenimiento gestiona requests"
        ON public.maintenance_requests FOR ALL
        TO authenticated
        USING (has_tms_permission('mantenimiento'))
        WITH CHECK (has_tms_permission('mantenimiento'));
    END IF;
END $$;

-- ==============================================================================
-- BONUS: Agregar columnas faltantes a maintenance_requests
-- ==============================================================================
ALTER TABLE public.maintenance_requests
  ADD COLUMN IF NOT EXISTS failure_category TEXT DEFAULT 'OTRO',
  ADD COLUMN IF NOT EXISTS can_continue BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS reported_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS client_operation_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_maint_req_operation_id 
  ON public.maintenance_requests(client_operation_id) 
  WHERE client_operation_id IS NOT NULL;

COMMIT;
