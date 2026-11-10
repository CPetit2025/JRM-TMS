-- Incidente C55 (prueba de caja del despliegue de 20261231130000): erp_robot_due es SECURITY DEFINER y quedó abierta a
-- anon. En el TMS ninguna función privilegiada se expone a anónimos, aunque solo devuelva verdadero/falso.
-- El robot ahora inicia sesión con su cuenta antes de preguntar (scripts/erp-auto/solicitudes.mjs).
REVOKE EXECUTE ON FUNCTION public.erp_robot_due() FROM anon;
GRANT EXECUTE ON FUNCTION public.erp_robot_due() TO authenticated, service_role;
