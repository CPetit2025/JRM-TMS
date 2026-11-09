// Prueba del flujo por etapas contra una API local: no usa datos ni credenciales reales.
const assert = require('node:assert/strict'), fs = require('node:fs'), http = require('node:http'), { spawn } = require('node:child_process'), { chromium } = require('playwright')
const uid = '00000000-0000-4000-8000-000000000001'
const user = { id: uid, email: 'qa@example.test', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} }
const token = [{ alg: 'HS256', typ: 'JWT' }, { sub: uid, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now()/1000)+3600 }, 'signature'].map((x,i) => i<2 ? Buffer.from(JSON.stringify(x)).toString('base64url') : x).join('.')
const session = { access_token: token, refresh_token: 'qa-refresh', expires_at: Math.floor(Date.now()/1000)+3600, expires_in: 3600, token_type: 'bearer', user }
let role = { name: 'Administrador', permissions: ['almacen-supervisor'] }
const task = { id: 'task-1', task_code: 'TASK-QA', status: 'PICKING', request_status: 'APROBADA', request_number: 'RT-QA-001', transport_request_id: 'request-1', required_date: '2026-11-09', required_at: null, created_at: '2026-11-09T13:00:00Z', contract_code: 'OT-QA', components: '', lots: 'L1', client_name: 'Cliente de prueba', delivery_address: 'Almacén', assigned_picker: uid, picker_name: 'Operario QA', assigned_at: '2026-11-09T13:00:00Z', picked: 2, loose: 0, lpn_total: 2, lpn_approved: 0, lpn_observed: 0, lpn_rejected: 0, lpn_pending: 2, weight_kg: 10, packing_list: null, display_state: 'EN_PICKING' }
const lpn = i => ({ id: `lpn-${i}`, lpn_code: `LPN-QA-${i}`, status: 'CLOSED', audit_status: 'PENDIENTE', audit_rev: 0, package_count: 1, quantity: 5, weight_kg: 5, created_by_name: 'Operario QA', created_at: task.created_at, print_count: 1, audits: [], packages: [{ package_code: `PKG-QA-${i}`, product_code: 'SKU-1', description: 'Producto QA', lot: 'L1', quantity: 5, unit: 'UND', weight_kg: 5 }] })
const data = { lpns: [lpn(1), lpn(2)], loose: [], packing_lists: [] }, units = [], calls = []
const api = http.createServer(async (req,res) => {
  res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Headers','*'); res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS'); res.setHeader('Content-Type','application/json')
  if(req.method==='OPTIONS') return res.end()
  let body=''; for await(const c of req) body+=c
  const path=new URL(req.url,'http://localhost').pathname, p=body?JSON.parse(body):{}
  calls.push({path,p}); let out=[]
  if(path.endsWith('/user')) out=user
  else if(path.endsWith('/token')) out=session
  else if(path.endsWith('/profiles')) { const profile={id:uid,is_active:true,employee_type:'STAFF',first_name:'QA',last_name:'Usuario',roles:role}; out=req.headers.accept?.includes('object')?profile:[profile] }
  else if(path.endsWith('/rpc/wh_task_board')) out=[task]
  else if(path.endsWith('/rpc/wh_task_lpns')) out=data
  else if(path.endsWith('/rpc/wh_task_load_units')) out=units
  else if(path.endsWith('/rpc/wh_load_unit_add')) { units.push({id:`unit-${units.length+1}`,seq:units.length+1,label:`UT${units.length+1}`,plate:null,lpn_ids:[],lpn_count:0,loaded_count:0,package_count:0,weight_kg:0}); out=units.at(-1) }
  else if(path.endsWith('/rpc/wh_lpn_assign_unit')) { for(const u of units) u.lpn_ids=u.lpn_ids.filter(id=>id!==p.p_lpn_id); if(p.p_unit_id) units.find(u=>u.id===p.p_unit_id).lpn_ids.push(p.p_lpn_id); for(const u of units) {u.lpn_count=u.lpn_ids.length;u.package_count=u.lpn_count;u.weight_kg=u.lpn_count*5} out=null }
  else if(path.endsWith('/rpc/wh_audit_lpn')) { data.lpns.find(l=>l.id===p.p_lpn_id).audit_status=p.p_result; task.lpn_approved=data.lpns.filter(l=>l.audit_status==='APROBADO').length;task.lpn_pending=2-task.lpn_approved; out=null }
  else if(path.endsWith('/rpc/wh_task_action')) {if(p.p_action==='FINISH_PICKING'){task.status='READY_FOR_LOAD';task.display_state='EN_AUDITORIA'} out=null}
  else if(path.endsWith('/rpc/wh_release_packing_list')) { const snapshot={...task,packing_list_number:'PL-QA',version:1,prepared_at:task.assigned_at,auditor_name:'Auditor QA',released_at:new Date().toISOString(),lpn_count:2,package_count:2,total_weight_kg:10,lpns:structuredClone(data.lpns)}; out={id:'pl-1',packing_list_number:'PL-QA',version:1,status:'LIBERADO',snapshot};data.packing_lists=[out];task.packing_list={id:'pl-1',number:'PL-QA',version:1};task.display_state='LIBERADO' }
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
  await page.route('**/api/wms/sincronizar*',r=>r.fulfill({json:{ok:true}}))
  const go=async path=>{await page.goto('http://127.0.0.1:3023'+path);await page.getByRole('heading',{level:1}).waitFor({timeout:90000})}
  const absent=async(name)=>assert.equal(await page.getByRole('button',{name,exact:true}).count(),0,name+' no corresponde a esta etapa')
  await go('/almacen/picking/task-1')
  await page.getByRole('button',{name:'Finalizar picking',exact:true}).waitFor()
  await absent('Agregar unidad');await absent('Confirmar carga completa');await absent('Liberar Packing List')
  assert(await page.getByText('Auditoría puede revisar cada bulto cerrado', {exact:false}).isVisible())
  await go('/almacen/plan-carga/task-1')
  await page.getByRole('button',{name:'Agregar unidad',exact:true}).click()
  await page.getByLabel('Unidad de LPN-QA-1',{exact:true}).waitFor();await page.getByLabel('Unidad de LPN-QA-1',{exact:true}).selectOption('unit-1')
  await page.getByText('LPN-QA-1: UT1.',{exact:true}).waitFor()
  assert.equal(task.status,'PICKING','planificación permitida durante Picking sin finalizarlo')
  await absent('Finalizar picking');await absent('Confirmar carga completa');assert.equal(await page.locator('input[placeholder*="Escanee"]').count(),0)
  await go('/almacen/auditoria/task-1')
  await page.getByRole('button',{name:'Aprobar',exact:true}).first().waitFor()
  assert.equal(await page.getByRole('button',{name:'Aprobar',exact:true}).count(),2,'Auditoría ve los bultos durante Picking')
  await absent('Liberar Packing List')
  await page.getByRole('button',{name:'Aprobar',exact:true}).first().click()
  await page.getByRole('status').filter({hasText:'aprobado'}).waitFor()
  assert.equal(task.status,'PICKING','la auditoría no espera al fin de Picking')
  await page.getByRole('button',{name:'Aprobar',exact:true}).last().click()
  await page.getByText('LPN-QA-2: aprobado.',{exact:true}).waitFor()
  await go('/almacen/packing-list/task-1')
  await page.getByRole('button',{name:'Liberar Packing List',exact:true}).waitFor()
  assert(await page.getByRole('button',{name:'Liberar Packing List',exact:true}).isDisabled(),'no libera antes de terminar Picking')
  await absent('Aprobar');await absent('Agregar unidad')
  await go('/almacen/picking/task-1');await page.getByRole('button',{name:'Finalizar picking',exact:true}).click()
  await page.getByText('Picking finalizado: queda en auditoría.',{exact:true}).waitFor()
  await go('/almacen/packing-list/task-1')
  await page.getByRole('button',{name:'Liberar Packing List',exact:true}).click()
  await page.getByText('Packing List PL-QA v1 liberado.',{exact:true}).waitFor()
  await go('/almacen/carga/task-1')
  await page.getByRole('button',{name:'Confirmar carga completa',exact:true}).waitFor()
  await absent('Agregar unidad');await absent('Finalizar picking');await absent('Deshacer')
  assert(await page.getByLabel('Placa de UT1',{exact:true}).isDisabled(),'Carga no modifica placas')
  await page.getByText('Unidad que se está cargando',{exact:false}).locator('select').selectOption('unit-1')
  await page.locator('input[placeholder*="Escanee"]').fill('LPN-QA-1');await page.getByRole('button',{name:'Registrar',exact:true}).click()
  await page.getByText('LPN-QA-1 cargado.',{exact:true}).waitFor()
  assert(calls.some(c=>c.path.endsWith('/wh_record_scan')&&c.p.p_event==='LOAD'&&c.p.p_payload.load_unit_id==='unit-1'))
  fs.mkdirSync('/workspace/artifacts/despacho-submodulos',{recursive:true})
  for(const [path,file] of [['/almacen/picking/task-1','picking'],['/almacen/auditoria/task-1','auditoria'],['/almacen/packing-list/task-1','packing-list'],['/almacen/plan-carga/task-1','plan-carga'],['/almacen/carga/task-1','carga']]) {await go(path);await page.screenshot({path:`/workspace/artifacts/despacho-submodulos/${file}.png`,fullPage:true})}
  await go('/almacen/carga');await page.getByRole('link',{name:'Abrir carga',exact:true}).waitFor()
  await go('/almacen/tareas/task-1');assert(page.url().includes('/almacen/picking/task-1'),'enlace antiguo continúa funcionando')
  await page.setViewportSize({width:390,height:844});await go('/almacen/plan-carga/task-1');await page.getByRole('button',{name:'Agregar unidad',exact:true}).waitFor()
  await page.screenshot({path:'/workspace/artifacts/despacho-submodulos/plan-carga-movil.png',fullPage:true})
  role={name:'Operario WMS',permissions:['almacen-picking']}
  await go('/almacen/plan-carga/task-1');assert(new URL(page.url()).pathname==='/almacen','middleware bloquea Plan de carga al picker')
  await go('/almacen/carga/task-1');assert(new URL(page.url()).pathname==='/almacen','middleware bloquea Carga al picker')
  await go('/almacen/auditoria/task-1');assert(new URL(page.url()).pathname==='/almacen','middleware bloquea Auditoría al picker')
  await go('/almacen/packing-list/task-1');assert.equal(await page.getByRole('button',{name:'Aprobar',exact:true}).count(),0)
  assert.equal(errors.length,0,errors.join('\n'))
  console.log('PASS: etapas separadas; auditoría y plan durante Picking; liberación posterior; carga por UT; permisos por ruta; enlaces antiguos; escritorio y móvil.')
 } finally {await browser?.close();next.kill('SIGTERM');api.close();fs.closeSync(log)}
})().catch(e=>{console.error(e);process.exitCode=1})
