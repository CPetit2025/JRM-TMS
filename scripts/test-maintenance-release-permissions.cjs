const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { PGlite } = require('@electric-sql/pglite')
async function main() {
  const db = new PGlite()
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE profiles(id uuid PRIMARY KEY);
      CREATE TABLE maintenance_work_order_events(created_by uuid REFERENCES profiles);
      CREATE TABLE maintenance_work_order_budget_requests(requested_by uuid REFERENCES profiles,decided_by uuid REFERENCES profiles);
      CREATE TABLE maintenance_work_order_reports(created_by uuid REFERENCES profiles);
      CREATE VIEW vw_work_order_budget_status WITH(security_invoker=true) AS SELECT * FROM maintenance_work_order_budget_requests;
      GRANT ALL ON vw_work_order_budget_status TO anon,authenticated;`)
    await db.exec(readFileSync('supabase/migrations/20261225101000_mantenimiento_acl_indices.sql','utf8'))
    const r=(await db.query(`SELECT has_table_privilege('authenticated','vw_work_order_budget_status','SELECT') AS can_read,
      has_table_privilege('anon','vw_work_order_budget_status','SELECT') AS anonymous_read,
      EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['TRIGGER','TRUNCATE','INSERT','UPDATE','DELETE']) p
        WHERE has_table_privilege(r,'vw_work_order_budget_status',p)) AS dangerous,
      (SELECT reloptions @> ARRAY['security_invoker=true'] FROM pg_class WHERE oid='vw_work_order_budget_status'::regclass) AS invoker,
      (SELECT count(*) FROM pg_constraint c WHERE contype='f' AND connamespace='public'::regnamespace
        AND NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.conrelid AND i.indisvalid AND i.indpred IS NULL
          AND (i.indkey::smallint[])[0:cardinality(c.conkey)-1] @> c.conkey))::int AS uncovered_fk`)).rows[0]
    assert.deepEqual(r,{can_read:true,anonymous_read:false,dangerous:false,invoker:true,uncovered_fk:0})
    console.log('PASS: maintenance budget view is read-only and private, retains invoker RLS, and all actor FKs have full indexes')
  } finally {await db.close()}
}
main().catch(error=>{console.error(error);process.exitCode=1})
