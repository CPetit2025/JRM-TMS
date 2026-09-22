-- Ownership periods must survive ordinary changes to contracts and users.
ALTER TABLE public.contract_user_assignments
  DROP CONSTRAINT contract_user_assignments_contract_id_fkey;
ALTER TABLE public.contract_user_assignments
  ADD CONSTRAINT contract_user_assignments_contract_id_fkey
  FOREIGN KEY (contract_id) REFERENCES public.contracts(id) ON DELETE RESTRICT;
ALTER TABLE public.contract_user_assignments
  DROP CONSTRAINT contract_user_assignments_user_id_fkey;
ALTER TABLE public.contract_user_assignments
  ADD CONSTRAINT contract_user_assignments_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION public.track_new_contract()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := auth.uid();
  ELSE
    IF (NEW.parent_contract_id IS DISTINCT FROM OLD.parent_contract_id OR
        NEW.type IS DISTINCT FROM OLD.type) AND EXISTS (
      SELECT 1 FROM public.contract_user_assignments a WHERE a.contract_id=OLD.id) THEN
      RAISE EXCEPTION 'La jerarquía de una OT con historial no se puede cambiar';
    END IF;
    IF public.is_contract_administrator() AND
      (NEW.parent_contract_id IS DISTINCT FROM OLD.parent_contract_id OR
       NEW.type IS DISTINCT FROM OLD.type OR NEW.site_id IS DISTINCT FROM OLD.site_id OR
       NEW.created_by IS DISTINCT FROM OLD.created_by) THEN
      RAISE EXCEPTION 'No se puede cambiar la identidad o jerarquía de la OT';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP POLICY portfolio_contract_delete ON public.contracts;
CREATE POLICY portfolio_contract_delete ON public.contracts AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_contract_administrator());

-- A reason cannot be used to store unbounded unrelated content.
ALTER TABLE public.contract_user_assignments
  ADD CONSTRAINT assignment_reason_length CHECK (reason IS NULL OR length(reason)<=500);
