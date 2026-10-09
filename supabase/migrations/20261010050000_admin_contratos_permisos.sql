-- Administrador de Contratos: permisos pedidos por el dueño y selección de sus contratos (Responsable de OT).
-- * Permisos: Contratos y OTs lectura/escritura (ot:write), Registro de Servicios solo lectura
--   (contratos-servicios:read), Torre de Control lectura, APT lectura y sin "Dashboard Principal" (que abría
--   /reportes y el Resumen Ejecutivo). Se conservan Clientes (lectura), Solicitudes y JRM IA que ya tuviera.
-- * contract_admin_available_ots(): OT raíz sin responsable de las sedes del usuario.
-- * claim_contract_responsibility(uuid[]): el propio Administrador de Contratos se asigna como Responsable de OT
--   de las OT que elija, solo si siguen sin responsable (no quita OT a otro). Queda en el historial de asignaciones.
BEGIN;

-- La protección antigua fijaba los permisos del rol; ya se eliminó en 20260922112000, se repite por seguridad.
DROP TRIGGER IF EXISTS guard_core_roles ON public.roles;

UPDATE public.roles r
   SET permissions = (
         SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb) FROM (
           SELECT p AS v FROM jsonb_array_elements_text(COALESCE(r.permissions, '[]'::jsonb)) p
            WHERE split_part(p, ':', 1) NOT IN ('dashboard', 'reportes', 'ot', 'contratos-servicios', 'torre-control', 'apt', 'apt-carga')
           UNION ALL
           SELECT unnest(ARRAY['ot:write', 'contratos-servicios:read', 'torre-control:read', 'apt:read'])
         ) x),
       description = 'Gestiona sus contratos y OT (Responsable de OT) y sus solicitudes; consulta Registro de Servicios, Torre de Control y APT.'
 WHERE r.name = 'Administrador de Contratos';

CREATE OR REPLACE FUNCTION public.contract_admin_available_ots()
RETURNS TABLE (id uuid, code text, type text, status text, client_name text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT (public.is_contract_administrator() OR public.is_tms_admin()) THEN
    RAISE EXCEPTION 'Solo el Administrador de Contratos puede seleccionar sus OT';
  END IF;
  RETURN QUERY
  SELECT c.id, c.code::text, c.type::text, c.status::text, cl.business_name::text, c.created_at::timestamptz
    FROM public.contracts c
    LEFT JOIN public.clients cl ON cl.id = c.client_id
   WHERE c.parent_contract_id IS NULL
     AND c.type::text IN ('CONTRATO', 'OT_INDEPENDIENTE')
     AND upper(COALESCE(c.status::text, '')) NOT IN ('CANCELADO', 'ANULADO', 'CERRADO')
     AND EXISTS (SELECT 1 FROM public.user_site_access usa WHERE usa.user_id = auth.uid() AND usa.site_id = c.site_id)
     AND NOT EXISTS (SELECT 1 FROM public.contract_user_assignments a
                      WHERE a.contract_id = c.id AND a.role = 'ADMIN_CONTRATO' AND a.active)
   ORDER BY c.created_at DESC
   LIMIT 500;
END $$;
REVOKE ALL ON FUNCTION public.contract_admin_available_ots() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.contract_admin_available_ots() TO authenticated;

CREATE OR REPLACE FUNCTION public.claim_contract_responsibility(p_contract_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid; v_taken int := 0; v_skipped int := 0;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_contract_administrator() THEN
    RAISE EXCEPTION 'Solo el Administrador de Contratos puede asumir OT como responsable';
  END IF;
  IF p_contract_ids IS NULL OR cardinality(p_contract_ids) = 0 OR cardinality(p_contract_ids) > 200 THEN
    RAISE EXCEPTION 'Seleccione entre 1 y 200 OT';
  END IF;
  FOREACH v_id IN ARRAY (SELECT array_agg(DISTINCT x) FROM unnest(p_contract_ids) x WHERE x IS NOT NULL) LOOP
    PERFORM 1 FROM public.contracts c
     WHERE c.id = v_id AND c.parent_contract_id IS NULL AND c.type::text IN ('CONTRATO', 'OT_INDEPENDIENTE')
       AND EXISTS (SELECT 1 FROM public.user_site_access usa WHERE usa.user_id = auth.uid() AND usa.site_id = c.site_id)
     FOR UPDATE;
    IF NOT FOUND OR EXISTS (SELECT 1 FROM public.contract_user_assignments a
                             WHERE a.contract_id = v_id AND a.role = 'ADMIN_CONTRATO' AND a.active) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    INSERT INTO public.contract_user_assignments(contract_id, user_id, role, assigned_by, reason)
    VALUES (v_id, auth.uid(), 'ADMIN_CONTRATO', auth.uid(), 'Seleccionada por el Administrador de Contratos');
    v_taken := v_taken + 1;
  END LOOP;
  RETURN jsonb_build_object('asignadas', v_taken, 'omitidas', v_skipped);
END $$;
REVOKE ALL ON FUNCTION public.claim_contract_responsibility(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_contract_responsibility(uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
