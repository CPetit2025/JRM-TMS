// Navegador real y Supabase simulado local. Datos del bosquejo solo como fixture, jamás escribe en producción.
const {execFileSync}=require('node:child_process')
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
function save(p){if(record&&p.p_version!==record.version)throw Error('La solicitud cambió');if(record&&record.stage>0)throw Error('La solicitud ya fue enviada');record={id:oid,number:1,request_id:request.id,dispatch_id:null,stage:0,version:record?record.version+1:1,review_status:'ACTIVE',revision:1,specification:copy(p.p_spec),updated_at:new Date().toISOString()};events.push({id:String(events.length),stage:0,actor_name:valid.responsible,note:'Ficha guardada',snapshot:copy(p.p_spec),created_at:new Date().toISOString(),evidence:null});return oid}
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
 else if(path==='/storage/v1/object/sign/outsourcing')out=(p.paths||[]).map(path=>({path,signedURL:'/object/sign/outsourcing/'+path+'?token=qa'}))
 else if(path.includes('/storage/v1/object/sign/outsourcing/'))out={}
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
  await ctx.grantPermissions(['clipboard-read','clipboard-write'])
  const open=async()=>{await page.getByRole('button',{name:'Solicitar tercerización',exact:true}).click();await page.getByRole('dialog').waitFor();await page.getByLabel('Fecha y hora requerida',{exact:true}).waitFor()}
  const field=async(f,value)=>{const c=page.locator('[id="out-'+f.key+'"]');if(!await c.count())return;await c.evaluate(el=>{let p=el.parentElement;while(p){if(p.tagName==='DETAILS')p.open=true;p=p.parentElement}});if(await c.evaluate(el=>el.tagName)==='SELECT')await c.selectOption(value);else await c.fill(value)}
  const collapse=async()=>page.locator('.ow-scroll details[open]').evaluateAll(nodes=>nodes.forEach(n=>n.open=false))
  const screenshot=async name=>page.screenshot({path:out+'/'+name,fullPage:true,style:'nextjs-portal,[data-sonner-toaster]{display:none}'})
  const out='/workspace/artifacts/tercerizacion-ejecutiva';fs.mkdirSync(out,{recursive:true})
  await page.goto('http://127.0.0.1:3020/despacho');await page.getByRole('button',{name:'Solicitar tercerización',exact:true}).waitFor({timeout:90000});await open()
  assert.equal(await page.getByLabel('Fecha y hora requerida',{exact:true}).inputValue(),'2026-10-28T08:00')
  assert.equal(await page.locator('.ow-section-grid>.ow-card').count(),4);assert.equal(await page.locator('.ow-tabs,.ow-summary').count(),0)
  assert.equal(await page.locator('.ow-footer button').count(),3)
  assert.equal(await page.locator('.ow-brand img').getAttribute('src'),'/logo-jrm.png')
  await screenshot('01-modal-inicial.png')
  const originalCount=await page.locator('#out-unit_count').inputValue();await page.locator('#out-unit_count').fill('1.5');assert.equal(await page.locator('#out-unit_count').inputValue(),originalCount,'fractional units rejected')
  await page.getByRole('button',{name:'Aumentar unidades',exact:true}).click();assert.equal(await page.locator('#out-unit_count').inputValue(),'2')
  await page.getByRole('button',{name:'Reducir unidades',exact:true}).click()
  await page.getByLabel('Prioridad de la solicitud').selectOption('ALTA')
  acceptDialog=false;await page.getByRole('button',{name:'Cerrar solicitud de tercerización'}).click();assert.equal(await page.getByRole('dialog').count(),1);acceptDialog=true
  await page.getByLabel('Puntos intermedios',{exact:true}).selectOption('points');await page.getByLabel('Punto intermedio 1',{exact:true}).fill('Obra intermedia A');await page.getByRole('button',{name:'Agregar punto',exact:true}).click();await page.getByLabel('Punto intermedio 2',{exact:true}).fill('Obra intermedia B');await page.getByRole('button',{name:'Subir punto 2'}).click()
  await page.getByRole('button',{name:'Guardar borrador',exact:true}).click();await page.getByText('Borrador guardado.',{exact:false}).waitFor();assert.equal(record.stage,0);assert.equal(record.specification.intermediate_stops[0].address,'Obra intermedia B')
  const stableId=record.id
  await page.getByRole('button',{name:'Cerrar solicitud de tercerización'}).click();await page.getByRole('dialog').waitFor({state:'hidden'});await open();assert.equal(await page.locator('#out-pickup').inputValue(),valid.pickup);await page.getByLabel('Puntos intermedios',{exact:true}).selectOption('none')
  for(const f of model.TRANSPORT_FIELDS)if(valid[f.key]!==undefined&&f.key!=='unit_other')await field(f,String(valid[f.key]))
  await field({key:'unit_justification'},valid.unit_justification)
  await page.getByRole('button',{name:'Agregar bulto',exact:true}).click();await page.getByRole('button',{name:'Agregar bulto',exact:true}).click()
  for(let i=0;i<valid.packages.length;i++)for(const key of ['kind','quantity','length_m','width_m','height_m','weight_kg'])await page.getByLabel(`Bulto ${i+1}: ${key}`,{exact:true}).fill(valid.packages[i][key])
  for(const service of services.slice(0,2)){
   await page.getByLabel(service.kind==='MONTACARGAS'?'Montacargas':'Grúa',{exact:true}).check()
   for(const f of model.WIZARD_SERVICE_FIELDS[service.kind])if(service.details[f.key]!==undefined)await field({...f,key:`service.${service.kind}.${f.key}`},service.details[f.key])
   await field({key:`service.${service.kind}.requirements`},service.requirements)
  }
  await page.getByLabel('Montacargas',{exact:true}).uncheck();await page.getByRole('button',{name:'Guardar borrador',exact:true}).click();await page.locator('[role=dialog][aria-busy=false]').waitFor();assert.equal(record.specification.services.length,1);assert.equal(record.specification.service_drafts[0].details.height,'4')
  await page.getByRole('button',{name:'Cerrar solicitud de tercerización'}).click();await page.getByRole('dialog').waitFor({state:'hidden'});await open();await page.getByLabel('Montacargas',{exact:true}).check();assert.equal(await page.locator('[id="out-service.MONTACARGAS.capacity"]').inputValue(),'2')
  for(const f of model.OPERATION_FIELDS)if(valid[f.key]!==undefined)await field(f,String(valid[f.key]))
  await field({key:'loading_end'},'2026-10-28T06:00');await page.getByRole('button',{name:'Enviar a Compras',exact:true}).click();await page.getByText('Carga: el fin debe ser posterior al inicio.',{exact:false}).first().waitFor();assert.equal(calls.filter(c=>c.path.endsWith('/outsourcing_submit')).length,0)
  assert.equal(await page.locator('#out-loading_end').getAttribute('aria-invalid'),'true')
  await field({key:'loading_end'},valid.loading_end)
  await page.getByLabel('Es obligatorio adjuntar documentos de referencia para cotizar').check();await page.getByRole('button',{name:'Enviar a Compras',exact:true}).click();await page.getByText('Adjunte los documentos de referencia obligatorios antes de preparar la solicitud.',{exact:false}).first().waitFor()
  await page.getByLabel('Adjuntar archivos al requerimiento').setInputFiles({name:'plano-de-carga.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\nQA')})
  await collapse();await page.locator('.ow-scroll').evaluate(el=>el.scrollTop=0)
  await screenshot('02-modal-final-1536x1024.png')
  const geometry=await page.evaluate(()=>{const r=s=>{const x=document.querySelector(s).getBoundingClientRect();return {x:x.x,y:x.y,width:x.width,height:x.height,bottom:x.bottom}};return{modal:r('.ow-modal'),cards:[1,2,3,4].map(i=>r('.ow-section-grid>.ow-card:nth-child('+i+')')),footer:r('.ow-footer'),band:r('.ow-important'),viewport:{width:innerWidth,height:innerHeight}}})
  assert.ok(geometry.cards[1].x>geometry.cards[0].x);assert.ok(Math.abs(geometry.cards[0].y-geometry.cards[1].y)<2);assert.ok(geometry.cards[2].y>geometry.cards[0].y);assert.ok(Math.abs(geometry.cards[2].y-geometry.cards[3].y)<2)
  assert.ok(geometry.footer.bottom<=1024);assert.ok(geometry.band.bottom<=geometry.footer.y,'reference layout shows the information band without scrolling');fs.writeFileSync(out+'/geometry.json',JSON.stringify(geometry,null,2))
  for(const viewport of [{width:1366,height:768},{width:1280,height:720},{width:390,height:844}]){await page.setViewportSize(viewport);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const footer=await page.locator('.ow-footer').boundingBox();assert.ok(footer.y+footer.height<=viewport.height);await screenshot(`modal-${viewport.width}x${viewport.height}.png`)}
  await page.setViewportSize({width:1536,height:1024})
  failSave=true;await page.getByRole('button',{name:'Guardar borrador',exact:true}).click();await page.getByText('Error de persistencia simulado',{exact:false}).waitFor();failSave=false
  await page.getByRole('button',{name:'Enviar a Compras',exact:true}).dblclick();await page.getByRole('heading',{name:'Preparar correo para Compras',exact:true}).waitFor({timeout:30000})
  assert.equal(record.id,stableId);assert.equal(record.stage,0,'preparing never advances procurement stage');assert.equal(record.specification.preparation.state,'PREPARED');assert.equal(calls.filter(c=>c.path.endsWith('/outsourcing_submit')).length,0,'preparing never calls submit')
  assert.equal(record.specification.attachments.length,1);assert.ok(events.some(e=>e.snapshot?.preparation?.state==='PREPARED'))
  await page.getByLabel('Asunto',{exact:true}).fill('SOLICITUD EDITADA | OT 16516')
  const body=page.getByLabel('Cuerpo del correo',{exact:true});await body.fill((await body.inputValue())+'\n\nMensaje editado por Transporte.')
  for(const [name,pattern] of [['Copiar asunto','SOLICITUD EDITADA'],['Copiar mensaje','Mensaje editado por Transporte.'],['Copiar correo completo','rruesta@jrmsac.com.pe']]){await page.getByRole('button',{name,exact:true}).click();assert.ok((await page.evaluate(()=>navigator.clipboard.readText())).includes(pattern))}
  const downloadEvent=page.waitForEvent('download');await page.getByRole('link',{name:'Descargar PDF ejecutivo',exact:true}).click();const downloaded=await downloadEvent;await downloaded.saveAs(out+'/ejecutivo-descargado.pdf')
  assert.ok(!downloaded.suggestedFilename().includes('BORRADOR'))
  const info=execFileSync('pdfinfo',[out+'/ejecutivo-descargado.pdf'],{encoding:'utf8'});assert.match(info,/Pages:\s+1/);assert.match(info,/841\.89.*595\.28/)
  await page.locator('.ow-scroll').evaluate(el=>el.scrollTop=0);await screenshot('03-correo-preparado.png')
  await page.getByRole('button',{name:'Cerrar preparación',exact:true}).click();await page.getByRole('heading',{name:'Solicitud de tercerización',exact:true}).waitFor();assert.equal(record.stage,0)
  await page.getByRole('button',{name:'Preparar copia de correo y PDF',exact:true}).click();await page.getByRole('heading',{name:'Preparar correo para Compras',exact:true}).waitFor();assert.equal(await page.getByLabel('Asunto',{exact:true}).inputValue(),'SOLICITUD EDITADA | OT 16516');assert.ok((await body.inputValue()).includes('Mensaje editado por Transporte.'))
  await page.locator('.ow-manual-confirmation summary').click();await page.getByLabel('Referencia del envío (asunto, ID de mensaje o evidencia)').fill('Outlook: referencia de confirmación manual de prueba')
  await page.getByLabel('Confirmo que envié manualmente este correo con su documentación.').check();await page.getByLabel('Fecha y hora del envío (Lima)').fill('2038-01-01T10:00');await page.getByRole('button',{name:'Registrar confirmación manual',exact:true}).click();await page.getByText('Indique una fecha y hora de envío válidas, sin fechas futuras.',{exact:false}).waitFor();assert.equal(record.stage,0)
  await page.getByLabel('Fecha y hora del envío (Lima)').fill(model.localDate(new Date().toISOString()));await page.getByRole('button',{name:'Registrar confirmación manual',exact:true}).dblclick();await page.getByText('Confirmación manual registrada en el historial.',{exact:false}).waitFor()
  assert.equal(calls.filter(c=>c.path.endsWith('/outsourcing_submit')).length,1);assert.equal(record.stage,1);assert.equal(record.specification.preparation.confirmation_kind,'USER_ATTESTED')
  await page.getByRole('button',{name:'Cerrar solicitud de tercerización'}).click();await page.goto('http://127.0.0.1:3020/despacho/tercerizaciones?solicitud='+oid);await page.getByRole('button',{name:'Consultar ficha completa',exact:true}).waitFor();await page.getByRole('button',{name:'Consultar ficha completa',exact:true}).click();await page.getByLabel('Fecha y hora requerida',{exact:true}).waitFor();assert.ok(await page.getByRole('button',{name:'Guardar borrador',exact:true}).isDisabled());assert.ok(await page.getByRole('button',{name:'Enviar a Compras',exact:true}).isDisabled())
  await page.getByRole('button',{name:'Cerrar solicitud de tercerización'}).click();permission='reader';record.stage=0;await page.reload();await page.getByRole('button',{name:'Consultar ficha completa',exact:true}).waitFor();await page.getByRole('button',{name:'Consultar ficha completa',exact:true}).click();await page.locator('.ow-loading').waitFor({state:'hidden'});assert.ok(await page.getByRole('button',{name:'Guardar borrador',exact:true}).isDisabled())
  assert.deepEqual(errors,[])
  console.log('PASS browser: 2x2 compact form, official logo, 3 footer actions, load/save/reopen, non-fractional units, stops, service recovery, inline errors, required files, one-page PDF download, editable/copyable mail, persisted edits, preparation without submit, explicit manual attestation, concurrency, permissions and desktop/mobile screenshots')
 }finally{if(browser)await browser.close();next.kill('SIGTERM');server.close();fs.closeSync(log)}
})().catch(e=>{console.error(e);server.close();process.exitCode=1})
