// Alta rápida de proveedor y conductor/operador desde la asignación de tercerización (PGlite, sin producción).
const { PGlite } = require('@electric-sql/pglite')
const { readFileSync } = require('node:fs')
const assert = require('node:assert/strict')
;(async () => {
 const db = new PGlite()
 try {
  // Restricciones e índices únicos reales de producción.
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '00000000-0000-4000-8000-000000000001'::uuid $$;
   CREATE FUNCTION has_tms_permission(p text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.permission',true) IN ('admin',p)$$;
   CREATE TABLE suppliers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tax_id text NOT NULL UNIQUE CHECK (tax_id ~ '^[0-9]{11}$'),business_name text NOT NULL CHECK (btrim(business_name)<>''),
    category text NOT NULL CHECK (category IN ('MATERIA_PRIMA','INSUMOS','PRODUCCION','PROYECTOS','SERVICIOS','OTROS','TRANSPORTE','MONTACARGA','GRUA','ESTIBA')),
    contact_name text,contact_phone text,contact_email text,notes text,is_active boolean NOT NULL DEFAULT true,created_by uuid DEFAULT auth.uid(),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
   CREATE TABLE supplier_personnel(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),supplier_id uuid NOT NULL REFERENCES suppliers,full_name text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 3 AND 200),
    document_number text CHECK (document_number IS NULL OR length(document_number)<=30),position text,phone text,email text,license_number text,license_expiration date,notes text,
    is_active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
   CREATE UNIQUE INDEX supplier_personnel_document_unique ON supplier_personnel(supplier_id,document_number) WHERE document_number IS NOT NULL AND btrim(document_number)<>'';
   INSERT INTO suppliers(id,tax_id,business_name,category,is_active) VALUES('00000000-0000-4000-8000-000000000009','20100000001','INACTIVO SAC','SERVICIOS',false);
   SELECT set_config('test.permission','compras-tercerizaciones',false);`)
  await db.exec(readFileSync('supabase/migrations/20261231120000_outsourcing_quick_register.sql', 'utf8'))
  const reg = (service, p) => db.query('SELECT outsourcing_quick_register($1,$2) id', [service, p]).then(r => r.rows[0].id)
  const sup = await reg('FLETE', { tax_id: '20512345678', business_name: ' transportes qa sac ', contact_phone: '999' })
  const row = (await db.query('SELECT category,business_name,contact_phone FROM suppliers WHERE id=$1', [sup])).rows[0]
  assert.deepEqual(row, { category: 'TRANSPORTE', business_name: 'TRANSPORTES QA SAC', contact_phone: '999' }, 'proveedor con categoría del servicio')
  assert.equal((await db.query('SELECT category FROM suppliers WHERE id=$1', [await reg('MONTACARGAS', { tax_id: '20512345679', business_name: 'Montacargas QA' })])).rows[0].category, 'MONTACARGA')
  assert.equal((await db.query('SELECT category FROM suppliers WHERE id=$1', [await reg('GRUA', { tax_id: '20512345680', business_name: 'Grúas QA' })])).rows[0].category, 'GRUA')
  await assert.rejects(reg('FLETE', { tax_id: '20512345678', business_name: 'Otra' }), /ya está registrado: TRANSPORTES QA SAC \(categoría TRANSPORTE\)/, 'RUC duplicado')
  await assert.rejects(reg('FLETE', { tax_id: '20100000001', business_name: 'Otra' }), /categoría SERVICIOS, inactivo/, 'RUC inactivo')
  await assert.rejects(reg('FLETE', { tax_id: '123', business_name: 'Otra' }), /RUC de 11/, 'RUC inválido')
  await assert.rejects(reg('XX', { tax_id: '20512345681', business_name: 'Otra' }), /Servicio inválido/)
  const person = await reg('FLETE', { supplier_id: sup, full_name: 'Juan Pérez', document_number: '12345678', license_number: 'Q12345678', license_expiration: '2027-05-01' })
  assert.deepEqual((await db.query('SELECT supplier_id,position,license_expiration::text exp FROM supplier_personnel WHERE id=$1', [person])).rows[0], { supplier_id: sup, position: 'Conductor', exp: '2027-05-01' })
  await assert.rejects(reg('FLETE', { supplier_id: sup, full_name: 'Juan Pérez', document_number: '12345678' }), /ya está registrado para TRANSPORTES QA SAC/, 'documento duplicado')
  await assert.rejects(reg('FLETE', { supplier_id: sup, full_name: 'Ana', document_number: '12' }), /documento de identidad/)
  await assert.rejects(reg('FLETE', { supplier_id: '00000000-0000-4000-8000-000000000009', full_name: 'Ana Ruiz', document_number: '87654321' }), /proveedor activo/, 'proveedor inactivo')
  await db.exec("INSERT INTO suppliers(id,tax_id,business_name,category) VALUES('00000000-0000-4000-8000-000000000008','20100000002','INSUMOS SAC','INSUMOS')")
  await assert.rejects(reg('OTROS', { supplier_id: '00000000-0000-4000-8000-000000000008', full_name: 'Ana Ruiz', document_number: '87654321' }), /no corresponde a este servicio/, 'proveedor comercial')
  const crane = await reg('GRUA', { tax_id: '20512345683', business_name: 'Grúas Dos' })
  await assert.rejects(reg('FLETE', { supplier_id: crane, full_name: 'Ana Ruiz', document_number: '87654321' }), /no corresponde a este servicio/, 'categoría de otro servicio')
  await db.query("SELECT set_config('test.permission','despacho',false)")
  await assert.rejects(reg('FLETE', { tax_id: '20512345682', business_name: 'Sin permiso' }), /Sin permiso/, 'solo Compras')
  console.log('PASS quick register: categoría por servicio, duplicados, inactivos, formatos y permiso')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exitCode = 1 })
