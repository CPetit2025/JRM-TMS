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
 // Número de bulto correlativo por lote: el primer ingreso del lote empieza en B-0001.
 if(codes.join()!=='LOCAL-LOT-B-0001,LOCAL-LOT-B-0002') throw Error('Bultos must be numbered per lot from B-0001: '+codes.join());
 // Regenerar las etiquetas del mismo ingreso reutiliza sus números y no deja saltos en la serie del lote.
 const relabel=(await db.query('SELECT public.wh_label_package($1,$2,$3) AS labels',['local-receipt',2,5])).rows[0].labels.package_codes;
 if(relabel.join()!==codes.join()) throw Error('Relabeling must keep the same bulto numbers: '+relabel.join());
 await db.exec('RESET ROLE');
 const last=(await db.query("SELECT last_no FROM public.wh_bulto_counters WHERE lot='LOCAL-LOT'")).rows[0].last_no;
 await db.exec('SET ROLE authenticated');
 if(last!==2) throw Error('Relabeling must not advance the lot counter: '+last);
 // El nombre debe existir al generar/vista previa, antes de auditar la primera impresión.
 const pendingCustomer=(await db.query('SELECT * FROM public.wh_receipt_control_customers($1::text[])',[['local-receipt']])).rows;
 if(pendingCustomer.length!==1||pendingCustomer[0].customer_name!=='Local customer') throw Error('Customer missing before first print');
 const originalCustomerFunction=(await db.query("SELECT pg_get_functiondef('public.inv_ot_cliente(text)'::regprocedure) AS definition")).rows[0].definition;
 // Aislar la resolución por lote, sin depender de OT ni del snapshot de recepción.
 await db.exec("RESET ROLE; UPDATE public.wh_receipt_sources SET customer_name=NULL,lot='16573' WHERE source_key='local-receipt'; UPDATE public.wh_packages SET source_lot='16573' WHERE source_movement_key='local-receipt'; CREATE OR REPLACE FUNCTION public.inv_ot_cliente(p_raiz text) RETURNS text LANGUAGE sql STABLE AS $$ SELECT CASE WHEN $1='16573' THEN 'Cliente del lote' END $$; SET ROLE authenticated;");
 const lotCustomer=(await db.query('SELECT * FROM public.wh_receipt_control_customers($1::text[])',[['local-receipt']])).rows;
 if(lotCustomer[0]?.customer_name!=='Cliente del lote') throw Error('Lot customer fallback missing');
 await db.exec("RESET ROLE; UPDATE public.wh_receipt_sources SET customer_name='Local customer',lot='LOCAL-LOT' WHERE source_key='local-receipt'; UPDATE public.wh_packages SET source_lot='LOCAL-LOT' WHERE source_movement_key='local-receipt';");
 await db.exec(originalCustomerFunction); await db.exec('SET ROLE authenticated');
 console.log('PASS: customer present before first print, including lot fallback.');
 // Regla: la bandeja solo muestra pendientes de etiquetar (sin etiqueta o con etiquetas sin imprimir)
 const inbox=async q=>(await db.query('SELECT public.wh_receipt_candidates($1) AS rows',[q])).rows[0].rows;
 if((await inbox('')).map(r=>r.label_status).join()!=='PENDING_PRINT') throw Error('Unprinted labels must stay in the inbox');
 await db.query('SELECT public.wh_print_labels($1::text[])',[codes]);
 if((await inbox('')).length!==0||(await inbox('LOCAL-IPT')).length!==0) throw Error('Completed receptions must not appear in the inbox, even when searched');
 let direct=false;try{await db.query('SELECT public.wh_receipt_candidates_all($1)',[''])}catch(e){direct=e.message.includes('permission denied')}
 if(!direct) throw Error('wh_receipt_candidates_all must not be callable by users');
 await db.query('SELECT * FROM public.wh_receipt_control_operators($1::text[])',[['local-receipt']]);
 await db.query('SELECT * FROM public.wh_receipt_control_customers($1::text[])',[['local-receipt']]);
 const counts=await db.query('SELECT count(*)::int as packages FROM public.wh_packages WHERE label_print_count=1');
 if(counts.rows[0].packages!==2) throw Error('Print audit missing');
 await db.exec("RESET ROLE; UPDATE public.profiles SET first_name='Carlos',last_name='Petit' WHERE id='00000000-0000-0000-0000-000000000001'; SET ROLE authenticated;");
 const responsibleRows=(await db.query('SELECT * FROM public.wh_package_label_responsibles($1::text[])',[codes])).rows;
 if(responsibleRows.length!==2||responsibleRows.some(r=>r.responsible_name!=='Carlos Petit')) throw Error('Responsible must match the logged-in creator stored on each package');
 console.log('PASS: authenticated import -> inbox -> validation -> 2 labels -> print audit -> receipt control.');
 // Robot de ingresos: automática cada 30 min, solicitud manual única, nunca dos ejecuciones a la vez
 const q1=async(sql,p=[])=>(await db.query(sql,p)).rows[0];
 const due=async()=>(await q1('SELECT public.wh_receipt_robot_due() AS d')).d;
 if(!(await due())) throw Error('Robot must be due on an empty history');
 const auto=(await q1('SELECT public.wh_receipt_robot_start() AS r')).r;
 if(await due()) throw Error('Robot must not be due while running');
 if(auto?.kind!=='AUTO') throw Error('First robot cycle must open an AUTO run');
 if((await q1('SELECT public.wh_receipt_robot_start() AS r')).r!==null) throw Error('Robot started twice');
 const req=(await q1('SELECT public.wh_receipt_robot_request() AS r')).r;
 if(req.existing!==true) throw Error('Manual request while running must return the open run');
 await db.query('SELECT public.wh_receipt_robot_finish($1,true,$2)',[auto.id,'OK prueba']);
 if((await q1('SELECT public.wh_receipt_robot_start() AS r')).r!==null) throw Error('AUTO run repeated before 30 minutes');
 if(await due()) throw Error('Robot must not be due right after an AUTO run');
 const manual=(await q1('SELECT public.wh_receipt_robot_request() AS r')).r;
 if(!(await due())) throw Error('Robot must be due with a manual request');
 const again=(await q1('SELECT public.wh_receipt_robot_request() AS r')).r;
 if(manual.existing||again.id!==manual.id) throw Error('Manual request must be single');
 const taken=(await q1('SELECT public.wh_receipt_robot_start() AS r')).r;
 if(taken?.id!==manual.id||taken.kind!=='MANUAL') throw Error('Robot did not take the manual request');
 await db.query('SELECT public.wh_receipt_robot_finish($1,false,$2)',[manual.id,'ERROR prueba']);
 await db.exec("RESET ROLE; UPDATE public.wh_receipt_robot_runs SET started_at=started_at-interval '31 minutes' WHERE id>0; SET ROLE authenticated;");
 if((await q1('SELECT public.wh_receipt_robot_start() AS r')).r?.kind!=='AUTO') throw Error('AUTO run not due after 30 minutes');
 await db.exec("RESET ROLE; UPDATE public.wh_receipt_robot_runs SET started_at=started_at-interval '31 minutes' WHERE status='RUNNING'; SET ROLE authenticated;");
 await q1('SELECT public.wh_receipt_robot_start() AS r');
 const stale=await q1("SELECT count(*)::int AS n FROM public.wh_receipt_robot_runs WHERE status='ERROR' AND message LIKE 'El robot no informó%'");
 if(stale.n!==1) throw Error('Stale RUNNING run was not closed');
 console.log('PASS: receipt robot runs every 30 min, single manual request, no overlap, stale runs closed.');
 // «Actualizar ahora» del ERP desde el WMS y estado público del banner.
 const erpDue=async()=>(await q1('SELECT public.erp_robot_due() AS r')).r;
 if(await erpDue()) throw Error('ERP robot must not be due without a request');
 const erpReq=(await q1('SELECT public.erp_robot_request() AS r')).r, erpAgain=(await q1('SELECT public.erp_robot_request() AS r')).r;
 if(erpReq.existing||erpAgain.id!==erpReq.id||!(await erpDue())) throw Error('ERP manual request must be single and due');
 const erpRun=(await q1('SELECT public.erp_robot_start() AS r')).r;
 if(erpRun?.id!==erpReq.id||(await q1('SELECT public.erp_robot_start() AS r')).r!==null) throw Error('ERP robot must take the request once');
 await db.query('SELECT public.erp_robot_finish($1,true,$2)',[erpRun.id,'OK carga ERP']);
 console.log('PASS: Actualizar ahora del ERP en el WMS: solicitud única, robot sin solaparse.');
 await db.exec('RESET ROLE; SET ROLE anon');
 const pub=(await q1('SELECT public.wh_public_update_status() AS r')).r;
 if(!pub.ingresos||!pub.erp||pub.erp.request?.status!=='OK'||!pub.ingresos.last_error_at||!pub.ingresos.last_auto_at) throw Error('Public update status incomplete: '+JSON.stringify(pub));
 if(Object.keys(pub).sort().join()!=='erp,ingresos,now') throw Error('Public update status must expose only dates and states');
 let erpDenied=false;try{await db.query('SELECT public.erp_robot_request()')}catch(e){erpDenied=e.message.includes('permission denied')}
 if(!erpDenied)throw Error('Anonymous ERP request was not denied');
 await db.query('SELECT public.erp_robot_due()');
 console.log('PASS: estado público del banner (solo fechas y estados) y solicitud ERP cerrada a anónimos.');
 let denied=false;try {await db.query('SELECT * FROM public.wh_packages')}catch(e){denied=e.message.includes('permission denied')}
 if(!denied) throw Error('Anonymous data access was not denied');
 denied=false;try{await db.query('SELECT public.wh_receipt_candidates($1)',[''])}catch(e){denied=e.message.includes('permission denied')}
 if(!denied)throw Error('Anonymous RPC was not denied');
 denied=false;try{await db.query('SELECT public.wh_receipt_robot_request()')}catch(e){denied=e.message.includes('permission denied')}
 if(!denied)throw Error('Anonymous robot request was not denied');
 await db.query('SELECT public.wh_receipt_robot_due()');
 await db.exec('RESET ROLE; UPDATE public.profiles SET is_active=false; SET ROLE authenticated;');
 const inactive=await db.query('SELECT count(*)::int AS n FROM public.wh_packages');
 if(inactive.rows[0].n!==0) throw Error('Inactive user can read packages');
 console.log('PASS: anonymous table/RPC access and inactive account reads are blocked.');
 // A different warehouse operator may read the original name only for packages in authorized sites.
 await db.exec(`RESET ROLE; UPDATE public.profiles SET is_active=true WHERE id='00000000-0000-0000-0000-000000000001';
 INSERT INTO auth.users VALUES ('00000000-0000-0000-0000-000000000003');
 INSERT INTO public.roles(id,name,permissions) VALUES ('00000000-0000-0000-0000-000000000004','Etiquetador','["almacen-etiquetado"]');
 INSERT INTO public.profiles(id,email,first_name,last_name,role_id,is_active) VALUES ('00000000-0000-0000-0000-000000000003','other@example.test','Otro','Usuario','00000000-0000-0000-0000-000000000004',true);
 INSERT INTO public.user_site_access(user_id,site_id) SELECT '00000000-0000-0000-0000-000000000003',id FROM public.sites ON CONFLICT DO NOTHING;
 SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-000000000003';`);
 const invisibleProfile=(await db.query("SELECT count(*)::int AS n FROM public.profiles WHERE id='00000000-0000-0000-0000-000000000001'")).rows[0].n;
 if(invisibleProfile!==0) throw Error('Profile RLS must remain unchanged');
 const originals=(await db.query('SELECT * FROM public.wh_package_label_responsibles($1::text[])',[codes])).rows;
 if(originals.length!==2||originals.some(r=>r.responsible_name!=='Carlos Petit')) throw Error('Reprint must preserve original responsible for non-admin users');
 const expectCustomerDenied=async keys=>{let blocked=false;try{await db.query('SELECT * FROM public.wh_receipt_control_customers($1::text[])',[keys])}catch{blocked=true}if(!blocked)throw Error('Customer lookup should be denied');};
 await expectCustomerDenied(Array(101).fill('local-receipt'));
 let invalid=false;try{await db.query('SELECT * FROM public.wh_package_label_responsibles($1::text[])',[Array(101).fill(codes[0])])}catch{invalid=true}if(!invalid)throw Error('Unbounded responsible query allowed');
 await db.exec(`RESET ROLE; UPDATE public.roles SET permissions='[]' WHERE id='00000000-0000-0000-0000-000000000004'; SET ROLE authenticated;`);
 await expectCustomerDenied(['local-receipt']);
 let noWarehouse=false;try{await db.query('SELECT * FROM public.wh_package_label_responsibles($1::text[])',[codes])}catch{noWarehouse=true}if(!noWarehouse)throw Error('Non-warehouse user may read responsible');
 await db.exec(`RESET ROLE; UPDATE public.roles SET permissions='["almacen-etiquetado"]' WHERE id='00000000-0000-0000-0000-000000000004'; DELETE FROM public.user_site_access; SET ROLE authenticated;`);
 if((await db.query('SELECT * FROM public.wh_package_label_responsibles($1::text[])',[codes])).rows.length) throw Error('Names leaked across unauthorized sites');
 await expectCustomerDenied(['local-receipt']);
 await db.exec("RESET ROLE; UPDATE public.profiles SET is_active=false WHERE id='00000000-0000-0000-0000-000000000003'; SET ROLE authenticated;");
 await expectCustomerDenied(['local-receipt']);
 let blocked=false;try{await db.query('SELECT * FROM public.wh_package_label_responsibles($1::text[])',[codes])}catch{blocked=true}if(!blocked)throw Error('Inactive user may read responsible');
 await db.exec('RESET ROLE; SET ROLE anon');await expectCustomerDenied(['local-receipt']);blocked=false;try{await db.query('SELECT * FROM public.wh_package_label_responsibles($1::text[])',[codes])}catch{blocked=true}if(!blocked)throw Error('Anonymous user may read responsible');
 console.log('PASS: original responsible survives another user; site, profile RLS, inactive and anonymous access respected.');
 await db.close();
})().catch(e=>{console.error(e.message);process.exit(1)});
