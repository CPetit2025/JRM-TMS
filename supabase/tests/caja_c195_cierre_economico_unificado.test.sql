-- C195: cierre económico como único lugar del costo final — disparador de bloqueo instalado, estado de la bandeja
-- disponible para el sistema e indicadores con los estados de la bandeja (se ejecutan con el esquema real).
BEGIN;
DO $$
DECLARE actor uuid; v jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='transport_unloading_costs_final_lock' AND tgrelid='public.transport_unloading_costs'::regclass AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'CAJA C195 FAIL: falta el bloqueo del costo final fuera del cierre económico';
 END IF;
 IF has_function_privilege('authenticated','public.economic_queue_key(uuid)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C195 FAIL: economic_queue_key es interna';
 END IF;
 SELECT p.id INTO actor FROM public.profiles p JOIN public.roles r ON r.id=p.role_id JOIN auth.users u ON u.id=p.id
 WHERE p.is_active AND r.name='Administrador' ORDER BY p.id LIMIT 1;
 IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C195 FAIL: falta cuenta administradora'; END IF;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
 v := public.service_cost_indicators((now() AT TIME ZONE 'America/Lima')::date - 30, (now() AT TIME ZONE 'America/Lima')::date);
 IF v->>'success' IS DISTINCT FROM 'true' OR NOT (v->'pending' ? 'por_cerrar') OR NOT (v->'pending' ? 'no_aplica') THEN
  RAISE EXCEPTION 'CAJA C195 FAIL: indicadores sin los estados de la bandeja: %', v->'pending';
 END IF;
 RAISE EXCEPTION 'CAJA C195 PASS: costo final solo en el cierre económico; indicadores con los estados de la bandeja (%)', v->'pending';
END $$;
ROLLBACK;
