-- The legacy register_driver RPC can attach a driver's identity based on DNI.
-- Keep it inaccessible to browser sessions after the old RPC migration runs.
REVOKE ALL ON FUNCTION public.register_driver(uuid,text,text,text,text,text,text,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_driver(uuid,text,text,text,text,text,text,uuid)
  TO service_role;

DO $$
BEGIN
  IF to_regprocedure('public.register_driver(character varying,character varying,character varying,character varying,character varying,character varying,character varying,date)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.register_driver(varchar,varchar,varchar,varchar,varchar,varchar,varchar,date) FROM PUBLIC, anon, authenticated';
  END IF;
END $$;

-- Define the public tracking endpoint only after daily_tracking_links exists.
-- The legacy numbered migrations are applied lexicographically, so 000162
-- precedes 00049 on a fresh database.
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS vehicle_plate text;
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS driver_name text;
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS scheduled_departure timestamptz;
UPDATE public.dispatches SET scheduled_departure = scheduled_date
WHERE scheduled_departure IS NULL AND scheduled_date IS NOT NULL;
UPDATE public.dispatches d SET driver_name = trim(concat_ws(' ', dr.first_name, dr.last_name))
FROM public.drivers dr WHERE d.driver_id = dr.id AND coalesce(d.driver_name, '') = '';

CREATE OR REPLACE FUNCTION public.get_public_daily_tracking_locations(p_token uuid, p_pin text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'dispatch_id', d.id, 'driver_name', d.driver_name, 'vehicle_plate', d.vehicle_plate,
    'lat', d.last_lat, 'lng', d.last_lon, 'last_gps_at', d.last_gps_at,
    'actual_distance_km', d.actual_distance_km
  )), '[]'::jsonb)
  FROM public.daily_tracking_links l JOIN public.dispatches d
    ON d.scheduled_departure::date = l.planning_date
  WHERE l.tracking_token = p_token AND l.tracking_pin = p_pin
    AND l.expires_at > now() AND d.last_gps_at > now() - interval '15 minutes';
$$;
REVOKE ALL ON FUNCTION public.get_public_daily_tracking_locations(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_daily_tracking_locations(uuid,text) TO anon, authenticated;

-- Re-apply wallet policies after 00028 creates the contract budget table.
DROP POLICY IF EXISTS "Enable all for authenticated users on contract_budgets" ON public.contract_budgets;
DROP POLICY IF EXISTS contract_budget_read ON public.contract_budgets;
DROP POLICY IF EXISTS contract_budget_staff_write ON public.contract_budgets;
CREATE POLICY contract_budget_read ON public.contract_budgets FOR SELECT TO authenticated
  USING (public.has_tms_permission('dashboard') OR public.has_tms_permission('clientes')
    OR public.has_tms_permission('despacho'));
CREATE POLICY contract_budget_staff_write ON public.contract_budgets FOR ALL TO authenticated
  USING (public.has_tms_permission('clientes') OR public.has_tms_permission('despacho'))
  WITH CHECK (public.has_tms_permission('clientes') OR public.has_tms_permission('despacho'));

-- contract_services is introduced after the 16.x security migration too.
DROP POLICY IF EXISTS "Enable all for authenticated users on contract_services" ON public.contract_services;
DROP POLICY IF EXISTS contract_service_staff ON public.contract_services;
CREATE POLICY contract_service_staff ON public.contract_services FOR ALL TO authenticated
  USING (public.has_tms_permission('despacho') OR public.has_tms_permission('clientes'))
  WITH CHECK (public.has_tms_permission('despacho') OR public.has_tms_permission('clientes'));

-- These legacy financial RPCs are created by the wallet/service migrations.
DO $$ BEGIN
  IF to_regprocedure('public.reserve_transport_budget(uuid,numeric)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.reserve_transport_budget(uuid,numeric) FROM PUBLIC, anon, authenticated';
  END IF;
  IF to_regprocedure('public.liquidate_transport_budget(uuid,numeric,numeric)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.liquidate_transport_budget(uuid,numeric,numeric) FROM PUBLIC, anon, authenticated';
  END IF;
  IF to_regprocedure('public.register_contract_service(uuid,character varying,text,numeric,date,character varying,character varying,numeric,character varying,character varying,character varying)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.register_contract_service(uuid,character varying,text,numeric,date,character varying,character varying,numeric,character varying,character varying,character varying) FROM PUBLIC, anon, authenticated';
  END IF;
END $$;
