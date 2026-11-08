// Fase 4: la réplica del modelo de almacén se instala sobre la base WMS y usa los permisos del WMS.
const {PGlite}=require('@electric-sql/pglite');const fs=require('fs');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
 const db=new PGlite();
 const pre=fs.readFileSync(path.join(__dirname,'test-wms-picking.cjs'),'utf8').split('\n').find(l=>l.includes('CREATE ROLE anon'));
 await db.exec(pre.trim().replace(/^await db\.exec\(`/,'').replace(/`\);$/,''));
 const dir=path.join(__dirname,'../wms-db/supabase/migrations');
 for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir,f),'utf8'));
 const one=async s=>Object.values((await db.query(s)).rows[0])[0];
 assert.ok(await one("SELECT count(*)::int FROM pg_proc WHERE proname ~ '^(apt|inv|apa)_'")>=150,'funciones del modelo instaladas');
 for(const t of ['apt_movements','apt_layers','apt_flow_layers','inv_movements','inv_layers','inv_stock_cache','apa_movements','erp_derive_stock'])
  assert.ok(await one(`SELECT to_regclass('public.${t}') IS NOT NULL`),`tabla ${t}`);
 assert.match(await one("SELECT pg_get_functiondef('public.apt_can_view()'::regprocedure)"),/wh_any_warehouse_permission/,'apt_can_view usa permisos del WMS');
 assert.match(await one("SELECT pg_get_functiondef('public.apt_can_load()'::regprocedure)"),/almacen-carga/,'apt_can_load del WMS no se pisa');
 assert.equal(await one("SELECT has_table_privilege('anon','public.apt_movements','SELECT')"),false,'anónimo sin acceso');
 console.log('PASS: réplica del modelo de almacén instalada con permisos del WMS; tablas cerradas a anónimos.');
 await db.close();
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1)});
