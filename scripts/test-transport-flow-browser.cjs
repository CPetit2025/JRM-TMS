// Browser verification against a running build. All Supabase calls are intercepted:
// synthetic data only, no writes or reads against an operational database.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const playwright = process.env.PLAYWRIGHT_MODULE || '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
const { chromium } = require(playwright)
const origin = process.env.TRANSPORT_FLOW_ORIGIN || 'http://127.0.0.1:3020'
const token = '00000000-0000-4000-8000-000000000999'
const policy = { enabled:true, zones:{LIMA:{enabled:true,hours:24},PROVINCIA:{enabled:true,hours:48},EXTERIOR:{enabled:true,hours:72}} }
const requests = [
 {id:'r1',request_number:'RT-QA-001',ot_code:'16523',created_at:'2026-10-07T22:45:00Z',required_date:'2026-10-08',required_at:'2026-10-08T22:45:00Z',request_type:'DESPACHO',attention_mode:'TRANSPORTE_JRM',delivery_zone:'LIMA',lead_time_policy:policy,pickup_address:'Planta Chilca',delivery_address:'Lima',status:'PENDIENTE'},
 {id:'r2',request_number:'RT-QA-002',ot_code:'16524',created_at:'2026-10-07T22:45:00Z',required_date:'2026-10-08',required_at:'2026-10-08T13:00:00Z',request_type:'DESPACHO',attention_mode:'TRANSPORTE_JRM',delivery_zone:'LIMA',lead_time_policy:policy,pickup_address:'Planta Chilca',delivery_address:'Lima',status:'PENDIENTE'},
 {id:'r3',request_number:'RT-QA-003',ot_code:'16525',created_at:'2026-10-07T22:45:00Z',required_date:'2026-10-09',required_at:null,request_type:'RECOJO',attention_mode:'TRANSPORTE_JRM',delivery_zone:null,lead_time_policy:null,pickup_address:'Obra',delivery_address:'Planta Chilca',status:'REPROGRAMADA'},
]
;(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE || '/usr/bin/chromium',args:['--no-sandbox']})
 try{
  const context=await browser.newContext({viewport:{width:1600,height:1000},timezoneId:'America/Lima'})
  const page=await context.newPage(), errors=[],calls=[];let revoked=false
  page.on('pageerror',error=>errors.push(error.message))
  await page.route('**/rest/v1/**',async route=>{
   const request=route.request(),fn=new URL(request.url()).pathname.split('/').at(-1)
   if(fn!=='get_public_tracking_portal_info')throw Error('Unexpected database request: '+fn)
   const input=request.postDataJSON();calls.push(input)
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(revoked?{error:'Acceso revocado'}:{mode:'permanent',rows:[],requests,locations:[]})})
  })
  await page.goto(origin+'/tracking/'+token)
  await page.getByRole('heading',{name:'Planificación y Seguimiento de Transporte'}).waitFor()
  await page.getByPlaceholder('••••').fill('12345678')
  await page.getByRole('button',{name:'Ver Planificación'}).click()
  await page.getByRole('heading',{name:'Calendario de transporte'}).waitFor()
  const table=page.locator('table').filter({hasText:'Registro'})
  await table.getByText('RT-QA-001',{exact:true}).waitFor()
  assert.ok(await table.getByText('Cumple anticipación',{exact:true}).count())
  assert.ok(await table.getByText('Anticipación insuficiente',{exact:true}).count())
  assert.match(await table.innerText(),/17:45/)
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Desktop overflow')
  fs.mkdirSync('/tmp/transport-flow-screenshots',{recursive:true})
  await page.screenshot({path:'/tmp/transport-flow-screenshots/portal-desktop.png',fullPage:true})
  await page.setViewportSize({width:390,height:844})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Mobile overflow')
  await page.screenshot({path:'/tmp/transport-flow-screenshots/portal-mobile.png',fullPage:true})
  assert.ok(calls.length>=1)
  assert.ok(calls.every(call=>call.p_token===token&&call.p_pin==='12345678'&&call.p_from&&call.p_to))
  revoked=true
  // The explicit refresh uses the same authorization check as polling.
  await page.getByRole('button',{name:/Actualizar/i}).click()
  await page.getByRole('button',{name:'Ver Planificación'}).waitFor()
  assert.equal(await page.getByRole('heading',{name:'Calendario de transporte'}).count(),0,'Revocation retains protected data')
  assert.deepEqual(errors,[])
  console.log('PASS: real portal desktop/mobile, exact anticipation example, bounded authorized RPC and revocation clears protected data.')
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1})
