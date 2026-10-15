BEGIN;
-- Full indexes also cover consumed authorization history. The pending-only
-- unique index deliberately cannot cover the driver FK for all records.
CREATE INDEX IF NOT EXISTS preuse_repeat_driver_lookup
 ON public.driver_preuse_repeat_authorizations(driver_id,operation_date,vehicle_key);
CREATE INDEX IF NOT EXISTS preuse_repeat_previous_operation
 ON public.driver_preuse_repeat_authorizations(previous_operation);
CREATE INDEX IF NOT EXISTS preuse_repeat_authorized_by
 ON public.driver_preuse_repeat_authorizations(authorized_by);
COMMIT;
