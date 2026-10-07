// Requires the synthetic Supabase fixture used to build/start the app.
const assert=require('node:assert/strict'),fs=require('node:fs')
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const origin=process.env.TRANSPORT_FLOW_ORIGIN||'http://127.0.0.1:3020'
const uid='00000000-0000-4000-8000-000000000011', exp=Math.floor(Date.now()/1000)+3600
const jwt=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({sub:uid,exp,role:'authenticated',aud:'authenticated'})).toString('base64url')+'.'+Buffer.alloc(32).toString('base64url')
const session={access_token:jwt,refresh_token:'synthetic-ui-refresh',expires_at:exp,expires_in:3600,token_type:'bearer',user:{id:uid,email:'qa@example.test',aud:'authenticated',role:'authenticated',app_metadata:{},user_metadata:{}}}
;(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']})
 try{
  const context=await browser.newContext({viewport:{width:1600,height:1000},timezoneId:'America/Lima'})
  await context.addCookies([{name:'sb-127-auth-token',value:'base64-'+Buffer.from(JSON.stringify(session)).toString('base64url'),domain:'127.0.0.1',path:'/'}])
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));fs.mkdirSync('/tmp/transport-flow-screenshots',{recursive:true})
  const screens=[['solicitudes','Solicitud de Transporte'],['despacho','Programación'],['despacho/documentos','Documentos'],['contratos/servicios','Registro de Servicios'],['torre-control','Torre de Control']]
  for(const [route,title] of screens){
   await page.setViewportSize({width:1600,height:1000});await page.goto(origin+'/'+route);await page.getByText(title,{exact:false}).first().waitFor();await page.waitForTimeout(250)
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Desktop overflow '+route)
   await page.screenshot({path:'/tmp/transport-flow-screenshots/'+route.replaceAll('/','-')+'-desktop.png'})
   await page.setViewportSize({width:390,height:844});await page.waitForTimeout(100)
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Mobile overflow '+route)
   await page.screenshot({path:'/tmp/transport-flow-screenshots/'+route.replaceAll('/','-')+'-mobile.png'})
  }
  await page.setViewportSize({width:1600,height:1000});await page.goto(origin+'/solicitudes');await page.getByRole('button',{name:'Nueva Solicitud',exact:true}).click()
  const modal=page.getByRole('dialog');await modal.getByRole('heading',{name:'Crear Nueva Solicitud'}).waitFor()
  await modal.locator('select').filter({has:page.locator('option[value="Logística"]')}).selectOption('Logística')
  const tomorrow=new Date(Date.now()+24*3600000),date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Lima',year:'numeric',month:'2-digit',day:'2-digit'}).format(tomorrow)
  await modal.locator('input[type=date]').first().fill(date);await modal.getByLabel('Hora de atención · Lima').fill('00:00')
  await modal.getByText('La fecha y hora seleccionadas son anteriores al mínimo.',{exact:false}).waitFor()
  assert.equal(await modal.getByRole('button',{name:'Enviar Solicitud',exact:true}).isDisabled(),true)
  const later=new Date(Date.now()+48*3600000),laterDate=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Lima',year:'numeric',month:'2-digit',day:'2-digit'}).format(later)
  await modal.locator('input[type=date]').first().fill(laterDate);await modal.getByLabel('Hora de atención · Lima').fill('23:59')
  assert.equal(await modal.getByRole('button',{name:'Enviar Solicitud',exact:true}).isEnabled(),true)
  // Exercise the real management UI against synthetic RPCs; SQL tests separately
  // prove authorization, cryptography, persistence and revocation in PostgreSQL.
  const site='00000000-0000-4000-8000-000000000101',ot='00000000-0000-4000-8000-000000000102',token='00000000-0000-4000-8000-000000000103'
  let links=[],sharedScope=null,rotated=false,revoked=false
  await page.route('**/rest/v1/rpc/*tracking_portal*',async route=>{
   const fn=new URL(route.request().url()).pathname.split('/').at(-1),input=route.request().postDataJSON();let value
   if(fn==='get_tracking_portal_scope_options')value={sites:[{id:site,name:'Sede QA'}],contracts:[{id:ot,code:'16523',site_id:site}]}
   else if(fn==='list_tracking_portal_links')value=links
   else if(fn==='generate_tracking_portal_link'){
    sharedScope=input.p_scope;links=[{token,site_id:site,contract_ids:[ot],created_at:new Date().toISOString(),revoked_at:null,rotated_at:null}]
    value={token,pin:'87654321',scope:sharedScope}
   }else if(fn==='manage_tracking_portal_link'){
    assert.equal(input.p_token,token)
    if(input.p_action==='ROTATE_PIN'){rotated=true;value={token,pin:'23456789',action:input.p_action}}
    else{assert.equal(input.p_action,'REVOKE');revoked=true;links[0].revoked_at=new Date().toISOString();value={token,action:input.p_action}}
   }else throw Error('Unexpected portal manager RPC '+fn)
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)})
  })
  await page.goto(origin+'/torre-control');await page.getByRole('button',{name:'Portal permanente',exact:true}).click()
  const access=page.getByRole('dialog',{name:'Portal permanente · accesos de seguimiento'})
  await access.getByLabel('OT 16523',{exact:true}).check()
  await access.getByRole('button',{name:'Crear enlace permanente',exact:true}).click()
  await access.getByText('Acceso listo para compartir',{exact:true}).waitFor()
  assert.deepEqual(sharedScope,{site_id:site,contract_ids:[ot]})
  assert.equal(await access.getByRole('button',{name:'Copiar enlace y código'}).isVisible(),true)
  await access.getByRole('button',{name:'Cambiar código',exact:true}).click();await access.getByText('23456789',{exact:true}).waitFor();assert.equal(rotated,true)
  await access.getByRole('button',{name:'Revocar',exact:true}).click();await access.getByText('Revocado',{exact:true}).waitFor();assert.equal(revoked,true)
  assert.equal(await access.getByText('Acceso listo para compartir',{exact:true}).count(),0)

  let central={enabled:true,zones:{LIMA:{enabled:true,hours:24},PROVINCIA:{enabled:true,hours:48},EXTERIOR:{enabled:true,hours:72}},version:1}
  await page.route('**/rest/v1/rpc/*transport_lead_time_settings',async route=>{
   if(route.request().url().endsWith('/set_transport_lead_time_settings'))central={...route.request().postDataJSON().p_settings,version:2}
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(central)})
  })
  await page.goto(origin+'/configuracion');await page.getByRole('button',{name:'Planificación y plazos',exact:true}).click()
  const hours=page.getByLabel('Horas mínimas').first();await hours.waitFor();await hours.fill('36')
  await page.getByRole('button',{name:'Guardar plazos',exact:true}).click()
  await page.getByText('Anticipación actualizada para las nuevas solicitudes.',{exact:true}).waitFor()
  assert.equal(central.zones.LIMA.hours,36);assert.equal(central.version,2)
  assert.deepEqual(errors,[])
  console.log('PASS: actual SSR dashboards desktop/mobile, request date blocking, scoped portal create/rotate/revoke and central settings save without browser errors.')
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1})
