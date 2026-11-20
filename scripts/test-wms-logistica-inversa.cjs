// Inventario y Logística Inversa · fases 3 a 6: ubicaciones, bloqueo, existencias, conteo ciego, ajustes autorizados,
// expedientes de retorno, recepción, inspección por fracción, disposición, reproceso con balance y cierre. PGlite.
const {PGlite}=require('@electric-sql/pglite');
const fs=require('fs');const path=require('node:path');const assert=require('node:assert/strict');
const U={op:'00000000-0000-0000-0000-0000000000b1',pack:'00000000-0000-0000-0000-0000000000b2',sup:'00000000-0000-0000-0000-0000000000b3',lect:'00000000-0000-0000-0000-0000000000b4',nada:'00000000-0000-0000-0000-0000000000b5',op2:'00000000-0000-0000-0000-0000000000b6',baja:'00000000-0000-0000-0000-0000000000b7',inv:'00000000-0000-0000-0000-0000000000c1',rec:'00000000-0000-0000-0000-0000000000c2'};
const OT='00000000-0000-0000-0000-00000000c001',CL='00000000-0000-0000-0000-00000000c100',REQ='00000000-0000-0000-0000-00000000d001';
const feed=[{id:REQ,request_number:'RT-000901',request_type:'DESPACHO',status:'APROBADA',site_code:'PRINCIPAL',delivery_address:'Lima',client:{id:CL,business_name:'Fargoline SAC',ruc:'20111111111'},contract:{id:OT,code:'16544',type:'CONTRATO',client_id:CL},components:[]}];
(async()=>{
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE TABLE auth.users(id uuid primary key); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE SQL STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role; GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC; CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$;`);
 const dir=path.join(__dirname,'../wms-db/supabase/migrations');
 for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir,f),'utf8'));
 const roles={op:['almacen-picking'],pack:['almacen-packing'],sup:['almacen-supervisor'],lect:['almacen-lectura'],nada:[],op2:['almacen-picking'],baja:['almacen-picking'],inv:['almacen-lectura','almacen-inventario'],rec:['almacen-etiquetado']};
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
 const J=x=>JSON.stringify(x);
 const site=(await sys(`SELECT id FROM public.sites LIMIT 1`))[0].id;
 const pkg=(code,qty,kg)=>`INSERT INTO public.wh_packages(package_code,source_document_no,source_contract_code,source_lot,source_product_code,source_warehouse,source_date,source_movement_key,source_key,site_id,description,quantity,unit,weight_kg,status) VALUES ('${code}','IPT-1','16544','16544-S001','PRD-A','647-04 ALM PT','2026-11-07','mk-${code}','sk-${code}','${site}','Paquete',${qty},'UND',${kg},'AVAILABLE');`;

 // ===== Fase 3 · Ubicaciones, bloqueo, existencias =====
 await as('op'); await fails(`SELECT public.wh_location_save('A1','Rack A1')`,[],/Solo supervisión o Inventario/);
 await as('inv'); await q(`SELECT public.wh_location_save('a1','Rack A1','zona a')`); await q(`SELECT public.wh_location_save('B1','Rack B1')`);
 await sys(pkg('P1',10,100)+pkg('P2',5,50));
 await as('rec'); let m=await one(`SELECT public.wh_package_locate('P1','A1','ingreso')`); assert.equal(m.moved,1);
 await one(`SELECT public.wh_package_locate('P1','B1','reubicación')`);
 assert.equal((await sys(`SELECT count(*)::int n FROM public.wh_scan_events WHERE event_type='MOVE'`))[0].n,2,'cada traslado queda con origen y destino');
 await fails(`SELECT public.wh_package_locate('NOEXISTE','A1')`,[],/Código desconocido/);
 await as('inv'); await fails(`SELECT public.wh_package_hold('P1','BLOQUEADO','')`,[],/motivo/);
 await q(`SELECT public.wh_package_hold('P1','BLOQUEADO','Golpe visible, revisar')`);
 await fails(`UPDATE public.wh_packages SET status='PICKED' WHERE package_code='P1'`,[],/permission denied|bloqueado/i);
 await assert.rejects(sys(`UPDATE public.wh_packages SET status='PICKED' WHERE package_code='P1'`),/bloqueado/);
 await as('lect'); let st=(await one(`SELECT public.wh_stock_query(NULL,NULL,NULL)`)).rows;
 const b1=st.find(x=>x.ubicacion==='B1'); let sin=st.find(x=>x.ubicacion==='SIN UBICACIÓN');
 assert.deepEqual([Number(b1.fisico),Number(b1.bloqueado),Number(b1.disponible)],[10,10,0]);
 assert.deepEqual([Number(sin.fisico),Number(sin.disponible)],[5,5]);
 await sys(`UPDATE public.wh_packages SET task_id=(SELECT id FROM public.wh_tasks LIMIT 1) WHERE package_code='P2'`);
 sin=(await one(`SELECT public.wh_stock_query(NULL,NULL,NULL)`)).rows.find(x=>x.ubicacion==='SIN UBICACIÓN');
 assert.deepEqual([Number(sin.reservado),Number(sin.disponible)],[5,0],'reservado en tarea no es disponible; sin restar dos veces');
 console.log('PASS: ubicaciones y traslados trazables; bloqueo impide picking; disponible = físico − reservado − bloqueado.');

 // ===== Fase 3 · Conteo ciego y ajustes =====
 await sys(`INSERT INTO public.erp_imports(id,kind,status,file_name,expected) VALUES ('00000000-0000-0000-0000-0000000e0009','STOCK','ACTIVA','s.xlsx',1);
   INSERT INTO public.wh_count_campaigns(id,code,site_id,bodega,erp_import_id,created_by) VALUES ('00000000-0000-0000-0000-0000000c0001','INV-1','${site}','647-04 ALM PT','00000000-0000-0000-0000-0000000e0009','${U.sup}');
   INSERT INTO public.wh_count_expected(campaign_id,linea,cod_producto,producto,lote,lote_key,stock) VALUES ('00000000-0000-0000-0000-0000000c0001',1,'PRD-A','Poste','16544-S001','16544-S001',12);`);
 const CAMP='00000000-0000-0000-0000-0000000c0001';
 await as('rec'); let s=await one(`SELECT public.wh_count_summary('${CAMP}')`);
 assert.equal(s[0].expected,null); assert.equal(s[0].result,'CIEGO','quien cuenta no ve el esperado durante el conteo');
 assert.equal((await one(`SELECT public.wh_count_expected_search('${CAMP}',NULL)`))[0].stock,null);
 await as('inv'); s=await one(`SELECT public.wh_count_summary('${CAMP}')`); assert.equal(Number(s[0].expected),12,'Inventario sí ve el esperado');
 await fails(`SELECT public.wh_adjustment_request('${CAMP}','PRD-A','16544-S001','Faltante tras reconteo')`,[],/en revisión o cerrada/);
 await sys(`UPDATE public.wh_count_campaigns SET status='EN_REVISION' WHERE id='${CAMP}'`);
 await as('inv'); await fails(`SELECT public.wh_adjustment_request('${CAMP}','PRD-A','16544-S001','corto')`,[],/check|viola|constraint/i);
 const adj=(await one(`SELECT public.wh_adjustment_request('${CAMP}','PRD-A','16544-S001','Faltante confirmado tras reconteo','Merma por manipulación')`)).id;
 await fails(`SELECT public.wh_adjustment_request('${CAMP}','PRD-A','16544-S001','Faltante confirmado tras reconteo')`,[],/ajuste vigente/);
 await fails(`SELECT public.wh_adjustment_decide('${adj}','APPROVE')`,[],/Solo Jefatura/);
 await sys(`UPDATE public.roles SET permissions='["almacen-lectura","almacen-inventario","almacen-supervisor"]' WHERE name='inv'`);
 await as('inv'); await fails(`SELECT public.wh_adjustment_decide('${adj}','APPROVE')`,[],/Nadie autoriza el ajuste que solicitó/);
 await sys(`UPDATE public.roles SET permissions='["almacen-lectura","almacen-inventario"]' WHERE name='inv'`);
 await as('inv'); await fails(`SELECT public.wh_adjustment_decide('${adj}','ERP','AJ-ERP-1')`,[],/autorizado/);
 await as('sup'); await q(`SELECT public.wh_adjustment_decide('${adj}','APPROVE','Autorizado')`);
 await as('inv'); await q(`SELECT public.wh_adjustment_decide('${adj}','ERP','AJUSTE ERP 0045')`);
 const la=(await one(`SELECT public.wh_adjustments_list(NULL)`)).adjustments[0];
 assert.deepEqual([la.estado,Number(la.diferencia),la.erp_ref],['REGISTRADO_ERP',-12,'AJUSTE ERP 0045']);
 console.log('PASS: conteo ciego; ajuste nace de la diferencia, lo solicita Inventario, lo autoriza Jefatura (nunca quien pidió) y se registra en el ERP.');

 // ===== Fases 4–6 · Logística inversa =====
 const up='00000000-0000-0000-0000-0000000a0001';
 const mv=(n,num,prd,cant,kg)=>`('${up}','E',true,${n},'GUIA DE RECOJO','DEVOLUCION','540-04 APT LB','${num}','2026-10-21','20600467124','CLIENTE SAC','${prd}','Material ${prd}',${cant},'UND','16339-S019','16339',${kg===null?'NULL':kg})`;
 await sys(`INSERT INTO public.inv_uploads(id,side,file_name,status) VALUES ('${up}','E','e.xlsx','APLICADA');
   INSERT INTO public.inv_movements(upload_id,side,active,linea,tipodocto,clase,bodega,numero,fecha,cod_legal,razon_social,producto,glosa,cantidad,unidad,lote,ot,peso_kg) VALUES
   ${mv(1,'T001-9','PRD-R1',10,100)},${mv(2,'T001-9','PRD-R2',5,null)},${mv(3,'T001-9','PRD-R3',2,20)},
   ('${up}','E',true,4,'P/E PRODUCCION ACT.','PRODUCCION','540-04 APT LB','P-1','2026-10-21',NULL,NULL,'PRD-Z','Prod',3,'UND',NULL,NULL,9);
   SELECT wms_private.inv_assign_mkey(NULL);`);
 await as('inv'); let list=await one(`SELECT public.wh_returns_list(NULL,NULL)`);
 assert.equal(list.length,1,'un expediente por guía de recojo; la producción no entra'); const R=list[0].id; assert.equal(list[0].lineas,3); assert.equal(list[0].status,'RECIBIDO_ERP');
 await one(`SELECT public.wh_returns_list(NULL,NULL)`); assert.equal((await one(`SELECT public.wh_returns_list(NULL,NULL)`)).length,1,'sincronizar es idempotente');
 await q(`SELECT public.wh_return_update('${R}','saldo_obra','rt-000777',NULL,NULL,'Saldo de obra Lurín')`);
 const det=async()=>one(`SELECT public.wh_return_detail('${R}')`);
 let d=await det(); assert.equal(d.motivo,'SALDO_OBRA'); assert.equal(d.tms_request_number,'RT-000777');
 const [L1,L2,L3]=d.lines.map(x=>x.id);
 // ERP da de baja la línea 3: se marca para conciliar y no se recibe
 await sys(`UPDATE public.inv_movements SET active=false WHERE producto='PRD-R3'`); await as('inv'); await one(`SELECT public.wh_returns_list(NULL,NULL)`);
 d=await det(); assert.equal(d.lines.find(x=>x.id===L3).erp_state,'BAJA_ERP');
 await as('rec'); await fails(`SELECT public.wh_return_receive(${L3},2,20,'BALANZA')`,[],/dada de baja en el ERP/);
 await fails(`SELECT public.wh_return_receive(${L1},10,98,'')`,[],/cómo se obtuvo el peso/);
 const rc=await one(`SELECT public.wh_return_receive(${L1},10,98,'BALANZA',true,'Llegó con film roto')`);
 assert.equal(rc.status,'EN_RECEPCION','recepción parcial: falta la línea 2'); assert.ok(rc.package_code);
 assert.equal((await sys(`SELECT hold_status FROM public.wh_packages WHERE package_code='${rc.package_code}'`))[0].hold_status,'CUARENTENA','el retorno no queda disponible');
 await assert.rejects(sys(`UPDATE public.wh_packages SET status='PICKED' WHERE package_code='${rc.package_code}'`),/cuarentena/);
 await q(`SELECT public.wh_return_receive(${L2},5,NULL,'ESTIMADO',false)`);
 assert.equal((await det()).status,'PENDIENTE_INSPECCION');
 console.log('PASS: expediente automático por guía, vínculo manual con el RECOJO del TMS, recepción parcial con método de peso y etiqueta en cuarentena; bajas del ERP marcadas.');

 // Inspección por fracción (motivo, condición y disposición separados)
 await as('inv');
 await fails(`SELECT public.wh_return_inspect(${L1},$1::jsonb)`,[J([{qty:8,condition:'UTILIZABLE'},{qty:3,condition:'DANADO'}])],/superan lo recibido/);
 await q(`SELECT public.wh_return_inspect(${L1},$1::jsonb)`,[J([{qty:6,condition:'UTILIZABLE'},{qty:3,condition:'REQUIERE_REPROCESO'},{qty:1,condition:'DANADO',finding:'Doblado'}])]);
 await q(`SELECT public.wh_return_inspect(${L2},$1::jsonb)`,[J([{qty:5,condition:'UTILIZABLE'}])]);
 d=await det(); const fr=d.lines.find(x=>x.id===L1).fractions; const [F1,F2,F3]=fr.map(x=>x.id); const F4=d.lines.find(x=>x.id===L2).fractions[0].id;
 assert.equal(Number(fr[0].kg),58.8,'kg de la fracción proporcional a lo recibido'); assert.equal(d.status,'EN_DISPOSICION');
 // Disposición: propone Inventario, autoriza Jefatura (nunca quien propuso)
 await fails(`SELECT public.wh_return_disposition(${F3},'PROPOSE','REINCORPORAR','Cliente lo pide')`,[],/Solo material utilizable/);
 for(const [f,disp] of [[F1,'REINCORPORAR'],[F2,'REPROCESAR'],[F3,'BAJA'],[F4,'REINCORPORAR']]) await q(`SELECT public.wh_return_disposition(${f},'PROPOSE','${disp}','Decisión del Analista')`);
 await fails(`SELECT public.wh_return_disposition(${F1},'APPROVE')`,[],/Solo Jefatura/);
 await as('sup'); for(const f of [F1,F2,F3,F4]) await q(`SELECT public.wh_return_disposition(${f},'APPROVE')`);
 await as('rec'); await q(`SELECT public.wh_return_disposition(${F1},'EXECUTE',NULL,'Ubicado en A1')`); await q(`SELECT public.wh_return_disposition(${F4},'EXECUTE')`); await q(`SELECT public.wh_return_disposition(${F3},'EXECUTE',NULL,'Chatarra')`);
 await fails(`SELECT public.wh_return_disposition(${F1},'VERIFY')`,[],/Sin permiso|Quien ejecutó no verifica/);
 await fails(`SELECT public.wh_return_disposition(${F2},'EXECUTE')`,[],/orden de reproceso/);
 await as('inv'); await q(`SELECT public.wh_return_disposition(${F1},'VERIFY')`); await q(`SELECT public.wh_return_disposition(${F4},'VERIFY')`);
 console.log('PASS: inspección por fracción sin superar lo recibido; disposición propuesta por Inventario, autorizada por Jefatura y verificada por otra persona.');

 // Reproceso con balance de masa, ciclos y verificación independiente
 const RP=(await one(`SELECT public.wh_reprocess('CREATE',NULL,ARRAY[${F2}]::bigint[],$1::jsonb)`,[J({objective:'Enderezar',executor_type:'EXTERNO',executor_name:'Taller Ejemplo'})])).id;
 assert.equal((await det()).status,'EN_TRATAMIENTO');
 await as('rec'); await q(`SELECT public.wh_reprocess('START','${RP}')`);
 await fails(`SELECT public.wh_reprocess('FINISH','${RP}',NULL,$1::jsonb)`,[J({kg_added:2,kg_recovered:20,kg_waste:5})],/balance no cuadra/);
 await q(`SELECT public.wh_reprocess('FINISH','${RP}',NULL,$1::jsonb)`,[J({kg_added:2,kg_recovered:25,kg_waste:6.4})]);
 await fails(`SELECT public.wh_reprocess('VERIFY','${RP}')`,[],/Sin permiso|no lo verifica/);
 await as('inv'); await q(`SELECT public.wh_reprocess('VERIFY','${RP}',NULL,$1::jsonb)`,[J({note:'Conforme'})]);
 const o=(await det()).reprocesos[0]; assert.deepEqual([o.status,Number(o.kg_input),Number(o.kg_recovered),Number(o.kg_diff)],['VERIFICADA',29.4,25,0]);
 console.log('PASS: reproceso con balance de masa (entrada + insumos = recuperado + residuo + diferencia explicada) y verificación por otra persona.');

 // Cierre conciliado; el paquete con una fracción dada de baja sigue en cuarentena (no se reincorpora completo)
 d=await det(); assert.equal(d.status,'RESUELTO');
 await q(`SELECT public.wh_return_close('${R}','Conciliado')`);
 assert.equal((await det()).status,'CERRADO');
 await as('rec'); await fails(`SELECT public.wh_return_receive(${L2},5,NULL,'ESTIMADO')`,[],/cerrado/);
 const ev=(await det()).events.map(e=>e.action); assert.ok(ev.includes('RECIBIR')&&ev.includes('INSPECCIONAR')&&ev.includes('CERRAR'));
 // No anunciado: provisional, bloqueado hasta regularizar
 await as('rec'); const pv=(await one(`SELECT public.wh_return_provisional('Obra Chilca','Bobinas sin rótulo',4,'UNID',NULL)`)).id;
 await as('inv'); const dp=await one(`SELECT public.wh_return_detail('${pv}')`); assert.equal(dp.status,'PROVISIONAL'); assert.equal(dp.lines[0].unidad,'UND'); assert.equal(dp.lines[0].kg_declared,null);
 await fails(`SELECT public.wh_return_close('${pv}')`,[],/No se puede cerrar/);
 // ===== Fase 7 · Indicadores =====
 await as('lect'); const today=(await sys(`SELECT (now() AT TIME ZONE 'America/Lima')::date::text d`))[0].d;
 const K=Object.fromEntries((await one(`SELECT public.wh_inventory_kpis('2026-10-01',$1::date)`,[today])).kpis.map(k=>[k.code,k]));
 assert.equal(Number(K.R1.value),1); assert.equal(Number(K.R2.value),0.1); assert.equal(K.R2.sin_peso,1,'la línea sin peso no suma 0');
 assert.equal(Number(K.R7.num),83.8); assert.equal(Number(K.R7.den),98); assert.equal(Number(K.R7.value),85.5,'recuperación = reincorporado + recuperado verificado / recibido de la cohorte');
 assert.equal(Number(K.P2.value),79.6,'rendimiento = recuperado / (entrada + insumos)');
 assert.equal(Number(K.B1.value),0.01); assert.equal(Number(K.C3.value),1); assert.equal(K.C1.state,'SIN_REGISTROS','sin campañas cerradas no hay exactitud (no es 0 %)');
 assert.equal(K.P1.state,'SIN_REGISTROS');
 const DR=await one(`SELECT public.wh_inventory_kpi_detail('R2','2026-10-01',$1::date)`,[today]); assert.equal(DR.filter(x=>x.erp!=='BAJA_ERP').length,2,'el detalle concilia con el total de líneas');
 console.log('PASS: indicadores de retornos, reprocesos, bajas y ajustes con numerador, denominador y estados honestos; el detalle concilia.');
 // Permisos e historial
 await fails(`UPDATE public.wh_return_events SET comment='x'`,[],/permission denied|inmutable|historial/i);
 await as('nada'); await fails(`SELECT public.wh_returns_list(NULL,NULL)`,[],/Sin permiso/);
 await db.exec("RESET ROLE; SET request.jwt.claim.sub=''; SET ROLE anon;");
 await fails(`SELECT public.wh_return_receive(1,1,1,'BALANZA')`,[],/permission denied/i);
 console.log('PASS: cierre conciliado con historial; no anunciado queda provisional; anónimos y usuarios sin permiso bloqueados.');
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1)});
