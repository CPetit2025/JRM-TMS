-- Bounded inventory import: a committed chunk/apply can be retried without duplication.
-- Only synthetic staging rows; no model rebuild or production history changes. Always rolled back.
BEGIN;
-- Límites propios: una prueba cortada por la conexión no deja trabajo pesado corriendo en producción
SET LOCAL statement_timeout = '100s';
SET LOCAL lock_timeout = '60s';
-- Esperar a un recálculo real en curso (cron o carga) en vez de chocar con él a mitad de la prueba
SELECT pg_advisory_xact_lock(hashtext('inv_rebuild'));
-- Sin vistas guardadas del modelo real: las lecturas se calculan en vivo sobre los datos de la prueba
SET LOCAL inv.live = 'on';
DELETE FROM public.inv_read_cache;
DO $test$
DECLARE actor uuid; u uuid; r jsonb; payload jsonb; n int;
BEGIN
 SELECT p.id INTO actor FROM public.profiles p JOIN public.roles r ON r.id=p.role_id
 WHERE p.is_active AND r.name='Administrador' ORDER BY p.id LIMIT 1;
 IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C116 FAIL: no active administrator'; END IF;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
 INSERT INTO public.inv_doc_types(tipodocto,clase,auto) VALUES('C116 CUSTOM','DEVOLUCION',false);
 u := (public.inv_upload_begin('E','C116 retries.xlsx')->>'upload_id')::uuid;
 SELECT jsonb_agg(jsonb_build_object('__row',i,'BODEGA','C116 APT','TIPODOCTO','C116 CUSTOM',
   'Fecha','1998-01-01','Producto','C116.'||i,'Numero',i,'Cantidad',1,'Lote','016339-S005','PesoUnitario',2))
 INTO payload FROM generate_series(1,500) i;
 payload := payload || jsonb_build_array(jsonb_build_object('__row',501,'Producto','invalid','Cantidad',0));
 r := public.inv_upload_rows(u,payload);
 IF EXISTS(SELECT 1 FROM public.inv_movements WHERE upload_id=u AND clase<>'DEVOLUCION') THEN
   RAISE EXCEPTION 'CAJA C116 FAIL: incoming movement ignores configured document class';
 END IF;
 IF (r->>'inserted')::int <> 500 OR (r->'excluded'->>'Sin bodega')::int <> 1 THEN
   RAISE EXCEPTION 'CAJA C116 FAIL: first chunk %',r;
 END IF;
 r := public.inv_upload_rows(u,payload);
 IF NOT (r->>'replayed')::boolean OR (SELECT count(*) FROM public.inv_movements WHERE upload_id=u) <> 500
 OR NOT EXISTS(SELECT 1 FROM public.inv_uploads WHERE id=u AND rows_total=501 AND rows_valid=500 AND excluded->>'Sin bodega'='1') THEN
   RAISE EXCEPTION 'CAJA C116 FAIL: duplicated rows/counters on retry';
 END IF;
 r := public.inv_upload_apply_core(u);
 IF NOT (r->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C116 FAIL: apply %',r; END IF;
 r := public.inv_upload_apply_core(u);
 IF NOT (r->>'success')::boolean OR NOT (r->>'replayed')::boolean
 OR (SELECT count(*) FROM public.inv_movements WHERE upload_id=u AND active) <> 500 THEN
   RAISE EXCEPTION 'CAJA C116 FAIL: repeated apply';
 END IF;
 r := public.inv_catalogs();
 SELECT (x->>'movimientos')::int INTO n FROM jsonb_array_elements(r->'bodegas') x WHERE x->>'code'='C116 APT';
 IF n IS DISTINCT FROM 500 THEN RAISE EXCEPTION 'CAJA C116 FAIL: catalog counts %',n; END IF;
 IF public.inv_lote('016339-S005') IS DISTINCT FROM '16339-S005' OR public.inv_lote('0002870.0') IS DISTINCT FROM '2870'
 OR public.inv_lote('1') IS NOT NULL OR public.inv_lote(' 016339 -E014 ') IS DISTINCT FROM '16339-E014' THEN
   RAISE EXCEPTION 'CAJA C116 FAIL: normalization';
 END IF;
 IF has_table_privilege('authenticated','public.inv_upload_chunks','SELECT')
 OR has_table_privilege('anon','public.inv_upload_chunks','INSERT')
 OR has_function_privilege('anon','public.inv_upload_rows(uuid,jsonb)','EXECUTE')
 OR has_function_privilege('authenticated','public.inv_upload_apply_core(uuid,boolean)','EXECUTE') THEN
   RAISE EXCEPTION 'CAJA C116 FAIL: permissions';
 END IF;
 RAISE EXCEPTION 'CAJA C116 PASS: chunk and apply retries, counters, catalog counts, normalization and private receipts';
END $test$;
ROLLBACK;
