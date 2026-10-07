// Reuse the production-like transport fixture without duplicating its evolving setup.
// No connection to production: every query runs in a disposable PostgreSQL container.
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const fixture = path.join(__dirname, 'test-delivery-conformity.cjs')
const source = fs.readFileSync(fixture, 'utf8')
const marker = '\n} catch(error) {'
if (!source.includes(marker)) throw new Error('Transport fixture integration point changed')
const extension = `
  // New flow migrations are applied after historical regression fixtures, so the
  // mandatory lead-time policy does not invalidate unrelated legacy test input.
  const flowMigrations = require('node:fs').readdirSync(path.join(root,'supabase/migrations'))
    .filter(file => /^20261009.*\\.sql$/.test(file)).sort();
  assert.ok(flowMigrations.length, 'Transport flow migrations exist');
  // Exercise existing projects whose pgcrypto was installed outside extensions.
  sql('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;');
  // Reproduce the production timestamp type before exercising new anticipation guards.
  sql("ALTER TABLE public.transport_requests ALTER COLUMN required_date TYPE timestamptz USING required_date::timestamp AT TIME ZONE 'UTC';");
  // Add only live columns missing from the intentionally narrow historical fixture.
  const productionShape=read('scripts/security/production-shape.sql');
  sql('SET check_function_bodies=off;');
  const augment=[];
  for (const table of productionShape.matchAll(/CREATE TABLE public\\."([^\"]+)" \\(([\\s\\S]*?)\\);/g)) {
    for(const column of table[2].split(',\\n')) {
      const match=column.match(/^"([^\"]+)" (.*)$/); if(!match)continue;
      const identifier=value=>String.fromCharCode(34)+value+String.fromCharCode(34);
      augment.push("DO $$BEGIN IF to_regclass('public."+table[1]+"') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='"+table[1]+"' AND column_name='"+match[1]+"') THEN ALTER TABLE public."+identifier(table[1])+" ADD COLUMN "+identifier(match[1])+" "+match[2].replace(/ PRIMARY KEY/g,'')+"; END IF; END$$;");
    }
  }
  sql(augment.join('\\n'));
  sql("ALTER TABLE public.transport_request_events ADD CONSTRAINT flow_fixture_action_check CHECK (action IN ('CREATED','UPDATED','STATUS_CHANGED')); UPDATE public.sites SET code='FIXTURE-'||id::text WHERE code IS NULL; ALTER TABLE public.sites ALTER COLUMN code SET NOT NULL;");

  sql(installed('supabase/migrations/20261007150000_request_optional_pickup_details.sql','save_transport_request')+
      installed('supabase/migrations/20261007150000_request_optional_pickup_details.sql','set_transport_request_status'));
  const security=read('supabase/migrations/20261008020000_production_security_boundaries.sql');
  const active=security.indexOf('CREATE OR REPLACE FUNCTION public.is_active_tms_user(');
  sql(security.slice(active,security.indexOf('$$;',active)+3));
  const siteScope=read('supabase/migrations/000172_site_scopes.sql');
  const siteHelper=siteScope.indexOf('CREATE OR REPLACE FUNCTION public.can_access_site(');
  sql(siteScope.slice(siteHelper,siteScope.indexOf('$$;',siteHelper)+3).replaceAll('p_site_id','site'));
  for(const file of flowMigrations){sql(read('supabase/migrations/'+file));console.log('APPLIED: '+file);}
  const flowTests=require('node:fs').readdirSync(path.join(root,'supabase/tests'))
    .filter(file => /^caja_c(?:56|57|58|59)_.*\\.test\\.sql$/.test(file)).sort();
  assert.ok(flowTests.length>=4, 'Lead-time, permanent portal economic flow and historical documents SQL suites exist');
  for(const file of flowTests){const result=query(read('supabase/tests/'+file));
    const number=file.match(/^caja_c(\\d+)_/)[1];
    assert.match(result.stderr,new RegExp('CAJA C'+number+' PASS'),result.stderr||result.stdout);
    console.log('PASS: '+file);
  }
`
const runner = new Module(fixture, module)
runner.filename = fixture
runner.paths = Module._nodeModulePaths(__dirname)
let integrated = source.replace(marker, () => extension + marker)
if (process.env.TRANSPORT_FLOW_KEEP_DB === 'true') {
  integrated = integrated.replace("spawnSync('docker',['rm','-f',name],{encoding:'utf8'})", "console.log('LOCAL FIXTURE: '+name)")
}
runner._compile(integrated, fixture)
