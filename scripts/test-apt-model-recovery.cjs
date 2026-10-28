// Ejecuta el trabajador real en PostgreSQL aislado con la forma de producción.
const {PGlite}=require('@electric-sql/pglite')
const fs=require('node:fs'),assert=require('node:assert/strict')
const shape=fs.readFileSync('scripts/security/production-shape.sql','utf8')
const table=name=>{const start=shape.indexOf(`CREATE TABLE public."${name}" (`);assert.ok(start>=0);return shape.slice(start,shape.indexOf(';',start)+1)}
;(async()=>{const db=new PGlite();try{
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 ${['apt_state','apt_flow_state','apt_uploads','apt_settings','apt_movements'].map(table).join('\n')}
 CREATE TABLE calls(model text);
 CREATE FUNCTION apt_rebuild() RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN
 IF current_setting('test.fail',true)='estadia' THEN RAISE EXCEPTION 'Fallo temporal estadia'; END IF;
 INSERT INTO calls VALUES('estadia'); UPDATE apt_state SET cutoff=(SELECT coalesce((SELECT cutoff_date FROM apt_settings WHERE id=1),max(fecha)) FROM apt_movements WHERE active AND valid),rebuilt_at=now();
 RETURN '{"success":true}'::jsonb;END$$;
 CREATE FUNCTION apt_flow_rebuild_core() RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN
 IF current_setting('test.fail',true)='flujo' THEN RETURN '{"success":false,"error":"Fallo temporal flujo"}'::jsonb; END IF;
 INSERT INTO calls VALUES('flujo'); UPDATE apt_flow_state SET cutoff=(SELECT coalesce((SELECT cutoff_date FROM apt_settings WHERE id=1),max(fecha)) FROM apt_movements WHERE active AND valid),rebuilt_at=now();
 RETURN '{"success":true}'::jsonb;END$$;
 INSERT INTO apt_state(id) VALUES(1);INSERT INTO apt_flow_state(id) VALUES(1);
 INSERT INTO apt_settings(id) VALUES(1);`)
 const migration=fs.readFileSync('supabase/migrations/20261103150000_apt_automatic_model_recovery.sql','utf8').replace(/-- PLATFORM_CRON_BEGIN[\s\S]*?-- PLATFORM_CRON_END/,'')
 await db.exec(migration)
 const run=async model=>(await db.query('SELECT apt_models_ensure_current_core($1) AS v',[model])).rows[0].v
 const count=async()=>Number((await db.query('SELECT count(*) AS n FROM calls')).rows[0].n)
 assert.equal((await run('flujo')).empty,true)
 await db.exec(`INSERT INTO apt_movements(id,fecha,active,valid) VALUES(1,'2026-10-26',true,true);
 INSERT INTO apt_uploads(id,status,applied_at) VALUES('00000000-0000-4000-8000-000000000001','APLICADA',now()-interval '1 day');`)
 for(const model of ['estadia','flujo'])assert.equal((await run(model)).rebuilt,true)
 assert.equal(await count(),2)
 for(const model of ['estadia','flujo'])assert.equal((await run(model)).rebuilt,false)
 assert.equal(await count(),2,'fresh models are not recalculated every minute')
 // El reemplazo conserva el mismo corte: el timestamp de la carga debe invalidar ambos modelos.
 await db.exec(`UPDATE apt_state SET rebuilt_at=now()-interval '2 days';UPDATE apt_flow_state SET rebuilt_at=now()-interval '2 days';`)
 for(const model of ['estadia','flujo'])assert.equal((await run(model)).rebuilt,true)
 // Recuperación de dos transacciones independientes: fallar un modelo no impide el otro.
 await db.exec(`UPDATE apt_state SET rebuilt_at=now()-interval '2 days';UPDATE apt_flow_state SET rebuilt_at=now()-interval '2 days';SELECT set_config('test.fail','estadia',false);`)
 await assert.rejects(run('estadia'),/Fallo temporal/)
 assert.equal((await run('flujo')).rebuilt,true)
 await db.exec("SELECT set_config('test.fail','',false)")
 assert.equal((await run('estadia')).rebuilt,true,'next attempt recovers after transient failure')
 await db.exec("UPDATE apt_settings SET cutoff_date='2026-10-25',updated_at=now()")
 for(const model of ['estadia','flujo'])assert.equal((await run(model)).rebuilt,true)
 assert.equal((await db.query('SELECT cutoff::text AS cutoff FROM apt_flow_state')).rows[0].cutoff,'2026-10-25')
 await db.exec(`UPDATE apt_settings SET updated_at=now();UPDATE apt_flow_state SET rebuilt_at=now()-interval '1 hour';SELECT set_config('test.fail','flujo',false);`)
 await assert.rejects(run('flujo'),/No se pudo actualizar automáticamente/)
 await db.exec("SELECT set_config('test.fail','',false)")
 assert.equal((await run('flujo')).rebuilt,true)
 for(const value of ['otro',null])await assert.rejects(run(value),/Modelo APT inválido/)
 for(const role of ['anon','authenticated'])assert.equal((await db.query("SELECT has_function_privilege($1,'apt_models_ensure_current_core(text)','EXECUTE') AS allowed",[role])).rows[0].allowed,false)
 assert.equal((await db.query("SELECT has_function_privilege('service_role','apt_models_ensure_current_core(text)','EXECUTE') AS allowed")).rows[0].allowed,true)
 console.log('PASS automatic APT recovery: stale same-cutoff imports, settings/cutoff changes, independent failures and retry, no repeat rebuild and service-only permissions')
}finally{await db.close()}})().catch(error=>{console.error(error);process.exitCode=1})
