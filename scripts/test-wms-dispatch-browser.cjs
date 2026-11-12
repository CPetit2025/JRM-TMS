// Prueba del flujo por etapas contra una API local: no usa datos ni credenciales reales.
const assert = require('node:assert/strict'), fs = require('node:fs'), http = require('node:http'), { spawn } = require('node:child_process'), { chromium } = require('playwright')
const artifactDir = (process.env.LABEL_ARTIFACT_DIR || '/tmp/wms-dispatch-artifacts') + '/despacho-submodulos'
const uid = '00000000-0000-4000-8000-000000000001'
const user = { id: uid, email: 'qa@example.test', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} }
const token = [{ alg: 'HS256', typ: 'JWT' }, { sub: uid, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now()/1000)+3600 }, 'signature'].map((x,i) => i<2 ? Buffer.from(JSON.stringify(x)).toString('base64url') : x).join('.')
const session = { access_token: token, refresh_token: 'qa-refresh', expires_at: Math.floor(Date.now()/1000)+3600, expires_in: 3600, token_type: 'bearer', user }
let role = { name: 'Administrador', permissions: ['almacen-supervisor'] }
const task = { id: 'task-1', task_code: 'TASK-QA', status: 'PICKING', request_status: 'APROBADA', request_number: 'RT-QA-001', transport_request_id: 'request-1', required_date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' }) /* el tablero muestra por defecto solo las de hoy */, required_at: null, created_at: '2026-11-09T13:00:00Z', contract_code: 'OT-QA', components: '', lots: 'L1', client_name: 'Cliente de prueba', delivery_address: 'Almacén', assigned_picker: uid, picker_name: 'Operario QA', assigned_at: '2026-11-09T13:00:00Z', picked: 2, loose: 0, lpn_total: 2, lpn_approved: 0, lpn_observed: 0, lpn_rejected: 0, lpn_pending: 2, weight_kg: 10, packing_list: null, display_state: 'EN_PICKING' }
const lpn = i => ({ id: `lpn-${i}`, lpn_code: `LPN-QA-${i}`, status: 'CLOSED', audit_status: 'PENDIENTE', audit_rev: 0, package_count: 1, quantity: 5, weight_kg: 5, created_by_name: 'Operario QA', created_at: task.created_at, print_count: 1, audits: [], packages: [{ package_code: `PKG-QA-${i}`, product_code: 'SKU-1', description: 'Producto QA', lot: 'L1', quantity: 5, unit: 'UND', weight_kg: 5 }] })
const history = [] // tareas extra del historial de Picking (p_scope = 'historial')
const data = { lpns: [lpn(1)], loose: [...lpn(2).packages,...lpn(3).packages], packing_lists: [] }, units = [], calls = []
function emitDocument() {
 if(task.status !== 'READY_FOR_LOAD' || data.loose.length || data.lpns.some(l=>l.audit_status!=='APROBADO') || data.packing_lists.length) return
 const snapshot={...task,packing_list_number:'PL-QA',version:1,prepared_at:task.assigned_at,auditor_name:'Auditor QA',released_at:new Date().toISOString(),lpn_count:2,package_count:3,total_weight_kg:15,lpns:structuredClone(data.lpns)}
 data.packing_lists=[{id:'pl-1',packing_list_number:'PL-QA',version:1,status:'LIBERADO',snapshot}];task.packing_list={id:'pl-1',number:'PL-QA',version:1};task.display_state='LIBERADO'
}
const api = http.createServer(async (req,res) => {
  res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Headers','*'); res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS'); res.setHeader('Content-Type','application/json')
  if(req.method==='OPTIONS') return res.end()
  let body=''; for await(const c of req) body+=c
  const path=new URL(req.url,'http://localhost').pathname, p=body?JSON.parse(body):{}
  calls.push({path,p}); let out=[]
  if(path.endsWith('/user')) out=user
  else if(path.endsWith('/token')) out=session
  else if(path.endsWith('/profiles')) { const profile={id:uid,is_active:true,employee_type:'STAFF',first_name:'QA',last_name:'Usuario',roles:role}; out=req.headers.accept?.includes('object')?profile:[profile] }
  else if(path.endsWith('/rpc/wh_task_board')) out=p.p_scope==='historial'?[task,...history]:[task]
  else if(path.endsWith('/rpc/wh_prepicking_checklist')) out={ot:'16571',contratos_at:'2026-11-12T13:00:00Z',stock_at:'2026-11-12T13:00:00Z',items:[
    {item_code:'16571-S002-022',item:'022',lote:'16571-S002',product_code:'E.VOCT04.16.025.3030',description:'CORREA - VIGA "O" 2" x 5" C/ PLIEGUES DE 1.6mm x 3.03',unit:'UND',contract_qty:10,dispatched_qty:2,pending_qty:8,stock_wms:8,stock_wms_packages:4,stock_erp:8},
    {item_code:'16571-S002-024',item:'024',lote:'16571-S002',product_code:'E.VOCT1.16.025.3390',description:'CORREA - VIGA "C" 2" x 5" C/ PLIEGUES DE 1.6mm x 3.39',unit:'UND',contract_qty:6,dispatched_qty:0,pending_qty:6,stock_wms:2,stock_wms_packages:1,stock_erp:6},
    {item_code:'16571-S001-069',item:'069',lote:'16571-S001',product_code:'RAPO.20.053.6764',description:'POSTE DE RACK OMEGA DE 5 X 3 DE 2mm x 6.764m',unit:'UND',contract_qty:40,dispatched_qty:0,pending_qty:40,stock_wms:0,stock_wms_packages:0,stock_erp:44},
    {item_code:'16571-S003-012',item:'012',lote:'16571-S003',product_code:'.RACM.15.0003.0087',description:'PERNO HEXAGONAL 3/8 x 1"',unit:'UND',contract_qty:64,dispatched_qty:0,pending_qty:64,stock_wms:0,stock_wms_packages:0,stock_erp:0}]}
  else if(path.endsWith('/rpc/wh_task_lpns')) out=data
  else if(path.endsWith('/rpc/wh_task_load_units')) out=units
  else if(path.endsWith('/rpc/wh_load_unit_add')) { units.push({id:`unit-${units.length+1}`,seq:units.length+1,label:`UT${units.length+1}`,plate:null,lpn_ids:[],lpn_count:0,loaded_count:0,package_count:0,weight_kg:0}); out=units.at(-1) }
  else if(path.endsWith('/rpc/wh_lpns_assign_unit')) { for(const id of p.p_lpn_ids){ for(const u of units) u.lpn_ids=u.lpn_ids.filter(x=>x!==id); if(p.p_unit_id) units.find(u=>u.id===p.p_unit_id).lpn_ids.push(id) } for(const u of units){u.lpn_count=u.lpn_ids.length;u.package_count=data.lpns.filter(l=>u.lpn_ids.includes(l.id)).reduce((n,l)=>n+l.package_count,0);u.weight_kg=u.package_count*5} out={assigned:p.p_lpn_ids.length} }
  else if(path.endsWith('/rpc/wh_consolidate_lpn')) { const item={...lpn(2),packages:structuredClone(data.loose),package_count:data.loose.length,quantity:10,weight_kg:10,print_count:0,own_label:false};data.lpns.push(item);data.loose=[];out={id:item.id,lpn_code:item.lpn_code,package_count:item.package_count,quantity:item.quantity,weight_kg:item.weight_kg} }
  else if(path.endsWith('/rpc/wh_load_unit_set_plate')) {units.find(u=>u.id===p.p_unit_id).plate=p.p_plate;out=null}
  else if(path.endsWith('/rpc/wh_audit_lpn')) { data.lpns.find(l=>l.id===p.p_lpn_id).audit_status=p.p_result; task.lpn_approved=data.lpns.filter(l=>l.audit_status==='APROBADO').length;task.lpn_pending=2-task.lpn_approved;emitDocument();out=null }
  else if(path.endsWith('/rpc/wh_task_action')) {if(p.p_action==='FINISH_PICKING'){task.status='READY_FOR_LOAD';task.display_state='EN_AUDITORIA';emitDocument()} out=null}
  else if(path.endsWith('/rpc/wh_refresh_packing_list')) {emitDocument();out=null}
  else if(path.endsWith('/rpc/wh_print_packing_list')) out=data.packing_lists[0].snapshot
  else if(path.endsWith('/rpc/wh_record_scan')) out={ok:true}
  res.end(JSON.stringify(out))
})
;(async()=>{
 await new Promise(r=>api.listen(54333,'127.0.0.1',r))
 const log=fs.openSync('/tmp/wms-dispatch-browser.log','w')
 const next=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port','3023'],{env:{...process.env,NEXT_PUBLIC_DEPLOYMENT_SYSTEM:'',JRM_APP:'',NEXT_PUBLIC_SUPABASE_URL:'http://127.0.0.1:54333',NEXT_PUBLIC_SUPABASE_ANON_KEY:'qa-public-key'},stdio:['ignore',log,log]})
 let browser
 try {
  let ready=false
  for(let i=0;i<120;i++){try{if((await fetch('http://127.0.0.1:3023/almacen/login')).ok){ready=true;break}}catch{} await new Promise(r=>setTimeout(r,500))}
  assert(ready,'servidor Next disponible')
  browser=await chromium.launch({...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:fs.existsSync('/usr/bin/chromium')?{executablePath:'/usr/bin/chromium'}:{}),args:['--no-sandbox']})
  const ctx=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'America/Lima'})
  await ctx.addCookies([{name:'sb-127-auth-token',value:'base64-'+Buffer.from(JSON.stringify(session)).toString('base64url'),domain:'127.0.0.1',path:'/'}])
  const page=await ctx.newPage(), errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept())
  await page.addInitScript(() => {window.__prints=0;window.print=()=>{window.__prints++}})
  await page.route('**/api/wms/sincronizar*',r=>r.fulfill({json:{ok:true}}))
  const go=async path=>{await page.goto('http://127.0.0.1:3023'+path);await page.getByRole('heading',{level:1}).waitFor({timeout:90000});if(new URL(page.url()).pathname.includes('/almacen/packing-list/')) await page.getByRole('heading',{name:'Seleccionar liberados y asignar unidad',exact:true}).waitFor();if(new URL(page.url()).pathname.includes('/almacen/auditoria/')) await page.getByRole('button',{name:'Liberar LPN',exact:true}).first().waitFor()}
  const absent=async(name)=>assert.equal(await page.getByRole('button',{name,exact:true}).count(),0,name+' no corresponde a esta etapa')
  await go('/almacen/picking/task-1')
  await page.getByRole('button',{name:'Finalizar picking',exact:true}).waitFor()
  await absent('Agregar unidad');await absent('Confirmar carga completa');await absent('Liberar Packing List')
  assert(await page.getByText('Auditoría puede revisar cada bulto cerrado', {exact:false}).isVisible())
  await page.getByRole('button',{name:/Consolidar 2 en LPN/}).click()
  await page.getByText(/LPN lógico LPN-QA-2 creado/).waitFor()
  assert.equal(await page.evaluate(()=>window.__prints),0,'packing no obliga a imprimir')
  assert(!calls.some(c=>c.path.endsWith('/wh_print_lpn_label')),'no registra impresión automática')
  await go('/almacen/packing-list/task-1')
  await page.getByRole('button',{name:'Agregar unidad',exact:true}).waitFor()
  await absent('Liberar Packing List');await absent('Liberar LPN')
  assert.equal(await page.getByRole('checkbox',{name:'Seleccionar LPN-QA-1',exact:true}).count(),0,'pendiente no se ofrece para asignar')
  await go('/almacen/auditoria/task-1')
  await page.getByRole('button',{name:'Liberar LPN',exact:true}).first().waitFor()
  assert.equal(await page.getByRole('button',{name:'Liberar LPN',exact:true}).count(),2,'Auditoría ve bultos durante Picking')
  await page.getByRole('button',{name:'Liberar LPN',exact:true}).first().click()
  await page.getByText('LPN-QA-1: liberado por Auditoría.',{exact:true}).waitFor()
  assert.equal(task.status,'PICKING','liberación no espera al fin de Picking')
  await go('/almacen/packing-list/task-1')
  await page.getByRole('button',{name:'Agregar unidad',exact:true}).click()
  await page.getByLabel('Unidad de destino',{exact:true}).selectOption('unit-1')
  await page.getByRole('checkbox',{name:'Seleccionar LPN-QA-1',exact:true}).check()
  assert.equal(await page.getByRole('checkbox',{name:'Seleccionar LPN-QA-2',exact:true}).count(),0,'el otro LPN sigue bloqueado')
  await page.getByRole('button',{name:'Asignar unidad',exact:true}).click()
  await page.getByText('1 LPN asignado(s). Se conservaron los códigos y etiquetas existentes.',{exact:true}).waitFor()
  assert.equal(task.status,'PICKING','asigna liberados mientras continúa Picking')
  await go('/almacen/auditoria/task-1')
  await page.getByRole('button',{name:'Liberar LPN',exact:true}).last().click()
  await page.getByText('LPN-QA-2: liberado por Auditoría.',{exact:true}).waitFor()
  await go('/almacen/packing-list/task-1')
  await page.getByLabel('Mostrar',{exact:true}).selectOption('all')
  await page.getByRole('checkbox',{name:'Seleccionar todos los LPN disponibles',exact:true}).check()
  await page.getByLabel('Unidad de destino',{exact:true}).selectOption('unit-1')
  await page.getByRole('button',{name:'Asignar unidad',exact:true}).click()
  await page.getByText('2 LPN asignado(s). Se conservaron los códigos y etiquetas existentes.',{exact:true}).waitFor()
  assert(calls.some(c=>c.path.endsWith('/wh_lpns_assign_unit')&&c.p.p_lpn_ids.length===2),'asignación múltiple en una sola llamada')
  assert.equal(data.packing_lists.length,0,'documento final espera fin de Picking')
  await go('/almacen/picking/task-1');await page.getByRole('button',{name:'Finalizar picking',exact:true}).click()
  await page.getByText('Picking finalizado: queda en auditoría.',{exact:true}).waitFor()
  assert.equal(data.packing_lists.length,1,'documento se genera automáticamente')
  await go('/almacen/carga/task-1')
  await page.getByRole('button',{name:'Confirmar carga completa',exact:true}).waitFor()
  await absent('Agregar unidad');await absent('Finalizar picking');await absent('Deshacer')
  assert.equal(await page.getByLabel('Placa de UT1',{exact:true}).count(),0,'Carga no modifica placas')
  await page.getByText('Unidad que se está cargando',{exact:false}).locator('select').selectOption('unit-1')
  await page.locator('input[placeholder*="Escanee"]').fill('PKG-QA-2');await page.getByRole('button',{name:'Registrar',exact:true}).click()
  await page.getByText('PKG-QA-2 cargado.',{exact:true}).waitFor()
  assert(calls.some(c=>c.path.endsWith('/wh_record_scan')&&c.p.p_event==='LOAD'&&c.p.p_payload.load_unit_id==='unit-1'))
  fs.mkdirSync(artifactDir,{recursive:true})
  await go('/almacen/picking/task-1');{const c=page.locator('section[aria-labelledby="prepicking-title"]');await c.waitFor();for(const t of ['Listo para picking','Parcial en WMS','En ERP, sin etiquetar','Sin stock'])await c.getByText(t,{exact:true}).waitFor();fs.mkdirSync(artifactDir,{recursive:true});await c.screenshot({path:artifactDir+'/checklist-prepicking.png'});await c.getByRole('checkbox',{name:'Revisado 16571-S002-022'}).check();const dl=page.waitForEvent('download');await c.getByRole('button',{name:'Descargar PDF',exact:true}).click();const d=await dl;assert.equal(d.suggestedFilename(),'checklist-prepicking-RT-QA-001.pdf');await d.saveAs(artifactDir+'/checklist-prepicking.pdf')}
  for(const [path,file] of [['/almacen/picking/task-1','picking'],['/almacen/auditoria/task-1','auditoria'],['/almacen/packing-list/task-1','packing-list'],['/almacen/carga/task-1','carga']]) {await go(path);if(file==='packing-list') await page.getByLabel('Mostrar',{exact:true}).selectOption('all');await page.screenshot({path:`${artifactDir}/${file}.png`,fullPage:true})}
  await go('/almacen/carga');await page.getByRole('link',{name:'Abrir carga',exact:true}).waitFor()
  await go('/almacen/tareas/task-1');assert(page.url().includes('/almacen/picking/task-1'),'enlace antiguo continúa funcionando')
  await page.setViewportSize({width:390,height:844});await go('/almacen/packing-list/task-1');await page.getByRole('button',{name:'Agregar unidad',exact:true}).waitFor()
  await page.screenshot({path:artifactDir+'/packing-list-movil.png',fullPage:true})
  role={name:'Operario WMS',permissions:['almacen-picking']}
  await go('/almacen/plan-carga/task-1');assert(new URL(page.url()).pathname==='/almacen/packing-list/task-1','plan anterior abre Packing List');await absent('Asignar unidad');await absent('Agregar unidad')
  await go('/almacen/carga/task-1');assert(new URL(page.url()).pathname==='/almacen','middleware bloquea Carga al picker')
  await go('/almacen/auditoria/task-1');assert(new URL(page.url()).pathname==='/almacen','middleware bloquea Auditoría al picker')
  await go('/almacen/packing-list/task-1');assert.equal(await page.getByRole('button',{name:'Aprobar',exact:true}).count(),0)
  assert(!calls.some(c=>c.path.endsWith('/wh_release_packing_list')),'no hay liberación manual de Packing List')
  // La hoja automática usa el LPN recargado (la RPC de consolidación no devuelve paquetes).
  role={name:'Administrador',permissions:['almacen-supervisor']};task.status='PICKING';task.display_state='EN_PICKING'
  for(const count of [4,6,19]) {
    data.lpns=[];data.packing_lists=[];data.loose=Array.from({length:count},(_,i)=>({package_code:`16573-B-${String(i+1).padStart(4,'0')}`,product_code:`SKU-${i}`,description:'Producto de contenido',lot:'16573',quantity:1,unit:'UND',weight_kg:1}))
    await go('/almacen/picking/task-1')
    const downloads=[];const onDownload=d=>downloads.push(d);page.on('download',onDownload)
    await page.getByRole('button',{name:new RegExp(`Consolidar ${count} en LPN`)}).click()
    if(count>4) {
      await page.getByText('su hoja de contenido se imprimirá junto con la etiqueta del LPN',{exact:false}).waitFor()
      assert.equal(downloads.length,0,'consolidar ya no descarga la hoja')
      const repeat=page.waitForEvent('download');await page.getByRole('button',{name:'Contenido',exact:true}).click();await repeat
      assert.equal(downloads.length,1,'Contenido permite descargarla')
    } else {
      await page.getByText(/LPN lógico LPN-QA-2 creado/).waitFor()
      assert.equal(downloads.length,0,'hasta cuatro ítems no descarga hoja')
      await absent('Contenido')
    }
    page.off('download',onDownload)
    assert.equal(await page.evaluate(()=>window.__prints),0,'descargar contenido no imprime etiquetas')
    // Imprimir la etiqueta del LPN: con más de 4 ítems también se manda a imprimir su hoja de contenido (PDF en iframe), sin descargar.
    {const before=downloads.length;page.on('download',onDownload);await page.getByRole('button',{name:'Etiqueta',exact:true}).first().click()
     await page.waitForFunction(()=>window.__prints>0)
     if(count>4) await page.waitForFunction(()=>[...document.querySelectorAll('iframe')].some(f=>f.src.startsWith('blob:')))
     else assert.equal(await page.evaluate(()=>[...document.querySelectorAll('iframe')].filter(f=>f.src.startsWith('blob:')).length),0,'sin hoja no se imprime PDF')
     page.off('download',onDownload);assert.equal(downloads.length,before,'imprimir no descarga')
     await page.evaluate(()=>{window.__prints=0;document.querySelectorAll('iframe').forEach(f=>f.remove())})}
  }
  // Historial de Picking: grupos con conteo del período, cerradas de solo lectura y «Atendido en TMS (sin WMS)» aparte.
  {const today=task.required_date,closedAt=new Date().toISOString(),base={...task,assigned_picker:null,picker_name:null,lpn_total:0,packing_list:null}
   history.push({...base,id:'h-pend',request_number:'RT-QA-P',status:'PENDING',display_state:'PENDIENTE'},
    {...base,id:'h-load',request_number:'RT-QA-L',status:'LOADED',display_state:'LOADED',closed_at:closedAt,closed_by_name:'Cargador QA'},
    {...base,id:'h-tms',request_number:'RT-QA-T',status:'CANCELLED',display_state:'CANCELLED',required_date:null,closed_at:closedAt,cancelled_reason:'Solicitud asignada antes del flujo con WMS'},
    {...base,id:'h-canc',request_number:'RT-QA-C',status:'CANCELLED',display_state:'CANCELLED',closed_at:closedAt,closed_by_name:'Supervisor QA',cancelled_reason:'Solicitud cancelada o rechazada'})
   const chip=name=>page.getByRole('button',{name,exact:true}), rowsShown=()=>page.locator('tbody tr').count()
   await page.setViewportSize({width:1440,height:1000});await go('/almacen/picking');await chip('Pendiente + En proceso (2)').waitFor()
   for(const n of ['Pendiente de picking (1)','En proceso (1)','Atendido (2)','Cancelado (1)','Todos (5)']) await chip(n).waitFor()
   assert.equal(await page.getByText('RT-QA-L',{exact:true}).count(),0,'por defecto solo pendientes y en proceso')
   assert(calls.some(c=>c.path.endsWith('/rpc/wh_task_board')&&c.p.p_scope==='historial'&&c.p.p_from===today&&c.p.p_to===today),'pide el historial del período')
   await chip('Atendido (2)').click();assert.equal(await rowsShown(),2)
   await page.getByText('Atendido en TMS (sin WMS)',{exact:true}).waitFor();await page.getByText('Atendido (cargada)',{exact:true}).waitFor()
   await page.getByText(/Cargada .* · Cargador QA/).waitFor()
   assert.equal(await page.getByRole('button',{name:'Tomar tarea'}).count(),0,'las cerradas no se toman')
   assert.equal(await page.getByRole('link',{name:'Ver detalle',exact:true}).count(),2,'las cerradas solo se consultan')
   await chip('Cancelado (1)').click();await page.getByText('Solicitud cancelada o rechazada',{exact:true}).waitFor();assert.equal(await rowsShown(),1)
   await chip('Todos (5)').click();assert.equal(await rowsShown(),5)
   fs.mkdirSync(artifactDir,{recursive:true});await page.screenshot({path:artifactDir+'/picking-historial.png',fullPage:true})
   const week=new Date(Date.now()-6*864e5).toLocaleDateString('en-CA',{timeZone:'America/Lima'})
   await chip('Semana').click()
   for(let i=0;i<40&&!calls.some(c=>c.p.p_scope==='historial'&&c.p.p_from===week);i++) await page.waitForTimeout(250)
   assert(calls.some(c=>c.p.p_scope==='historial'&&c.p.p_from===week&&c.p.p_to===today),'cambiar el período vuelve a pedir ese rango')}
  assert.equal(errors.length,0,errors.join('\n'))
  console.log('PASS: LPN lógico sin impresión automática; auditoría libera en paralelo; Packing List selecciona solo liberados y asigna varios a UT; documento automático; carga por UT; permisos, enlaces y móvil.')
 } finally {await browser?.close();next.kill('SIGTERM');api.close();fs.closeSync(log)}
})().catch(e=>{console.error(e);process.exitCode=1})
