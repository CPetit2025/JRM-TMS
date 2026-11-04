-- Desbloquear C55 tras la creación de las tablas y vista de mantenimiento.
-- Conservar la lectura de la vista y eliminar privilegios heredados de Supabase.
BEGIN;
REVOKE ALL ON public.vw_work_order_budget_status FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.vw_work_order_budget_status TO authenticated, service_role;

-- Los índices por OT existentes no cubren las FK de los actores de auditoría.
CREATE INDEX IF NOT EXISTS maintenance_wo_events_created_by_idx
  ON public.maintenance_work_order_events(created_by);
CREATE INDEX IF NOT EXISTS maintenance_wo_budget_requested_by_idx
  ON public.maintenance_work_order_budget_requests(requested_by);
CREATE INDEX IF NOT EXISTS maintenance_wo_budget_decided_by_idx
  ON public.maintenance_work_order_budget_requests(decided_by);
CREATE INDEX IF NOT EXISTS maintenance_wo_reports_created_by_idx
  ON public.maintenance_work_order_reports(created_by);
NOTIFY pgrst, 'reload schema';
COMMIT;
