// UI con servidor Supabase simulado local; no usa credenciales ni datos operativos.
const assert=require('node:assert/strict')
const http=require('node:http')
const {spawn}=require('node:child_process')
const {chromium}=require('playwright')
const fs=require('node:fs')
const uid='00000000-0000-4000-8000-000000000001', oid='00000000-0000-4000-8000-000000000002'
const user={id:uid,email:'qa@example.test',aud:'authenticated',role:'authenticated',app_metadata:{},user_metadata:{}}
const token=[{alg:'HS256',typ:'JWT'},{sub:uid,role:'authenticated',aud:'authenticated',exp:Math.floor(Date.now()/1000)+3600},'signature'].map((x,i)=>i<2?Buffer.from(JSON.stringify(x)).toString('base64url'):x).join('.')
const session={access_token:token,refresh_token:'qa-refresh',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user}
const profile={id:uid,is_active:true,employee_type:'STAFF',full_name:'QA',roles:{name:'Administrador',permissions:['despacho','compras-tercerizaciones','compras-aprobar','cierre-economico']}}
let stage=0,version=1
const calls=[]
const spec={priority:'ALTA',required_at:'2026-11-09T08:00:00-05:00',pickup:'Planta Chilca',delivery:'Piura',responsible:'QA Transporte',intermediate_points:'No aplica',unit_type:'Plataforma',length_m:'6',width_m:'2.5',height_m:'3',capacity_t:'8',volume_m3:'40',cargo_weight_kg:'7000',cargo_quantity:'5',cargo:'Estructuras 3 x 2 x 1 m',packaging:'Pallet',special_conditions:'Eslingas',loading_window:'08:00–10:00',unloading_window:'14:00–16:00',entry_requirements:'Inducción',documents:'SOAT y SCTR',safety:'EPP',access:'Altura libre 5 m',duration_hours:'4',services:[]}
const row=()=>({id:oid,number:1,request_id:'req-1',dispatch_id:null,stage,version,specification:spec,updated_at:new Date().toISOString(),client:'Cliente QA',transport_requests:{request_number:'RT-QA-1',contract_id:'ot-1',contracts:{code:'OT-QA'}}})
const server=http.createServer(async(req,res)=>{
 res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','*');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS,PATCH');res.setHeader('Content-Type','application/json')
 if(req.method==='OPTIONS'){res.end();return}
 let body='';for await(const chunk of req)body+=chunk
 const path=new URL(req.url,'http://localhost').pathname
 const input=body?JSON.parse(body):null;calls.push({path,input})
 let output=[]
 if(path==='/auth/v1/user')output=user
 else if(path.includes('/token'))output=session
 else if(path.endsWith('/profiles'))output=req.headers.accept?.includes('object')?profile:[profile]
 else if(path.endsWith('/rpc/outsourcing_queue'))output=[row()]
 else if(path.endsWith('/rpc/outsourcing_options'))output={suppliers:[],dispatches:[]}
 else if(path.endsWith('/transport_outsourcing_events'))output=[{id:'e1',stage:0,actor_name:'QA Transporte',note:'Ficha guardada',created_at:new Date().toISOString(),evidence:null}]
 else if(path.endsWith('/rpc/outsourcing_transition')){assert.equal(input.p_next,1);assert.equal(input.p_version,1);stage=1;version++;output=null}
 else if(path.endsWith('/transport_requests'))output=[{id:'req-1',request_number:'RT-QA-1',requester_name:'QA Transporte',pickup_address:'Planta Chilca',delivery_address:'Piura',status:'APROBADA',created_at:'2026-11-07T10:00:00Z',contract_id:'ot-1',contracts:{id:'ot-1',code:'OT-QA',clients:{business_name:'Cliente QA'},contract_budgets:[]}}]
 else if(path.endsWith('/transport_outsourcing'))output=null
 else if(path.endsWith('/rpc/get_menu_counters'))output={}
 res.end(JSON.stringify(output))
})
;(async()=>{
 await new Promise(r=>server.listen(54329,'127.0.0.1',r))
 const log=fs.openSync('/tmp/tms-outsourcing-dev.log','w')
 const next=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port','3020'],{env:{...process.env,NEXT_PUBLIC_SUPABASE_URL:'http://127.0.0.1:54329',NEXT_PUBLIC_SUPABASE_ANON_KEY:'qa-public-key'},stdio:['ignore',log,log]})
 let browser
 try{
  for(let i=0;i<120;i++){try{const r=await fetch('http://127.0.0.1:3020/login');if(r.ok)break}catch{}await new Promise(r=>setTimeout(r,500))}
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE || '/usr/bin/chromium',args:['--no-sandbox']})
  const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'America/Lima'})
  await context.addCookies([{name:'sb-127-auth-token',value:'base64-'+Buffer.from(JSON.stringify(session)).toString('base64url'),domain:'127.0.0.1',path:'/'}])
  const page=await context.newPage();const errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.goto('http://127.0.0.1:3020/despacho')
  await page.getByRole('button',{name:'Solicitar tercerización',exact:true}).waitFor({timeout:90000})
  await page.getByRole('button',{name:'Solicitar tercerización',exact:true}).click()
  await page.getByRole('dialog').waitFor()
  await page.getByLabel('Tipo de unidad (camión, plataforma, tráiler, furgón…)').fill('Plataforma')
  await page.getByLabel('Montacargas',{exact:true}).check()
  await page.getByLabel('Altura de elevación (m)',{exact:true}).fill('4')
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({state:'hidden'})
  await page.goto(`http://127.0.0.1:3020/despacho/tercerizaciones?solicitud=${oid}`)
  await page.getByRole('heading',{name:'ST-1 · Solicitud generada',exact:true}).waitFor({timeout:90000})
  await page.getByText('Cliente: Cliente QA',{exact:true}).waitFor()
  await page.getByLabel('Sustento / instrucciones').fill('Requerimiento completo para cotizar transporte')
  await page.getByRole('button',{name:'Enviada a Compras',exact:true}).click()
  await page.getByRole('heading',{name:'ST-1 · Enviada a Compras',exact:true}).waitFor()
  assert.ok(calls.some(c=>c.path.endsWith('/outsourcing_transition')&&c.input.p_next===1))
  await page.screenshot({path:'/tmp/tms-outsourcing-desktop.png',fullPage:true})
  await page.setViewportSize({width:390,height:844})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile overflow')
  await page.screenshot({path:'/tmp/tms-outsourcing-mobile.png',fullPage:true})
  assert.deepEqual(errors,[])
  console.log('PASS browser: bandeja autenticada, ficha, envío a Compras con versión, actualización de etapa, escritorio y móvil sin errores JS')
 }finally{if(browser)await browser.close();next.kill('SIGTERM');server.close();fs.closeSync(log)}
})().catch(e=>{console.error(e);server.close();process.exitCode=1})
