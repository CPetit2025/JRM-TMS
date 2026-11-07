const {PGlite}=require('@electric-sql/pglite');
const fs=require('fs'); const path=require('node:path');
(async()=>{
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE TABLE auth.users(id uuid primary key); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE SQL STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role; GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC;`);
 const migrationDir=path.join(__dirname,'../wms-db/supabase/migrations');
 await db.exec(`CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$;`);
 for(const file of fs.readdirSync(migrationDir).filter(f=>f.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(migrationDir,file),'utf8'));
 await db.exec("DELETE FROM public.sites; DELETE FROM public.roles;");
 console.log('PASS: standalone schema installs on an empty database.');
 await db.exec(`INSERT INTO auth.users VALUES ('00000000-0000-0000-0000-000000000001'); INSERT INTO public.roles(id,name,permissions) VALUES('00000000-0000-0000-0000-000000000002','Administrador','[]'); INSERT INTO public.sites(code,name) VALUES ('PRINCIPAL','Local WMS'); INSERT INTO public.profiles(id,email,role_id,is_active) VALUES ('00000000-0000-0000-0000-000000000001','local@example.com','00000000-0000-0000-0000-000000000002',true); SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';`);
 const data=[{source_key:'local-receipt',document_no:'LOCAL-IPT',source_date:'2026-11-07',warehouse:'APT',customer_name:'Local customer',product_code:'TEST',description:'Local test product',quantity:10,unit:'UN',lot:'LOCAL-LOT',contract_code:'LOCAL-OT',color:'AZUL',document_type:'IPT'}];
 await db.query('SELECT public.wh_import_receipt_snapshot($1,$2,$3::jsonb)', ['local.xlsx','a'.repeat(64),JSON.stringify(data)]);
 const candidates=await db.query('SELECT public.wh_receipt_candidates($1) AS rows',['']);
 if(candidates.rows[0].rows.length!==1) throw Error('Receipt missing from inbox');
 await db.query('SELECT public.wh_validate_receipt($1,$2,$3,$4)',['local-receipt',10,null,null]);
 const labels=await db.query('SELECT public.wh_label_package($1,$2,$3) AS labels',['local-receipt',2,5]);
 const codes=labels.rows[0].labels.package_codes;
 if(codes.length!==2) throw Error('Wrong label count');
 await db.query('SELECT public.wh_print_labels($1::text[])',[codes]);
 await db.query('SELECT * FROM public.wh_receipt_control_operators($1::text[])',[['local-receipt']]);
 await db.query('SELECT * FROM public.wh_receipt_control_customers($1::text[])',[['local-receipt']]);
 const counts=await db.query('SELECT count(*)::int as packages FROM public.wh_packages WHERE label_print_count=1');
 if(counts.rows[0].packages!==2) throw Error('Print audit missing');
 console.log('PASS: authenticated import -> inbox -> validation -> 2 labels -> print audit -> receipt control.');
 await db.exec('RESET ROLE; SET ROLE anon');
 let denied=false;try {await db.query('SELECT * FROM public.wh_packages')}catch(e){denied=e.message.includes('permission denied')}
 if(!denied) throw Error('Anonymous data access was not denied');
 denied=false;try{await db.query('SELECT public.wh_receipt_candidates($1)',[''])}catch(e){denied=e.message.includes('permission denied')}
 if(!denied)throw Error('Anonymous RPC was not denied');
 await db.exec('RESET ROLE; UPDATE public.profiles SET is_active=false; SET ROLE authenticated;');
 const inactive=await db.query('SELECT count(*)::int AS n FROM public.wh_packages');
 if(inactive.rows[0].n!==0) throw Error('Inactive user can read packages');
 console.log('PASS: anonymous table/RPC access and inactive account reads are blocked.');
 await db.close();
})().catch(e=>{console.error(e.message);process.exit(1)});
