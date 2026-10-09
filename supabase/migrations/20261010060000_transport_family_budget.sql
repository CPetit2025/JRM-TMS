-- Una familia de OT comparte una partida: madre + subcontratos + errores.
-- allocated_pen en la raíz es el total; own_allocated_pen conserva el aporte editable.
BEGIN;
ALTER TABLE public.contract_budgets ADD COLUMN own_allocated_pen numeric;
UPDATE public.contract_budgets SET own_allocated_pen=COALESCE(allocated_pen,0);
ALTER TABLE public.contract_budgets ALTER COLUMN own_allocated_pen SET NOT NULL;
ALTER TABLE public.contract_budgets ADD CONSTRAINT transport_own_allocation_nonnegative CHECK (own_allocated_pen>=0);

CREATE OR REPLACE FUNCTION public.transport_family_totals(p_root uuid)
RETURNS TABLE(allocated numeric,reserved numeric,consumed numeric)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
 WITH RECURSIVE family(id) AS (
  SELECT id FROM public.contracts WHERE id=p_root
  UNION
  SELECT c.id FROM public.contracts c JOIN family f ON c.parent_contract_id=f.id
 )
 SELECT COALESCE(sum(b.own_allocated_pen),0),COALESCE(sum(b.reserved_pen),0),COALESCE(sum(b.consumed_pen),0)
 FROM public.contract_budgets b JOIN family f ON f.id=b.contract_id WHERE b.concept='PARTIDA_TRANSPORTE';
$$;
REVOKE ALL ON FUNCTION public.transport_family_totals(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.transport_family_totals(uuid) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.transport_budget_balance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_root uuid; v_total record; v_limit numeric; v_old numeric:=0;
BEGIN
 IF TG_OP='INSERT' THEN
  NEW.own_allocated_pen:=COALESCE(NEW.allocated_pen,0);
 ELSIF NEW.own_allocated_pen IS DISTINCT FROM OLD.own_allocated_pen THEN
  NEW.allocated_pen:=NEW.own_allocated_pen;
 ELSIF NEW.allocated_pen IS DISTINCT FROM OLD.allocated_pen THEN
  -- Los clientes existentes escriben allocated_pen: es un aporte, nunca un total de familia.
  NEW.own_allocated_pen:=COALESCE(NEW.allocated_pen,0);
 END IF;
 IF NEW.concept='PARTIDA_TRANSPORTE' THEN
  v_root:=public.contract_root_id(NEW.contract_id);
  -- Serializa cambios de aportes/gastos contra la misma fila que bloquean las reservas.
  IF v_root IS DISTINCT FROM NEW.contract_id THEN
   PERFORM 1 FROM public.contract_budgets WHERE contract_id=v_root AND concept='PARTIDA_TRANSPORTE' FOR UPDATE;
  ELSE
   SELECT * INTO v_total FROM public.transport_family_totals(v_root);
   NEW.allocated_pen:=v_total.allocated-CASE WHEN TG_OP='UPDATE' THEN OLD.own_allocated_pen ELSE 0 END+NEW.own_allocated_pen;
  END IF;
  v_limit:=public.transport_operating_budget(NEW.allocated_pen);
 ELSE
  v_limit:=COALESCE(NEW.allocated_pen,0);
 END IF;
 NEW.balance_pen:=v_limit-COALESCE(NEW.reserved_pen,0)-COALESCE(NEW.consumed_pen,0);
 IF NEW.concept='PARTIDA_TRANSPORTE' AND v_root=NEW.contract_id THEN
  NEW.balance_pen:=NEW.balance_pen-v_total.reserved-v_total.consumed+
   CASE WHEN TG_OP='UPDATE' THEN COALESCE(OLD.reserved_pen,0)+COALESCE(OLD.consumed_pen,0) ELSE 0 END;
 END IF;
 IF TG_OP='UPDATE' THEN v_old:=COALESCE(OLD.reserved_pen,0)+COALESCE(OLD.consumed_pen,0); END IF;
 IF NEW.concept='PARTIDA_TRANSPORTE' AND NEW.balance_pen<0 AND
  COALESCE(NEW.reserved_pen,0)+COALESCE(NEW.consumed_pen,0)>v_old THEN
  RAISE EXCEPTION 'Saldo insuficiente: solo se dispone del 80%% de la partida consolidada; el 20%% de utilidad está protegido';
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.transport_family_refresh() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_root uuid; v_balance numeric; v_increase boolean:=false;
BEGIN
 IF (CASE WHEN TG_OP='DELETE' THEN OLD.concept ELSE NEW.concept END) IS DISTINCT FROM 'PARTIDA_TRANSPORTE' THEN RETURN NULL; END IF;
 v_root:=public.contract_root_id(CASE WHEN TG_OP='DELETE' THEN OLD.contract_id ELSE NEW.contract_id END);
 IF v_root IS NULL OR v_root=(CASE WHEN TG_OP='DELETE' THEN OLD.contract_id ELSE NEW.contract_id END) THEN RETURN NULL; END IF;
 UPDATE public.contract_budgets SET allocated_pen=allocated_pen,updated_at=now()
  WHERE contract_id=v_root AND concept='PARTIDA_TRANSPORTE' RETURNING balance_pen INTO v_balance;
 IF TG_OP='INSERT' THEN v_increase:=COALESCE(NEW.reserved_pen,0)+COALESCE(NEW.consumed_pen,0)>0;
 ELSIF TG_OP='UPDATE' THEN v_increase:=COALESCE(NEW.reserved_pen,0)+COALESCE(NEW.consumed_pen,0)>COALESCE(OLD.reserved_pen,0)+COALESCE(OLD.consumed_pen,0); END IF;
 IF v_balance<0 AND v_increase THEN RAISE EXCEPTION 'Saldo insuficiente en la partida consolidada: el 20%% de utilidad está protegido'; END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER transport_family_refresh AFTER INSERT OR UPDATE OR DELETE ON public.contract_budgets
FOR EACH ROW EXECUTE FUNCTION public.transport_family_refresh();

CREATE OR REPLACE FUNCTION public.contract_budget_owner(p_contract_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT b.contract_id FROM public.contract_budgets b
 WHERE b.contract_id=public.contract_root_id(p_contract_id) AND b.concept='PARTIDA_TRANSPORTE';
$$;
-- Conserva aportes y gastos históricos, sin trasladarlos ni duplicarlos.
INSERT INTO public.contract_budgets(contract_id,concept,allocated_pen)
 SELECT c.id,'PARTIDA_TRANSPORTE',0 FROM public.contracts c WHERE c.parent_contract_id IS NULL
 AND NOT EXISTS(SELECT 1 FROM public.contract_budgets b WHERE b.contract_id=c.id AND b.concept='PARTIDA_TRANSPORTE');
UPDATE public.contract_budgets b SET allocated_pen=allocated_pen
 FROM public.contracts c WHERE c.id=b.contract_id AND c.parent_contract_id IS NULL AND b.concept='PARTIDA_TRANSPORTE';

-- Mantiene las columnas originales y la RLS de la vista ya desplegada.
DO $$ DECLARE v_sql text; BEGIN
 v_sql:=rtrim(pg_get_viewdef('public.vw_contracts_dashboard'::regclass,true),E';\n ');
 EXECUTE 'CREATE OR REPLACE VIEW public.vw_contracts_dashboard WITH (security_invoker=true) AS SELECT d.*, b.own_allocated_pen, t.reserved AS family_reserved_pen, t.consumed AS family_consumed_pen FROM ('||v_sql||') d LEFT JOIN public.contract_budgets b ON b.contract_id=d.id AND b.concept=''PARTIDA_TRANSPORTE'' LEFT JOIN LATERAL public.transport_family_totals(d.id) t ON true';
END $$;
REVOKE ALL ON FUNCTION public.transport_family_refresh(),public.transport_budget_balance() FROM PUBLIC,anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
