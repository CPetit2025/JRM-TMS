-- Permisos especiales asignables en lugar de reglas fijas por nombre de rol:
-- * cartera-propia      «Solo su cartera de OT (Responsable de OT)»: hoy solo el Administrador de Contratos.
-- * entregas-validacion «Validar conformidad de entregas»: hoy solo el Supervisor de Transporte.
-- * solo-documentos     «Solo documentos de despacho (auditor)»: hoy solo el Auditor de Despacho (regla de la web).
-- Los roles base reciben su permiso y conservan la regla por su nombre (son roles protegidos), así nadie pierde
-- acceso; cualquier otro rol puede recibir la capacidad marcando el permiso en «Roles y Permisos».
BEGIN;

UPDATE public.roles SET permissions = COALESCE(permissions, '[]'::jsonb) || '["cartera-propia"]'::jsonb
 WHERE name = 'Administrador de Contratos' AND NOT COALESCE(permissions, '[]'::jsonb) ? 'cartera-propia';
UPDATE public.roles SET permissions = COALESCE(permissions, '[]'::jsonb) || '["entregas-validacion"]'::jsonb
 WHERE name = 'Supervisor de Transporte' AND NOT COALESCE(permissions, '[]'::jsonb) ? 'entregas-validacion';
UPDATE public.roles SET permissions = COALESCE(permissions, '[]'::jsonb) || '["solo-documentos"]'::jsonb
 WHERE name = 'Auditor de Despacho' AND NOT COALESCE(permissions, '[]'::jsonb) ? 'solo-documentos';

-- Las funciones que exigían el nombre del rol aceptan también el permiso. Se reescriben sobre su definición vigente.
DO $especiales$
DECLARE f record; src text; changed text;
BEGIN
  FOR f IN SELECT p.oid, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname IN ('is_contract_administrator', 'reassign_contract_administrator', 'delivery_can_review')
  LOOP
    src := pg_get_functiondef(f.oid);
    changed := regexp_replace(src, '(\m[a-z_]+)\.name\s*=\s*''Administrador de Contratos''',
                              '(\1.name = ''Administrador de Contratos'' OR \1.permissions ? ''cartera-propia'')', 'g');
    changed := regexp_replace(changed, '(\m[a-z_]+)\.name\s*=\s*''Supervisor de Transporte''',
                              '(\1.name = ''Supervisor de Transporte'' OR \1.permissions ? ''entregas-validacion'')', 'g');
    IF changed = src THEN
      RAISE EXCEPTION 'No se encontró la regla por nombre de rol en %', f.proname;
    END IF;
    EXECUTE changed;
  END LOOP;
END $especiales$;

NOTIFY pgrst, 'reload schema';
COMMIT;
