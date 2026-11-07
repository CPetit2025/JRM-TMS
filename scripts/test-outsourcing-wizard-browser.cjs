// Navegador real y Supabase simulado local. Datos del bosquejo solo como fixture, jamás escribe en producción.
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),ts=require('typescript'),{spawn}=require('node:child_process')
const {chromium}=require('playwright'),{spec:valid,services}=require('./fixtures/outsourcing-wizard-data.cjs')
const m={exports:{}};new Function('exports','module',ts.transpileModule(fs.readFileSync('src/lib/outsourcing-form.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(m.exports,m)
const model=m.exports,copy=x=>JSON.parse(JSON.stringify(x)),oid='00000000-0000-4000-8000-000000000002',uid='00000000-0000-4000-8000-000000000001'
const user={id:uid,email:'qa@example.test',aud:'authenticated',role:'authenticated',app_metadata:{},user_metadata:{}}
const token=[{alg:'HS256',typ:'JWT'},{sub:uid,role:'authenticated',aud:'authenticated',exp:Math.floor(Date.now()/1000)+3600},'signature'].map((x,i)=>i<2?Buffer.from(JSON.stringify(x)).toString('base64url'):x).join('.')
const session={access_token:token,refresh_token:'qa-refresh',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user}
const profile={id:uid,is_active:true,employee_type:'STAFF',full_name:'QA',roles:{name:'Administrador',permissions:['despacho','compras-tercerizaciones','compras-aprobar','cierre-economico']}}
const request={id:'req-1',request_number:'RT-001970',requester_name:valid.responsible,pickup_address:valid.pickup,delivery_address:valid.delivery,required_at:'2026-10-28T13:00:00Z',status:'APROBADA',created_at:'2026-10-25T10:00:00Z',contract_id:'ot-1',contracts:{id:'ot-1',code:'16516',clients:{business_name:'INKA CROPS S.A.'},contract_budgets:[]},transport_request_items:[]}
let record=null,events=[],calls=[],failSave=false,permission='admin'
const queue=()=>record?[{...record,client:'INKA CROPS S.A.',transport_requests:{request_number:request.request_number,contract_id:request.contract_id,contracts:{code:'16516'}}}]:[]
function save(p){if(record&&p.p_version!==record.version)throw Error('La solicitud cambió');if(record&&record.stage>0)throw Error('La solicitud ya fue enviada');record={id:oid,number:1,request_id:request.id,dispatch_id:null,stage:0,version:record?record.version+1:1,review_status:'ACTIVE',revision:1,specification:copy(p.p_spec),updated_at:new Date().toISOString()};events.push({id:String(events.length),stage:0,actor_name:valid.responsible,note:'Borrador guardado',created_at:new Date().toISOString(),evidence:null});return oid}
const server=http.createServer(async(req,res)=>{
 res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','*');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS,PATCH');res.setHeader('Content-Type','application/json')
 if(req.method==='OPTIONS'){res.end();return}
 let body='';for await(const c of req)body+=c
 const path=new URL(req.url,'http://localhost').pathname
 let p=null;try{p=body?JSON.parse(body):null}catch{}
 calls.push({path,p});let out=[]
 try{
 if(path==='/auth/v1/user')out=user
 else if(path.includes('/token'))out=session
 else if(path.endsWith('/profiles')){const next=permission==='admin'?profile:{...profile,roles:{name:'Consulta',permissions:['despacho:read']}};out=req.headers.accept?.includes('object')?next:[next]}
 else if(path.endsWith('/transport_requests'))out=[request]
 else if(path.endsWith('/transport_outsourcing'))out=record
 else if(path.endsWith('/transport_outsourcing_events'))out=events
 else if(path.endsWith('/rpc/outsourcing_queue'))out=queue()
 else if(path.endsWith('/rpc/outsourcing_options'))out={suppliers:[],dispatches:[]}
 else if(path.endsWith('/rpc/outsourcing_form_context'))out={record,request}
 else if(path.endsWith('/rpc/outsourcing_save')){if(failSave)throw Error('Error de persistencia simulado');out=save(p)}
 else if(path.endsWith('/rpc/outsourcing_submit')){
  if(permission!=='admin')throw Error('Sin permiso')
  const issues=model.validateWizard(model.normalizeSpec(p.p_spec));if(issues.length)throw Error(issues.map(i=>i.message).join(' | '))
  save(p);record.stage=1;record.version++;out=record;events.push({id:'sent',stage:1,actor_name:valid.responsible,note:'Recibida por Compras',created_at:new Date().toISOString(),evidence:null})
 }
 else if(path.includes('/storage/v1/object/outsourcing/'))out={Key:path.split('/object/')[1]}
 else if(path.endsWith('/rpc/get_menu_counters'))out={}
 res.end(JSON.stringify(out))
 }catch(e){res.statusCode=400;res.end(JSON.stringify({message:e.message,code:'P0001'}))}
})
;(async()=>{
 await new Promise(r=>server.listen(54329,'127.0.0.1',r))
 const log=fs.openSync('/tmp/tms-wizard-dev.log','w'),next=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port','3020'],{env:{...process.env,NEXT_PUBLIC_SUPABASE_URL:'http://127.0.0.1:54329',NEXT_PUBLIC_SUPABASE_ANON_KEY:'qa-public-key'},stdio:['ignore',log,log]})
 let browser
 try{
  for(let i=0;i<120;i++){try{if((await fetch('http://127.0.0.1:3020/login')).ok)break}catch{}await new Promise(r=>setTimeout(r,500))}
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE||'/usr/bin/chromium',args:['--no-sandbox','--lang=es-PE']})
  const ctx=await browser.newContext({viewport:{width:1536,height:1024},timezoneId:'America/Lima',locale:'es-PE'})
  await ctx.addCookies([{name:'sb-127-auth-token',value:'base64-'+Buffer.from(JSON.stringify(session)).toString('base64url'),domain:'127.0.0.1',path:'/'}])
  const page=await ctx.newPage(),errors=[];let acceptDialog=true
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>acceptDialog?d.accept():d.dismiss())
  const open=async()=>{await page.getByRole('button',{name:'Solicitar tercerización',exact:true}).click();await page.getByRole('dialog').waitFor();await page.getByLabel('Fecha y hora requerida',{exact:true}).waitFor();await page.getByRole('button',{name:'Siguiente',exact:true}).waitFor()}
  const step=async n=>page.getByRole('button',{name:new RegExp('^'+(n+1)+'\\. '+model.WIZARD_STEPS[n])}).click()
  const field=async(f,value)=>{const c=page.locator('[id="out-'+f.key+'"]');if(f.type==='select')await c.selectOption(value);else await c.fill(value)}
  await page.goto('http://127.0.0.1:3020/despacho');await page.getByRole('button',{name:'Solicitar tercerización',exact:true}).waitFor({timeout:90000});await open()
  assert.equal(await page.getByLabel('Fecha y hora requerida',{exact:true}).inputValue(),'2026-10-28T08:00')
  await page.locator('.ow-progress [role=progressbar]').waitFor();assert.equal(await page.locator('[role=progressbar]').getAttribute('aria-valuenow'),'20')
  const out='/workspace/artifacts/tercerizacion-v2';fs.mkdirSync(out,{recursive:true})
  await page.screenshot({path:out+'/01-informacion-general.png',fullPage:true,style:'nextjs-portal{display:none}'})
  const geometry=await page.evaluate(()=>{const g=s=>{const r=document.querySelector(s).getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};return{modal:g('.ow-modal'),left:g('.ow-form-card'),right:g('.ow-summary'),footer:g('.ow-footer'),tabs:g('.ow-tabs'),header:g('.ow-header'),title:g('.ow-brand h2'),logo:g('.ow-brand img')}})
  fs.writeFileSync(out+'/geometry.json',JSON.stringify(geometry,null,2));assert.ok(geometry.right.x>geometry.left.x+geometry.left.width);assert.ok(Math.abs(geometry.left.y-geometry.right.y)<2);assert.equal(await page.locator('.ow-tabs>button').count(),5)
  const compactGeometry=[]
  for(const viewport of [{width:1536,height:864},{width:1366,height:768},{width:1280,height:720},{width:1366,height:650},{width:1100,height:650}]) {
   await page.setViewportSize(viewport)
   const fit=await page.evaluate(()=>{
    const rect=s=>document.querySelector(s).getBoundingClientRect(),modal=rect('.ow-modal'),footer=rect('.ow-footer'),info=rect('.ow-important'),progress=rect('.ow-progress'),scroll=document.querySelector('.ow-scroll')
    return {width:innerWidth,height:innerHeight,modal:{x:modal.x,y:modal.y,width:modal.width,height:modal.height},footerBottom:footer.bottom,infoBottom:info.bottom,progressBottom:progress.bottom,scrollOverflow:scroll.scrollHeight-scroll.clientHeight,zoom:visualViewport.scale}
   })
   compactGeometry.push(fit)
   assert.equal(fit.zoom,1,'browser zoom remains 100%')
   assert.ok(fit.modal.width<=1240 && fit.modal.x>=30,'dialog has desktop margins')
   assert.ok(fit.modal.y>=19 && fit.footerBottom<=viewport.height-19,'whole dialog and footer fit the viewport')
   assert.ok(fit.scrollOverflow<=2,`first step fits without scrolling at ${viewport.width}x${viewport.height}: ${fit.scrollOverflow}px overflow`)
   await page.screenshot({path:out+`/compact-${viewport.width}x${viewport.height}.png`,fullPage:true,style:'nextjs-portal{display:none}'})
  }
  fs.writeFileSync(out+'/compact-geometry.json',JSON.stringify(compactGeometry,null,2))
  await page.setViewportSize({width:1536,height:1024})
  await page.getByLabel('Prioridad de la solicitud').selectOption('ALTA');await page.locator('.ow-summary').getByText('Alta',{exact:true}).waitFor();acceptDialog=false;await page.getByRole('button',{name:'Cerrar solicitud de tercerización'}).click();assert.equal(await page.getByRole('dialog').count(),1,'discard rejected retains edits');acceptDialog=true
  await page.getByLabel('Puntos intermedios',{exact:true}).selectOption('points');await page.getByLabel('Punto intermedio 1',{exact:true}).fill('Obra intermedia A');await page.getByRole('button',{name:'Agregar punto',exact:true}).click();await page.getByLabel('Punto intermedio 2',{exact:true}).fill('Obra intermedia B');await page.getByRole('button',{name:'Subir punto 2'}).click()
  await step(1);await field({key:'unit_type',type:'select'},'Plataforma');await field({key:'unit_count'},'1.5');await page.getByRole('button',{name:'Guardar borrador',exact:true}).click();await page.getByText('Borrador guardado.',{exact:false}).waitFor()
  assert.equal(record.specification.unit_count,'1.5','incomplete draft accepted');assert.equal(record.specification.intermediate_stops[0].address,'Obra intermedia B')
  await page.getByRole('button',{name:'Cerrar solicitud de tercerización'}).click();await page.getByRole('dialog').waitFor({state:'hidden'});await open();await step(1);assert.equal(await page.locator('#out-unit_count').inputValue(),'1.5','draft reopens')
  for(const f of model.TRANSPORT_FIELDS)if(valid[f.key]!==undefined&&f.key!=='unit_other')await field(f,String(valid[f.key]))
  await page.getByRole('button',{name:'Agregar bulto',exact:true}).click();await page.getByRole('button',{name:'Agregar bulto',exact:true}).click()
  for(let i=0;i<valid.packages.length;i++)for(const key of ['kind','quantity','length_m','width_m','height_m','weight_kg'])await page.getByLabel(`Bulto ${i+1}: ${key}`,{exact:true}).fill(valid.packages[i][key])
  await page.getByRole('button',{name:'Agregar bulto',exact:true}).click();await page.getByRole('button',{name:'Retirar bulto 3'}).click()
  await step(2)
  for(const service of services.slice(0,2)){
   await page.getByLabel(service.kind==='MONTACARGAS'?'Montacargas':'Grúa',{exact:false}).first().check()
   for(const f of model.WIZARD_SERVICE_FIELDS[service.kind])if(service.details[f.key]!==undefined)await field({...f,key:`service.${service.kind}.${f.key}`},service.details[f.key])
   await page.locator(`[id="out-service.${service.kind}.requirements"]`).fill(service.requirements)
  }
  await step(0);assert.equal(await page.locator('#out-pickup').inputValue(),valid.pickup);await step(2);assert.equal(await page.locator('[id="out-service.MONTACARGAS.capacity"]').inputValue(),'2','service values survive tab changes')
  await page.locator('.ow-scroll').evaluate(el=>el.scrollTop=0)
  await page.screenshot({path:out+'/03-servicios-complementarios.png',fullPage:true,style:'nextjs-portal{display:none}'})
  await step(3);for(const f of model.OPERATION_FIELDS)if(valid[f.key]!==undefined)await field(f,String(valid[f.key]))
  await page.locator('#out-loading_end').fill('2026-10-28T06:00');await step(4);await page.getByText('Carga: el fin debe ser posterior al inicio.',{exact:false}).waitFor();await page.getByRole('button',{name:'Enviar a Compras',exact:true}).click();assert.equal(calls.filter(c=>c.path.endsWith('/outsourcing_submit')).length,0,'incomplete request never sent')
  await step(3);await page.locator('#out-loading_end').fill(valid.loading_end);await step(4)
  assert.equal(await page.locator('[role=progressbar]').getAttribute('aria-valuenow'),'100')
  await page.getByLabel('Adjuntar archivos al requerimiento').setInputFiles({name:'requerimiento.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\nQA')})
  await page.locator('.ow-scroll').evaluate(el=>el.scrollTop=0)
  await page.screenshot({path:out+'/05-revision-envio.png',fullPage:true,style:'nextjs-portal{display:none}'})
  failSave=true;await page.getByRole('button',{name:'Guardar borrador',exact:true}).click();await page.getByText('Error de persistencia simulado',{exact:false}).waitFor();assert.equal(record.stage,0);failSave=false
  const savedWithAttachment=page.waitForResponse(r=>r.url().endsWith('/rpc/outsourcing_save')&&r.status()===200&&r.request().postDataJSON()?.p_spec?.attachments?.length===1);await page.getByRole('button',{name:'Guardar borrador',exact:true}).click();await savedWithAttachment;await page.locator('[role=dialog][aria-busy=false]').waitFor();assert.equal(record.specification.attachments.length,1)
  await page.getByRole('button',{name:'Enviar a Compras',exact:true}).dblclick();await page.getByText(/ST-1 enviada a la bandeja de Compras/).waitFor();assert.equal(calls.filter(c=>c.path.endsWith('/outsourcing_submit')).length,1,'double click sends once');assert.equal(record.stage,1)
  await page.getByRole('button',{name:'Cerrar solicitud de tercerización'}).click()
  await page.goto('http://127.0.0.1:3020/despacho/tercerizaciones?solicitud='+oid);await page.getByRole('button',{name:'Consultar ficha completa',exact:true}).waitFor();await page.getByRole('button',{name:'Consultar ficha completa',exact:true}).click();await page.locator('.ow-status').getByText('Enviada',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Guardar borrador',exact:true}).isDisabled(),true,'submitted form read-only')
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:out+'/06-mobile.png',fullPage:true,style:'nextjs-portal{display:none}'});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no viewport overflow on mobile')
  assert.ok(await page.locator('.ow-footer').isVisible(),'mobile footer accessible')
  await page.getByRole('button',{name:'Cerrar solicitud de tercerización'}).click()
  permission='reader';record.stage=0;await page.reload();await page.getByRole('button',{name:'Consultar ficha completa',exact:true}).waitFor();await page.getByRole('button',{name:'Consultar ficha completa',exact:true}).click();await page.locator('.ow-loading').waitFor({state:'hidden'});assert.equal(await page.getByRole('button',{name:'Guardar borrador',exact:true}).isDisabled(),true)
  assert.deepEqual(errors,[])
  console.log('PASS browser v2: original entry, real controls, partial save/reopen, five tabs, multi-stop ordering, multi-unit/package/service persistence, validation, progress, receipt, double-send prevention, error recovery, read-only permission, desktop/mobile and screenshot geometry')
 }finally{if(browser)await browser.close();next.kill('SIGTERM');server.close();fs.closeSync(log)}
})().catch(e=>{console.error(e);server.close();process.exitCode=1})
