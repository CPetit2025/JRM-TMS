-- Ensure the new security-invoker view receives only read privileges, even when
-- the project has permissive default privileges configured for new relations.
REVOKE ALL ON TABLE public.vw_work_order_budget_status FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.vw_work_order_budget_status TO authenticated, service_role;
