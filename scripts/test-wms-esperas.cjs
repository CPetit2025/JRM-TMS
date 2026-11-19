// Fase 2.3: esperas con motivo de catálogo, eventos de transición y tiempo activo vs. espera.
// Corre sobre las migraciones reales de wms-db en PGlite, sin credenciales.
const {PGlite}=require('@electric-sql/pglite');
const fs=require('fs');const path=require('node:path');const assert=require('node:assert/strict');
const U={op:'00000000-0000-0000-0000-0000000000b1',pack:'00000000-0000-0000-0000-0000000000b2',sup:'00000000-0000-0000-0000-0000000000b3',lect:'00000000-0000-0000-0000-0000000000b4',nada:'00000000-0000-0000-0000-0000000000b5',op2:'00000000-0000-0000-0000-0000000000b6',baja:'00000000-0000-0000-0000-0000000000b7'};
const OT='00000000-0000-0000-0000-00000000c001',CL='00000000-0000-0000-0000-00000000c100',REQ='00000000-0000-0000-0000-00000000d001';
const feed=[{id:REQ,request_number:'RT-000901',request_type:'DESPACHO',status:'APROBADA',site_code:'PRINCIPAL',delivery_address:'Lima',client:{id:CL,business_name:'Fargoline SAC',ruc:'20111111111'},contract:{id:OT,code:'16544',type:'CONTRATO',client_id:CL},components:[]}];
(async()=>{
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE TABLE auth.users(id uuid primary key); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE SQL STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role; GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC; CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$;`);
 const dir=path.join(__dirname,'../wms-db/supabase/migrations');
 for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir,f),'utf8'));
 const roles={op:['almacen-picking'],pack:['almacen-packing'],sup:['almacen-supervisor'],lect:['almacen-lectura'],nada:[],op2:['almacen-picking'],baja:['almacen-picking']};
 let sql="DELETE FROM public.roles; DELETE FROM public.sites; INSERT INTO public.sites(code,name) VALUES('PRINCIPAL','Local');";
 for(const [k,p] of Object.entries(roles)) sql+=`INSERT INTO public.roles(name,permissions) VALUES('${k}','${JSON.stringify(p)}');`;
 for(const [u,id] of Object.entries(U)) sql+=`INSERT INTO auth.users VALUES('${id}'); INSERT INTO public.profiles(id,email,first_name,role_id,is_active) SELECT '${id}','${u}@x.pe','${u}',id,true FROM public.roles WHERE name='${u}'; INSERT INTO public.user_site_access SELECT '${id}',id FROM public.sites ON CONFLICT DO NOTHING;`;
 await db.exec(sql);
 const KEY='k'.repeat(40);
 await db.exec(`UPDATE public.wh_tms_sync_state SET key_hash=encode(sha256(convert_to('${KEY}','UTF8')),'hex')`);
 const as=async u=>db.exec(`RESET ROLE; SET request.jwt.claim.sub='${U[u]}'; SET ROLE authenticated;`);
 const q=async(s,p=[])=>(await db.query(s,p)).rows;
 const one=async(s,p=[])=>Object.values((await q(s,p))[0]||{})[0];
 const fails=async(s,p,re)=>{try{await db.query(s,p)}catch(e){if(re&&!re.test(e.message))throw Error(`Mensaje inesperado: ${e.message}`);return e.message}throw Error(`Debía fallar: ${s}`)};
 const sys=async s=>{await db.exec('RESET ROLE');const r=await db.exec(s);return r[r.length-1].rows};

 // Tarea desde el feed del TMS y paquetes recibidos (ERP) con distintos casos de peso
 await as('op');
 await q('SELECT public.wh_tms_sync_apply($1,$2::jsonb)',[KEY,JSON.stringify(feed)]);
 const task=(await sys(`SELECT id FROM public.wh_tasks WHERE transport_request_id='${REQ}'`))[0].id;

 const ev=async()=>(await sys(`SELECT event_type FROM public.wh_scan_events WHERE task_id='${task}' AND event_type LIKE 'TASK_%' ORDER BY occurred_at,recorded_at`)).map(r=>r.event_type);
 const back=async(min)=>sys(`UPDATE public.wh_task_waits SET started_at=started_at-interval '${min} minutes', ended_at=ended_at-interval '${min} minutes' WHERE task_id='${task}'`);

 // 1. Sin inicio registrado no hay tiempos (no se infiere)
 await as('lect'); let tm=await one(`SELECT public.wh_task_times('${task}')`);
 assert.equal(tm.inicio,null);assert.equal(tm.activo_min,null);assert.equal(tm.espera_min,null);
 // 2. Iniciar registra evento; esperas: solo responsable o supervisión, durante preparación, una a la vez
 await sys(`UPDATE public.wh_tasks SET assigned_picker='${U.op}' WHERE id='${task}'`);
 await as('op2'); await fails(`SELECT public.wh_task_wait('${task}','START','STOCK')`,[],/Solo el responsable/);
 await as('op'); await fails(`SELECT public.wh_task_wait('${task}','START','STOCK')`,[],/durante la preparación/);
 await q(`SELECT public.wh_task_action('${task}','START_PICKING')`);
 assert.deepEqual(await ev(),['TASK_START_PICKING']);
 await sys(`ALTER TABLE public.wh_scan_events DISABLE TRIGGER wh_scan_immutable; UPDATE public.wh_scan_events SET occurred_at=now()-interval '60 minutes' WHERE task_id='${task}' AND event_type='TASK_START_PICKING'; ALTER TABLE public.wh_scan_events ENABLE TRIGGER wh_scan_immutable;`); await as('op');
 await fails(`SELECT public.wh_task_wait('${task}','START','OTRO')`,[],/Describa/);
 await fails(`SELECT public.wh_task_wait('${task}','START','CAFE')`,[],/check|viola|constraint/i);
 await q(`SELECT public.wh_task_wait('${task}','START','STOCK','Falta SKU en ubicación A1')`);
 await fails(`SELECT public.wh_task_wait('${task}','START','EQUIPO')`,[],/ya tiene una espera abierta/);
 assert.equal((await one("SELECT public.wh_task_board('tareas')")).find(r=>r.id===task).wait_reason,'STOCK');
 await back(30); await q(`SELECT public.wh_task_wait('${task}','END')`);
 await fails(`SELECT public.wh_task_wait('${task}','END')`,[],/No hay una espera abierta/);
 console.log('PASS: esperas con motivo de catálogo, solo responsable o supervisión, una abierta a la vez; el tablero la muestra.');

 // 3. Pausa de supervisión abre espera con motivo de catálogo; reanudar la cierra
 await as('sup'); await q(`SELECT public.wh_task_action('${task}','PAUSE','VEHICULO: unidad no llega')`);
 await as('op'); await fails(`SELECT public.wh_task_wait('${task}','END')`,[],/use Reanudar/);
 let w=(await sys(`SELECT reason_code,note,ended_at FROM public.wh_task_waits WHERE task_id='${task}' ORDER BY id DESC LIMIT 1`))[0];
 assert.deepEqual([w.reason_code,w.note,w.ended_at],['VEHICULO','unidad no llega',null]);
 await back(10); await as('sup'); await q(`SELECT public.wh_task_action('${task}','RESUME')`);
 assert.ok((await sys(`SELECT ended_at FROM public.wh_task_waits WHERE task_id='${task}' ORDER BY id DESC LIMIT 1`))[0].ended_at);
 await q(`SELECT public.wh_task_action('${task}','PAUSE','se fue la luz')`);
 assert.equal((await sys(`SELECT reason_code FROM public.wh_task_waits WHERE task_id='${task}' AND ended_at IS NULL`))[0].reason_code,'OTRO');
 await q(`SELECT public.wh_task_action('${task}','RESUME')`);
 assert.deepEqual(await ev(),['TASK_START_PICKING','TASK_PAUSE','TASK_RESUME','TASK_PAUSE','TASK_RESUME']);
 console.log('PASS: la pausa de supervisión abre una espera (catálogo o «Otro») y reanudar la cierra; cada transición queda como evento.');

 // 4. Tiempos: activo = transcurrido − esperas, por motivo y sin contar esperas fuera del intervalo
 await as('lect'); tm=await one(`SELECT public.wh_task_times('${task}')`);
 assert.ok(tm.inicio);assert.equal(tm.listo_auditoria,null);assert.equal(tm.en_curso,true);
 assert.ok(Number(tm.espera_por_motivo.STOCK)>0 && Number(tm.espera_por_motivo.VEHICULO)>0);
 assert.equal(Math.round((Number(tm.activo_min)+Number(tm.espera_min))*10),Math.round(Number(tm.transcurrido_min)*10));
 assert.ok(Number(tm.activo_min)>=0);
 assert.equal(tm.esperas.length,3);
 console.log('PASS: tiempo activo = transcurrido − esperas, desglosado por motivo; nunca negativo.');

 // 5. Cancelar cierra la espera abierta; anónimos bloqueados
 await as('op'); await q(`SELECT public.wh_task_wait('${task}','START','DOCUMENTACION')`);
 await as('sup'); await q(`SELECT public.wh_task_action('${task}','CANCEL','Solicitud anulada')`);
 assert.equal(Number((await sys(`SELECT count(*) n FROM public.wh_task_waits WHERE task_id='${task}' AND ended_at IS NULL`))[0].n),0);
 await as('nada'); await fails(`SELECT public.wh_task_times('${task}')`,[],/Sin permiso/);
 await db.exec("RESET ROLE; SET request.jwt.claim.sub=''; SET ROLE anon;");
 await fails(`SELECT public.wh_task_wait('${task}','START','STOCK')`,[],/permission denied|permiso/i);
 await fails(`SELECT count(*) FROM public.wh_task_waits`,[],/permission denied/i);
 console.log('PASS: cancelar cierra la espera; anónimos y usuarios sin permiso bloqueados.');
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1)});
