-- Estadísticas y claves concretas para las agregaciones de una familia OT.
-- Conserva la definición instalada, sus reglas contables y los permisos.
BEGIN;
DO $migration$
DECLARE definition text; updated text; key_start integer; key_end integer; keys text;
BEGIN
 definition:=pg_get_functiondef('public.apt_ot_familia(text)'::regprocedure);
 IF position('apt_family_keys_idx' IN definition)>0 THEN RETURN; END IF;
 key_start:=position('  WITH lotes AS (' IN definition);
 key_end:=position('  ly AS (SELECT l.lote' IN definition);
 IF key_start=0 OR key_end<=key_start OR position('FROM lotes lt LEFT JOIN f_sosp' IN definition)=0 THEN
   RAISE EXCEPTION 'La definición instalada de apt_ot_familia no coincide con los puntos de optimización'; END IF;
 keys:=substring(definition FROM key_start+length('  WITH lotes AS (') FOR key_end-key_start-length('  WITH lotes AS ('));
 -- Quita solamente el cierre del CTE y su coma; conserva exactamente sus tres fuentes.
 keys:=regexp_replace(keys,'\),\s*$','');
 updated:=replace(definition,'CREATE TEMP TABLE f_sosp ON COMMIT DROP AS SELECT * FROM public.apt_ot_sospechosos(v_ot);',
   E'CREATE TEMP TABLE f_sosp ON COMMIT DROP AS SELECT * FROM public.apt_ot_sospechosos(v_ot);\n  CREATE INDEX ON f_sosp(lote);\n  ANALYZE f_sosp;');
 updated:=replace(updated,'  CREATE TEMP TABLE f_lot ON COMMIT DROP AS'||E'\n'||substring(definition FROM key_start FOR key_end-key_start),
   E'  DROP TABLE IF EXISTS pg_temp.f_keys;\n  CREATE TEMP TABLE f_keys ON COMMIT DROP AS\n'||keys||E';\n  CREATE UNIQUE INDEX apt_family_keys_idx ON f_keys(lote);\n  ANALYZE f_keys;\n  CREATE TEMP TABLE f_lot ON COMMIT DROP AS\n  WITH ');
 updated:=replace(updated,'JOIN lotes USING (lote)','JOIN pg_temp.f_keys USING (lote)');
 updated:=replace(updated,'FROM lotes lt LEFT JOIN f_sosp','FROM pg_temp.f_keys lt LEFT JOIN f_sosp');
 updated:=replace(updated,'mv ON mv.lote = lt.lote;',E'mv ON mv.lote = lt.lote;\n  CREATE INDEX ON f_lot(lote);\n  ANALYZE f_lot;');
 IF position('apt_family_keys_idx' IN updated)=0 OR position('WITH lotes AS (' IN updated)>0 THEN RAISE EXCEPTION 'No se pudo materializar la familia OT'; END IF;
 EXECUTE updated;
END $migration$;
COMMIT;
NOTIFY pgrst, 'reload schema';
