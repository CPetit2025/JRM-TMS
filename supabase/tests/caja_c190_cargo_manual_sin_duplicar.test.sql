-- C190: control de cargo manual duplicado (auditoría F08) instalado, para usuarios autenticados y sin acceso anónimo.
BEGIN;
DO $$
DECLARE f regprocedure := 'public.register_contract_service_checked(uuid,varchar,text,numeric,date,varchar,varchar,numeric,varchar,varchar,varchar,text,text)'::regprocedure;
BEGIN
 IF NOT has_function_privilege('authenticated', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C190 FAIL: permisos del registro con control de duplicados';
 END IF;
 IF position('Confirmado no duplicado' IN pg_get_functiondef(f)) = 0 THEN
  RAISE EXCEPTION 'CAJA C190 FAIL: el registro no exige motivo ante un posible duplicado';
 END IF;
 RAISE EXCEPTION 'CAJA C190 PASS: cargo manual con control de duplicados por partida, tipo, fecha, ruta, importe o proveedor';
END $$;
ROLLBACK;
