// Fase 2.2: asignación planificada por supervisión (responsable, prioridad, compromiso, historial con motivo).
// Asignar no inicia la tarea. Corre sobre las migraciones reales de wms-db en PGlite, sin credenciales.
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

 await sys("UPDATE public.profiles SET is_active=false WHERE email='baja@x.pe'");
 const status0=(await sys(`SELECT status FROM public.wh_tasks WHERE id='${task}'`))[0].status;

 // 1. Solo supervisión planifica; la lista de responsables excluye inactivos y sin permiso
 await as('op'); await fails(`SELECT public.wh_task_plan('${task}','${U.op}','ALTA',NULL)`,[],/Solo supervisión/);
 await fails(`SELECT public.wh_task_assignees('${task}')`,[],/Solo supervisión/);
 await as('sup');
 const names=(await one(`SELECT public.wh_task_assignees('${task}')`)).map(x=>x.name).sort();
 assert.deepEqual(names,['op','op2','sup']);
 console.log('PASS: solo supervisión planifica; responsables posibles = activos con picking o supervisión en la sede.');

 // 2. Asignar con prioridad y compromiso no inicia la tarea
 const due='2026-11-20T15:00:00Z';
 await fails(`SELECT public.wh_task_plan('${task}','${U.lect}','ALTA',NULL)`,[],/no está activo o no tiene permiso/);
 await fails(`SELECT public.wh_task_plan('${task}','${U.baja}','ALTA',NULL)`,[],/no está activo o no tiene permiso/);
 await fails(`SELECT public.wh_task_plan('${task}','${U.op}','MAXIMA',NULL)`,[],/Prioridad no válida/);
 await q(`SELECT public.wh_task_plan('${task}','${U.op}','alta','${due}')`);
 let t=(await sys(`SELECT * FROM public.wh_tasks WHERE id='${task}'`))[0];
 assert.equal(t.assigned_picker,U.op);assert.equal(t.assigned_by,U.sup);assert.equal(t.priority,'ALTA');assert.equal(new Date(t.committed_at).toISOString(),new Date(due).toISOString());
 assert.equal(t.status,status0,'asignar no inicia la tarea');
 console.log('PASS: asignación con asignador, prioridad y compromiso; el estado de la tarea no cambia.');

 // 3. Reasignar y mover el compromiso exigen motivo; cambiar solo la prioridad no
 await fails(`SELECT public.wh_task_plan('${task}','${U.op2}','ALTA','${due}')`,[],/motivo de la reasignación/);
 await fails(`SELECT public.wh_task_plan('${task}',NULL,'ALTA','2026-11-21T15:00:00Z')`,[],/motivo para cambiar el compromiso/);
 await q(`SELECT public.wh_task_plan('${task}',NULL,'URGENTE','${due}')`);
 assert.equal((await one(`SELECT public.wh_task_plan('${task}',NULL,'URGENTE','${due}')`)).changed,false,'sin cambios no registra evento');
 await q(`SELECT public.wh_task_plan('${task}','${U.op2}','URGENTE','2026-11-21T15:00:00Z','Operador op con licencia')`);
 console.log('PASS: reasignar y mover el compromiso exigen motivo; repetir sin cambios no duplica el historial.');

 // 4. Tomar la tarea por sí mismo también registra el asignador; el historial se lee completo
 await sys(`UPDATE public.wh_tasks SET assigned_picker=NULL WHERE id='${task}'`);
 await as('op'); await q(`SELECT public.wh_assign_task('${task}')`);
 assert.equal((await sys(`SELECT assigned_by FROM public.wh_tasks WHERE id='${task}'`))[0].assigned_by,U.op);
 await as('lect');
 const hist=await one(`SELECT public.wh_task_assignment_history('${task}')`);
 assert.equal(hist.length,4);
 assert.deepEqual(hist.map(h=>h.type),['TASK_ASSIGNED','TASK_PLANNED','TASK_PLANNED','TASK_PLANNED']);
 const re=hist[1];assert.equal(re.by,'sup');assert.equal(re.to,'op2');assert.equal(re.previous,'op');assert.equal(re.reason,'Operador op con licencia');assert.equal(re.previous_priority,'URGENTE');
 assert.equal(hist[2].previous_priority,'ALTA');assert.equal(hist[2].priority,'URGENTE');
 assert.equal(hist[0].to,'op');
 const row=(await one("SELECT public.wh_task_board('tareas')")).find(r=>r.id===task);
 assert.equal(row.priority,'URGENTE');assert.ok(row.committed_at);assert.equal(row.assigned_by_name,'op');
 console.log('PASS: historial con asignador, anterior, motivo y cambios de prioridad; el tablero muestra prioridad, compromiso y asignador.');

 // 5. Tarea cerrada no se planifica; anónimos y sin permiso bloqueados
 await sys(`UPDATE public.wh_tasks SET status='CANCELLED' WHERE id='${task}'`);
 await as('sup'); await fails(`SELECT public.wh_task_plan('${task}',NULL,'BAJA',NULL,'x')`,[],/tarea cerrada/);
 await as('nada'); await fails(`SELECT public.wh_task_assignment_history('${task}')`,[],/Sin permiso/);
 await db.exec("RESET ROLE; SET request.jwt.claim.sub=''; SET ROLE anon;");
 await fails(`SELECT public.wh_task_plan('${task}',NULL,'BAJA',NULL)`,[],/permission denied|permiso/i);
 console.log('PASS: tareas cerradas no se planifican; anónimos y usuarios sin permiso WMS bloqueados.');
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1)});
