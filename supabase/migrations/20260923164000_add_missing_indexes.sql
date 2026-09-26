BEGIN;

CREATE INDEX IF NOT EXISTS idx_dispatch_requests_transport_request ON public.dispatch_requests(transport_request_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_expenses_dispatch ON public.dispatch_expenses(dispatch_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_events_user ON public.dispatch_events(user_id);
CREATE INDEX IF NOT EXISTS idx_vm_records_dispatch ON public.vehicle_maintenance_records(dispatch_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_requests_plate ON public.maintenance_requests(vehicle_plate, status);
CREATE INDEX IF NOT EXISTS idx_vehicle_odometer_logs_plate ON public.vehicle_odometer_logs(vehicle_plate, created_at DESC);

COMMIT;
