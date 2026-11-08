// Fase 4: extrae de producción del TMS el esquema del modelo de almacén (APT, inventario multialmacén, analítica y
// derivación ERP) y escribe una migración para wms-db. Solo lee del TMS.
const fs = require('node:fs')
const { connect } = require('./db.cjs')

// Tablas que pasan al WMS (las de contratos/clientes se quedan en el TMS; las de la fase 1 ya existen)
const TABLE_RE = /^(apt|inv|apa)_/
const TABLE_EXTRA = ['erp_derive_days', 'erp_derive_guias', 'erp_derive_stock', 'erp_load_log', 'erp_rule_versions', 'erp_sku_medidas']
// Funciones erp_* del modelo de almacén (las de contratos, clientes, referencias del TMS y carga ya están resueltas)
const ERP_FUNCS = ['erp_derive', 'erp_derive_core', 'erp_derive_estado', 'erp_bodega', 'erp_doc_key', 'erp_key', 'erp_lineas_stock', 'erp_stock',
  'erp_stock_corte', 'erp_stock_cruce', 'erp_analisis', 'erp_analisis_detalle', 'erp_calidad', 'erp_guias', 'erp_ots', 'erp_ot_detalle',
  'erp_reglas_comparacion', 'erp_rule_version', 'erp_stamp_rule_version', 'erp_log_start', 'erp_log_finish', 'erp_cargas_log', 'erp_medidas_texto', 'erp_tipo_tms', 'erp_ot_cliente_erp']
// Funciones que el WMS define a su manera y no se pisan
const KEEP_WMS = ['apt_can_load', 'apt_guia_key', 'erp_estado', 'erp_upload_begin', 'erp_upload_rows', 'erp_upload_apply', 'erp_upload_apply_core', 'erp_lote_doc', 'erp_unit_factor', 'erp_active_import']
// Lee servicios de contratos del TMS: se excluye. apt_flow_tms se replica: sin despachos del TMS devuelve vacío.
const TMS_ONLY = ['apt_vinculacion_estado']

;(async () => {
  const db = await connect('tms')
  const q = async (s, p) => (await db.query(s, p)).rows
  const tables = (await q(`select c.oid, c.relname, c.relkind from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','v','m') order by c.relname`)).filter(t => TABLE_RE.test(t.relname) || TABLE_EXTRA.includes(t.relname))
  const rels = tables.filter(t => t.relkind === 'r'), views = tables.filter(t => t.relkind !== 'r')
  const relNames = new Set(rels.map(t => t.relname))
  const out = { tables: [], sequences: [], constraints: [], fks: [], indexes: [], functions: [], views: [], triggers: [], security: [] }

  for (const t of rels) {
    const cols = await q(`select a.attname, format_type(a.atttypid, a.atttypmod) typ, a.attnotnull nn, pg_get_expr(d.adbin, d.adrelid) def,
      a.attidentity ident, a.attgenerated gen from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where a.attrelid=$1 and a.attnum>0 and not a.attisdropped order by a.attnum`, [t.oid])
    const body = cols.map(c => {
      let s = `  ${JSON.stringify(c.attname)} ${c.typ}`
      if (c.gen === 's') s += ` GENERATED ALWAYS AS (${c.def}) STORED`
      else if (c.ident) s += ` GENERATED ${c.ident === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`
      else if (c.def) s += ` DEFAULT ${c.def}`
      if (c.nn) s += ' NOT NULL'
      return s
    })
    out.tables.push({ name: t.relname, cols: cols.map(c => c.attname), ddl: `CREATE TABLE IF NOT EXISTS public.${t.relname} (\n${body.join(',\n')}\n);` ,
      alters: cols.filter(c => !c.gen && !c.ident).map(c => `ALTER TABLE public.${t.relname} ADD COLUMN IF NOT EXISTS ${JSON.stringify(c.attname)} ${c.typ}${c.def ? ` DEFAULT ${c.def}` : ''};`) })
    for (const s of await q(`select distinct substring(pg_get_expr(d.adbin, d.adrelid) from 'nextval\\(''([^'']+)''') seq from pg_attrdef d where d.adrelid=$1 and pg_get_expr(d.adbin, d.adrelid) like 'nextval%'`, [t.oid]))
      out.sequences.push(`CREATE SEQUENCE IF NOT EXISTS ${s.seq};`)
    for (const c of await q(`select conname, contype, pg_get_constraintdef(oid) def, confrelid::regclass::text ref from pg_constraint where conrelid=$1 and contype in ('p','u','c','f','x') order by contype desc, conname`, [t.oid])) {
      const sql = `DO $c$ BEGIN ALTER TABLE public.${t.relname} ADD CONSTRAINT ${JSON.stringify(c.conname)} ${c.def}; EXCEPTION WHEN duplicate_object OR duplicate_table OR invalid_table_definition THEN NULL; END $c$;`
      if (c.contype !== 'f') out.constraints.push(sql)
      else if (relNames.has(String(c.ref).replace(/^public\./, '')) || /^(public\.)?(erp_imports|erp_contract_lines|erp_stock_lots|profiles|roles|sites|contracts|clients)$/.test(c.ref)) out.fks.push(sql)
      else out.fks.push(`-- FK omitida (tabla solo del TMS): ${t.relname}.${c.conname} → ${c.ref}`)
    }
    for (const i of await q(`select pg_get_indexdef(i.indexrelid) def from pg_index i where i.indrelid=$1 and not exists (select 1 from pg_constraint k where k.conindid=i.indexrelid)`, [t.oid]))
      out.indexes.push(i.def.replace(/^CREATE (UNIQUE )?INDEX /, 'CREATE $1INDEX IF NOT EXISTS ') + ';')
    for (const p of await q(`select policyname, permissive, cmd, roles::text[] roles, qual, with_check from pg_policies where schemaname='public' and tablename=$1`, [t.relname]))
      out.security.push(`DROP POLICY IF EXISTS ${JSON.stringify(p.policyname)} ON public.${t.relname};\nCREATE POLICY ${JSON.stringify(p.policyname)} ON public.${t.relname} AS ${p.permissive} FOR ${p.cmd} TO ${p.roles.join(', ')}${p.qual ? ` USING (${p.qual})` : ''}${p.with_check ? ` WITH CHECK (${p.with_check})` : ''};`)
    out.security.push(`ALTER TABLE public.${t.relname} ENABLE ROW LEVEL SECURITY;\nREVOKE ALL ON public.${t.relname} FROM PUBLIC, anon, authenticated;`)
    for (const g of await q(`select grantee, string_agg(privilege_type, ', ') privs from information_schema.role_table_grants where table_schema='public' and table_name=$1 and grantee in ('authenticated','service_role') group by 1`, [t.relname]))
      out.security.push(`GRANT ${g.privs} ON public.${t.relname} TO ${g.grantee};`)
    for (const tr of await q(`select pg_get_triggerdef(oid) def, tgname from pg_trigger where tgrelid=$1 and not tgisinternal`, [t.oid]))
      out.triggers.push(`DROP TRIGGER IF EXISTS ${JSON.stringify(tr.tgname)} ON public.${t.relname};\n${tr.def};`)
  }

  const funcs = (await q(`select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) args, pg_get_functiondef(p.oid) def,
      array(select grantee from (select (aclexplode(coalesce(p.proacl, acldefault('f', p.proowner)))).* ) a join pg_roles r on r.oid=a.grantee where privilege_type='EXECUTE') grants_oids
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in ('f','p') order by p.proname`))
    .filter(f => (/^(apt|inv|apa)_/.test(f.proname) || ERP_FUNCS.includes(f.proname)) && !KEEP_WMS.includes(f.proname) && !TMS_ONLY.includes(f.proname))
  for (const f of funcs) {
    const ex = await q(`select r.rolname from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a join pg_roles r on r.oid=a.grantee where p.oid=$1 and a.privilege_type='EXECUTE'`, [f.oid]).catch(() => [])
    const who = ex.map(r => r.rolname).filter(r => ['authenticated', 'service_role'].includes(r))
    out.functions.push({ name: f.proname, sql: f.def.trim() + ';\n' + `REVOKE ALL ON FUNCTION public.${f.proname}(${f.args}) FROM PUBLIC, anon${who.includes('authenticated') ? '' : ', authenticated'};` +
      (who.length ? `\nGRANT EXECUTE ON FUNCTION public.${f.proname}(${f.args}) TO ${who.join(', ')};` : '') })
  }
  for (const v of views) out.views.push(`CREATE OR REPLACE VIEW public.${v.relname} AS\n${(await q('select pg_get_viewdef($1::regclass, true) d', ['public.' + v.relname]))[0].d}`)

  fs.writeFileSync(__dirname + '/esquema.json', JSON.stringify(out, null, 1))
  console.log({ tablas: out.tables.length, secuencias: out.sequences.length, restricciones: out.constraints.length, fks: out.fks.length, indices: out.indexes.length,
    funciones: out.functions.length, vistas: out.views.length, disparadores: out.triggers.length, fk_omitidas: out.fks.filter(x => x.startsWith('--')) })
  await db.end()
})().catch(e => { console.error('ERROR', e.stack); process.exit(1) })
