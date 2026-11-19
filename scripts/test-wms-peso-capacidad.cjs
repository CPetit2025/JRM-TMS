// Fase 2.1: peso con fuente y estado (recepción ERP = confirmado, maestro = calculado, sin dato = provisional,
// diferencia > 5 % = en revisión), tipos de unidad de carga y alerta de capacidad por peso, pallets y volumen que
// nunca bloquea. Corre sobre las migraciones reales de wms-db en PGlite, sin credenciales.
const {PGlite}=require('@electric-sql/pglite');
const fs=require('fs');const path=require('node:path');const assert=require('node:assert/strict');
const U={op:'00000000-0000-0000-0000-0000000000b1',pack:'00000000-0000-0000-0000-0000000000b2',sup:'00000000-0000-0000-0000-0000000000b3',lect:'00000000-0000-0000-0000-0000000000b4',nada:'00000000-0000-0000-0000-0000000000b5'};
const OT='00000000-0000-0000-0000-00000000c001',CL='00000000-0000-0000-0000-00000000c100',REQ='00000000-0000-0000-0000-00000000d001';
const feed=[{id:REQ,request_number:'RT-000901',request_type:'DESPACHO',status:'APROBADA',site_code:'PRINCIPAL',delivery_address:'Lima',client:{id:CL,business_name:'Fargoline SAC',ruc:'20111111111'},contract:{id:OT,code:'16544',type:'CONTRATO',client_id:CL},components:[]}];
(async()=>{
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE TABLE auth.users(id uuid primary key); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE SQL STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role; GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC; CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$;`);
 const dir=path.join(__dirname,'../wms-db/supabase/migrations');
 for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir,f),'utf8'));
 const roles={op:['almacen-picking'],pack:['almacen-packing'],sup:['almacen-supervisor'],lect:['almacen-lectura'],nada:[]};
 let sql="DELETE FROM public.roles; DELETE FROM public.sites; INSERT INTO public.sites(code,name) VALUES('PRINCIPAL','Local');";
 for(const [k,p] of Object.entries(roles)) sql+=`INSERT INTO public.roles(name,permissions) VALUES('${k}','${JSON.stringify(p)}');`;
 for(const [u,id] of Object.entries(U)) sql+=`INSERT INTO auth.users VALUES('${id}'); INSERT INTO public.profiles(id,email,first_name,role_id,is_active) SELECT '${id}','${u}@x.pe','${u}',id,true FROM public.roles WHERE name='${u}'; INSERT INTO public.user_site_access SELECT '${id}',id FROM public.sites ON CONFLICT DO NOTHING;`;
 // Maestro de SKU: A con peso y m³, B solo peso, C sin datos
 sql+=`INSERT INTO public.erp_sku_medidas(cod_producto,producto,peso_unit,m3_unit) VALUES('PRD-A','Estante A',2.5,0.01),('PRD-B','Estante B',1,NULL);`;
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
 await sys(`UPDATE public.wh_tasks SET status='PACKING' WHERE id='${task}'`);
 const pkg=(code,prd,qty,kg)=>`INSERT INTO public.wh_packages(package_code,source_document_no,source_contract_code,source_lot,source_product_code,source_warehouse,source_date,source_movement_key,source_key,site_id,description,quantity,unit,weight_kg,task_id,status) SELECT '${code}','IPT-1','16544','16544-S001','${prd}','APT','2026-11-07','mk-${code}','sk-${code}',id,'Paquete ${code}',${qty},'UN',${kg===null?'NULL':kg},'${task}','PICKED' FROM public.sites;`;
 await sys(pkg('P1','PRD-A',10,25)+pkg('P2','PRD-A',10,30)+pkg('P3','PRD-B',5,null)+pkg('P4','PRD-C',3,null)+pkg('P5','PRD-A',4,10.2)+pkg('P6','PRD-A',2,0));
 const lpn=c=>`INSERT INTO public.wh_lpns(lpn_code,site_id,task_id,status) SELECT '${c}',id,'${task}','CLOSED' FROM public.sites RETURNING id`;
 const L1=(await sys(lpn('LPN-1')))[0].id,L2=(await sys(lpn('LPN-2')))[0].id,L3=(await sys(lpn('LPN-3')))[0].id;
 await sys(`UPDATE public.wh_packages SET lpn_id='${L1}' WHERE package_code IN ('P1','P5'); UPDATE public.wh_packages SET lpn_id='${L2}' WHERE package_code IN ('P2','P3'); UPDATE public.wh_packages SET lpn_id='${L3}' WHERE package_code IN ('P4','P6');`);

 // 1. Estado del peso por paquete
 const w=Object.fromEntries((await sys(`SELECT p.package_code,w.* FROM public.wh_packages p CROSS JOIN LATERAL public.wh_package_weight(p) w`)).map(r=>[r.package_code,r]));
 assert.equal(w.P1.estado,'CONFIRMADO');assert.equal(Number(w.P1.kg),25);assert.equal(w.P1.fuente,'RECEPCION_ERP');assert.equal(Number(w.P1.m3),0.1);
 assert.equal(w.P2.estado,'EN_REVISION','30 kg frente a 25 kg del maestro: 20 % de diferencia');
 assert.equal(w.P5.estado,'CONFIRMADO','10,2 kg frente a 10 kg: dentro del 5 %');
 assert.equal(w.P3.estado,'CALCULADO');assert.equal(Number(w.P3.kg),5);assert.equal(w.P3.fuente,'MAESTRO_SKU');assert.equal(w.P3.m3,null);
 assert.equal(w.P4.estado,'PROVISIONAL');assert.equal(w.P4.kg,null,'sin peso no es 0');assert.equal(w.P4.fuente,'SIN_DATO');
 assert.equal(w.P6.estado,'CALCULADO','un peso registrado en 0 es «sin dato» y toma el maestro');assert.equal(Number(w.P6.kg),5);
 console.log('PASS: peso por paquete: confirmado, en revisión (>5 %), calculado por maestro, provisional sin dato y 0 tratado como sin dato.');

 // 2. Resumen por LPN: peor estado, kg conocidos, paquetes sin peso y sin m³
 const lw=async id=>(await sys(`SELECT public.wh_lpn_weight('${id}') AS w`))[0].w;
 const w1=await lw(L1),w2=await lw(L2),w3=await lw(L3);
 assert.deepEqual([w1.estado,Number(w1.kg),w1.sin_peso,Number(w1.m3),w1.sin_m3],['CONFIRMADO',35.2,0,0.14,0]);
 assert.deepEqual([w2.estado,Number(w2.kg),w2.en_revision,w2.sin_m3],['EN_REVISION',35,1,1]);
 assert.deepEqual([w3.estado,Number(w3.kg),w3.sin_peso],['PROVISIONAL',5,1]);
 console.log('PASS: resumen por LPN con el peor estado, sin sumar como 0 los pesos desconocidos.');

 // 3. Maestro de tipos de unidad: solo supervisión, validaciones
 await as('pack'); await fails(`SELECT public.wh_vehicle_type_save('CAMION_S','Camión pequeño',50,2,NULL)`,[],/Solo supervisión/);
 await as('sup');
 await fails(`SELECT public.wh_vehicle_type_save('x','Mal',1,1,1)`,[],/Código no válido/);
 await fails(`SELECT public.wh_vehicle_type_save('CAMION_X','Cero',0,1,1)`,[],/mayores que cero/);
 await q(`SELECT public.wh_vehicle_type_save('camion_s','Camión pequeño',50,2,NULL)`);
 await q(`SELECT public.wh_vehicle_type_save('FURGON','Furgón',100,NULL,1)`);
 await q(`SELECT public.wh_vehicle_type_save('BAJA','Unidad dada de baja',10,1,1,false)`);
 assert.equal(await one(`SELECT count(*)::int FROM public.wh_vehicle_types`),3);
 await as('lect'); assert.equal(await one(`SELECT count(*)::int FROM public.wh_vehicle_types`),3,'lectura ve el catálogo');
 await as('nada'); assert.equal(await one(`SELECT count(*)::int FROM public.wh_vehicle_types`),0,'sin permiso no ve el catálogo');
 console.log('PASS: tipos de unidad solo los configura supervisión; código y capacidades validados; lectura los consulta.');

 // 4. Unidades con tipo y capacidad excedida en peso y pallets: alerta, sin bloquear
 await as('pack');
 const UT1=(await one(`SELECT public.wh_load_unit_add('${task}','ABC123')`)).id;
 await q(`SELECT public.wh_load_unit_set_type('${UT1}','CAMION_S')`);
 await fails(`SELECT public.wh_load_unit_set_type('${UT1}','BAJA')`,[],/no disponible/);
 await fails(`SELECT public.wh_load_unit_set_type('${UT1}','NO_EXISTE')`,[],/no disponible/);
 await as('op'); await fails(`SELECT public.wh_load_unit_set_type('${UT1}','FURGON')`,[],/Sin permiso/);
 await sys(`UPDATE public.wh_lpns SET load_unit_id='${UT1}' WHERE id IN ('${L1}','${L2}','${L3}')`);
 await as('lect');
 let c=await one(`SELECT public.wh_task_capacity('${task}')`);
 let u1=c.unidades[0];
 assert.equal(Number(u1.kg),75.2);assert.equal(Number(u1.pallets),3);
 assert.deepEqual(u1.excede,['peso','pallets']);
 assert.ok(u1.no_calculable.some(m=>/Volumen: el tipo de unidad no tiene capacidad/.test(m)));
 assert.ok(u1.no_calculable.some(m=>/1 paquete\(s\) sin peso/.test(m)));
 assert.equal(u1.uso_m3,null);assert.equal(u1.peso_estado,'PROVISIONAL');
 assert.match(c.tarea.alerta,/solicite una unidad adicional/);
 assert.deepEqual(c.tarea.excede,['peso','pallets']);
 assert.equal(c.lpns.length,3);
 console.log('PASS: capacidad excedida en peso y pallets genera la alerta; las dimensiones sin dato se informan y no se inventan.');

 // 5. Reparto que entra en capacidad, unidad sin tipo y LPN sin unidad: sin alerta de exceso, con avisos
 await as('pack');
 const UT2=(await one(`SELECT public.wh_load_unit_add('${task}',NULL)`)).id;
 await q(`SELECT public.wh_load_unit_set_type('${UT2}','FURGON')`);
 const UT3=(await one(`SELECT public.wh_load_unit_add('${task}',NULL)`)).id;
 await sys(`UPDATE public.wh_lpns SET load_unit_id=NULL; UPDATE public.wh_lpns SET load_unit_id='${UT1}' WHERE id='${L1}'; UPDATE public.wh_lpns SET load_unit_id='${UT2}' WHERE id='${L2}';`);
 await as('lect');
 c=await one(`SELECT public.wh_task_capacity('${task}')`);
 const byLabel=Object.fromEntries(c.unidades.map(x=>[x.label,x]));
 assert.deepEqual(byLabel.UT1.excede,[]);assert.equal(Number(byLabel.UT1.uso_kg),70.4);assert.equal(Number(byLabel.UT1.uso_pallets),50);
 assert.deepEqual(byLabel.UT2.excede,[]);assert.equal(byLabel.UT2.uso_m3,null,'un LPN con paquete sin m³ no permite calcular el uso de volumen');
 assert.ok(byLabel.UT3.no_calculable.includes('Sin tipo de unidad: no se conoce su capacidad'));
 assert.equal(c.tarea.sin_unidad_pallets,1);assert.equal(Number(c.tarea.sin_unidad_kg),5);
 assert.equal(c.tarea.capacidad_kg,null,'una unidad sin tipo impide sumar la capacidad total');
 assert.equal(c.tarea.alerta,null);
 // El volumen conocido ya supera la capacidad: alerta aunque falte el m³ de un paquete (el uso sigue no calculable)
 await sys("UPDATE public.wh_vehicle_types SET capacity_m3=0.05 WHERE code='FURGON'");
 await as('lect'); const c2=await one(`SELECT public.wh_task_capacity('${task}')`); const u2=c2.unidades.find(x=>x.label==='UT2');
 assert.deepEqual(u2.excede,['volumen']);assert.equal(u2.uso_m3,null);assert.match(c2.tarea.alerta,/unidad adicional/);
 await sys("UPDATE public.wh_vehicle_types SET capacity_m3=1 WHERE code='FURGON'");
 console.log('PASS: reparto dentro de capacidad sin alerta; unidad sin tipo y LPN sin unidad se informan; la capacidad total no se inventa.');

 // 6. Nunca bloquea: la asignación y la carga existentes no consultan capacidad
 const src=await one(`SELECT string_agg(pg_get_functiondef(p.oid),' ') FROM pg_proc p WHERE p.proname IN ('wh_lpns_assign_unit','wh_lpn_assign_unit','wh_record_scan','wh_record_scan_core','wh_refresh_packing_list','wh_release_packing_list','wh_audit_lpn')`);
 assert.ok(src&&src.length>1000,'las funciones del flujo deben existir');assert.ok(!/wh_task_capacity|wh_vehicle_types|wh_lpn_weight|wh_package_weight/.test(src),'la alerta de capacidad no debe bloquear ningún paso del flujo');
 console.log('PASS: la alerta no interviene en asignación, escaneo, liberación ni auditoría (no bloquea).');

 // 7. Permisos de la consulta
 await as('nada'); await fails(`SELECT public.wh_task_capacity('${task}')`,[],/Sin permiso/);
 await db.exec(`RESET ROLE; SET request.jwt.claim.sub=''; SET ROLE anon;`);
 await fails(`SELECT public.wh_task_capacity('${task}')`,[],/permission denied|permiso/i);
 await fails(`SELECT public.wh_vehicle_type_save('A1','x',1,1,1)`,[],/permission denied|permiso/i);
 console.log('PASS: capacidad y maestro bloqueados para anónimos y usuarios sin permiso WMS.');
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1)});
