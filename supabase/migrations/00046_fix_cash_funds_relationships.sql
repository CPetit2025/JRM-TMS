-- ============================================================
-- 00046: Fix Foreign Keys to Profiles
-- ============================================================

-- Update cash_funds
ALTER TABLE public.cash_funds DROP CONSTRAINT IF EXISTS cash_funds_received_by_fkey;
ALTER TABLE public.cash_funds DROP CONSTRAINT IF EXISTS cash_funds_given_by_fkey;

ALTER TABLE public.cash_funds ADD CONSTRAINT cash_funds_received_by_fkey FOREIGN KEY (received_by) REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.cash_funds ADD CONSTRAINT cash_funds_given_by_fkey FOREIGN KEY (given_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- Update expense_records
ALTER TABLE public.expense_records DROP CONSTRAINT IF EXISTS expense_records_reported_by_fkey;
ALTER TABLE public.expense_records ADD CONSTRAINT expense_records_reported_by_fkey FOREIGN KEY (reported_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- Update cash_settlements
ALTER TABLE public.cash_settlements DROP CONSTRAINT IF EXISTS cash_settlements_approved_by_fkey;
ALTER TABLE public.cash_settlements ADD CONSTRAINT cash_settlements_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- Update expense_audit_logs
ALTER TABLE public.expense_audit_logs DROP CONSTRAINT IF EXISTS expense_audit_logs_user_id_fkey;
ALTER TABLE public.expense_audit_logs ADD CONSTRAINT expense_audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- Reload Schema Cache
NOTIFY pgrst, 'reload schema';
