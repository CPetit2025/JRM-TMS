// request_service_types con permisos evaluados una vez: mismo filtro por admin, permiso y sede que antes.
const { PGlite } = require('@electric-sql/pglite')
const fs = require('node:fs'), assert = require('node:assert/strict')
const shape = fs.readFileSync('scripts/security/production-shape.sql', 'utf8')
const table = name => { const s = shape.indexOf(`CREATE TABLE public."${name}" (`); assert.ok(s >= 0, name); return shape.slice(s, shape.indexOf(';', s) + 1) }
;(async () => { const db = new PGlite(); try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
  ${['transport_requests', 'dispatch_requests', 'dispatches'].map(table).join('\n')}
  -- columnas que existen en producción pero no en la foto production-shape.sql
  ALTER TABLE public.transport_requests ADD COLUMN IF NOT EXISTS supplier_id uuid, ADD COLUMN IF NOT EXISTS request_type text,
    ADD COLUMN IF NOT EXISTS contract_id uuid, ADD COLUMN IF NOT EXISTS reference_type text, ADD COLUMN IF NOT EXISTS reference_number text,
    ADD COLUMN IF NOT EXISTS purchase_order text;
  CREATE TABLE public.suppliers(id uuid PRIMARY KEY, business_name text);
  CREATE FUNCTION public.is_tms_admin() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.admin',true)='1'$$;
  CREATE FUNCTION public.has_tms_read_permission(text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.perm',true)=$1$$;
  CREATE FUNCTION public.can_view_driver_evidence() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
  CREATE FUNCTION public.can_access_site(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT $1::text=current_setting('test.site',true)$$;`)
  await db.exec(fs.readFileSync('supabase/migrations/20261231160000_request_service_types_rapido.sql', 'utf8'))
  const cols = async t => (await db.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name=$1 AND is_nullable='NO' AND column_default IS NULL`, [t])).rows
  const fill = async (t, vals) => { // completa columnas NOT NULL sin valor por defecto
    for (const c of await cols(t)) if (!(c.column_name in vals)) vals[c.column_name] = c.data_type === 'uuid' ? crypto.randomUUID() : /int|numeric|double/.test(c.data_type) ? 0 : /bool/.test(c.data_type) ? false : /timestamp|date/.test(c.data_type) ? new Date().toISOString() : 'X'
    const k = Object.keys(vals); await db.query(`INSERT INTO public.${t}(${k.join(',')}) VALUES(${k.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(vals))
  }
  const A = '00000000-0000-4000-8000-00000000000a', B = '00000000-0000-4000-8000-00000000000b'
  const r1 = crypto.randomUUID(), r2 = crypto.randomUUID(), r3 = crypto.randomUUID()
  for (const id of [r1, r2, r3]) await fill('transport_requests', { id })
  const d1 = crypto.randomUUID(), d2 = crypto.randomUUID()
  await fill('dispatches', { id: d1, site_id: A }); await fill('dispatches', { id: d2, site_id: B })
  await fill('dispatch_requests', { dispatch_id: d1, transport_request_id: r1 }); await fill('dispatch_requests', { dispatch_id: d2, transport_request_id: r2 })
  const run = async (o) => { for (const [k, v] of Object.entries({ uid: crypto.randomUUID(), admin: '0', perm: 'despacho', site: A, ...o })) await db.query(`SELECT set_config('test.${k}',$1,false)`, [v])
    return (await db.query('SELECT public.request_service_types($1::uuid[]) v', [[r1, r2, r3]])).rows[0].v.map(x => x.id).sort() }
  assert.deepEqual(await run({ admin: '1' }), [r1, r2, r3].sort(), 'admin ve todo')
  assert.deepEqual(await run({}), [r1], 'solo solicitudes con despacho en sede accesible')
  assert.deepEqual(await run({ site: B }), [r2])
  assert.deepEqual(await run({ perm: 'otro' }), [], 'sin permiso no ve nada')
  assert.deepEqual(await run({ uid: '', admin: '1' }), [], 'sin sesión no ve nada')
  console.log('PASS request_service_types: admin, permiso por llamada, sede por despacho y sin sesión')
} finally { await db.close() } })().catch(e => { console.error(e); process.exit(1) })
