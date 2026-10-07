const { test } = require('node:test'), assert = require('node:assert/strict')
const ts = require('typescript'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path')
const crypto = require('node:crypto'), root = path.resolve(__dirname,'..')
function load(file, require, extra={}) {
 const context={exports:{},process:{env:{SUPABASE_SERVICE_ROLE_KEY:'synthetic-secret',NEXT_PUBLIC_SUPABASE_URL:'https://db.example.test',NEXT_PUBLIC_SUPABASE_ANON_KEY:'fixture'}},URL,AbortSignal,Buffer,console,require,...extra}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,context)
 return context.exports
}
const response={NextResponse:{json:(body,options)=>({body,...options}),redirect:(url,options)=>({url,...options})}}
const roles=load('src/lib/roles.ts',()=>{throw Error('unexpected dependency')})
function fixture(options={}) {
 const calls=[], user=options.public?null:{id:'actor'}
 const profile=options.profile||{is_active:true,roles:{name:'Administrador',permissions:[]}}
 const session={auth:{getUser:async()=>({data:{user}})},from:()=>({select:()=>({eq:()=>({single:async()=>({data:profile}),maybeSingle:async()=>({data:profile})})})}),storage:{from:bucket=>({createSignedUrl:async(key,ttl)=>{calls.push(['sign',bucket,key,ttl]);return options.denyFile?{error:{message:'Denied'}}:{data:{signedUrl:'https://db.example.test/private?token=fixture'}}}})}}
 const admin={auth:{admin:{createUser:async(body)=>{calls.push(['create',body]);return {data:{user:{id:'new-user'}},error:null}},deleteUser:async()=>({error:null})}},
  from:table=>({select:()=>({eq:()=>({eq:()=>({maybeSingle:async()=>({data:{id:'carrier'}})}),maybeSingle:async()=>({data:table==='roles'?{id:'driver-role'}:{id:'carrier'}})})}),upsert:async(body)=>{calls.push(['profile',body]);return{error:null}}}),
  rpc:async(name,args)=>{calls.push([name,args]);return {data:options.quota===false?false:options.quota==='error'?null:true,error:options.quota==='error'?{message:'Offline'}:null}}
 }
 let limit
 const imports=name=>{
  if(name==='node:crypto')return crypto
  if(name==='next/server')return response
  if(name==='@/lib/roles')return roles
  if(name==='@supabase/supabase-js')return{createClient:()=>admin}
  if(name==='@supabase/ssr')return{createServerClient:()=>session}
  if(name==='next/headers')return{cookies:async()=>({getAll:()=>[]})}
  if(name==='@/lib/supabase/server')return{createClient:async()=>session}
  if(name==='@/lib/server/registration-limit')return limit
  throw Error(name)
 }
 limit=load('src/lib/server/registration-limit.ts',imports)
 return {calls,admin,limit,load:file=>load(file,imports)}
}
const body={username:'test@jrmsac.com.pe',password:'long-synthetic-password',document_number:'87654321',first_name:'Prueba',last_name:'Seguridad',role_id:'admin-role'}
const request=(data,headers={})=>({json:async()=>data,headers:new Headers(headers),url:'https://jrm.example/api/users/create'})
test('registro público no asigna roles ni activa cuentas; una cuota denegada no crea autenticación',async()=>{
 const f=fixture({public:true}), api=f.load('src/app/api/users/create/route.ts')
 assert.equal((await api.POST(request(body))).body.success,true)
 assert.equal(f.calls.find(c=>c[0]==='create')[1].user_metadata.role_id,null)
 const profile=f.calls.find(c=>c[0]==='profile')[1][0];assert.equal(profile.is_active,false);assert.equal(profile.role_id,null)
 for(const quota of [false,'error']){const q=fixture({public:true,quota});assert.equal((await q.load('src/app/api/users/create/route.ts').POST(request(body))).status,quota===false?429:503);assert.equal(q.calls.some(c=>c[0]==='create'),false)}
})
test('usuarios: una cuenta inactiva o con permiso usuarios sin rol administrador no puede crear privilegios',async()=>{
 for(const profile of [{is_active:false,roles:{name:'Administrador'}},{is_active:true,roles:{name:'Asistente',permissions:['usuarios']}}]){
 const f=fixture({profile});assert.equal((await f.load('src/app/api/users/create/route.ts').POST(request(body))).status,403);assert.equal(f.calls.some(c=>c[0]==='create'),false)
 }
 const f=fixture();assert.equal((await f.load('src/app/api/users/create/route.ts').POST(request({...body,password:{length:20}}))).status,400);assert.equal(f.calls.length,0)
})
test('las cuotas usan un HMAC del encabezado del proveedor; falsificar X-Forwarded-For no cambia el contador',async()=>{
 const f=fixture()
 await f.limit.reserveRegistration(request(body,{'x-vercel-forwarded-for':'192.0.2.10','x-forwarded-for':'fake-one'}),f.admin,'staff')
 await f.limit.reserveRegistration(request(body,{'x-vercel-forwarded-for':'192.0.2.10','x-forwarded-for':'fake-two'}),f.admin,'staff')
 const a=f.calls[0][1].p_fingerprint,b=f.calls[1][1].p_fingerprint;assert.equal(a,b);assert.match(a,/^[a-f0-9]{64}$/);assert.equal(a.includes('192.0.2.10'),false)
})
test('conductor: la cuota se verifica antes de crear usuario y los datos inválidos no producen escrituras',async()=>{
 const data={dni:'87654321',firstName:'Prueba',lastName:'Seguridad',licenseNumber:'Q87654321',pin:'long-password',carrierId:'11111111-1111-4111-8111-111111111111'}
 const f=fixture({quota:false});assert.equal((await f.load('src/app/api/register-driver/route.ts').POST(request(data))).status,429);assert.equal(f.calls.some(c=>c[0]==='create'),false)
 const invalid=fixture();assert.equal((await invalid.load('src/app/api/register-driver/route.ts').POST(request({...data,dni:'../admin'}))).status,400);assert.equal(invalid.calls.length,0)
})
test('archivos: solo la sesión firma durante 120 segundos; sin sesión, permiso o con ruta inválida se deniega',async()=>{
 for(const [options,url,status] of [[{public:true},'bucket=evidence&path=ot/test.pdf',401],[{denyFile:true},'bucket=evidence&path=ot/test.pdf',403],[{},'bucket=evidence&path=..%2Fprivate.pdf',400],[{},'bucket=dispatch_documents&path=test.pdf',400]]){
 const f=fixture(options),r=await f.load('src/app/api/files/route.ts').GET({url:'https://jrm.example/api/files?'+url});assert.equal(r.status,status)
 }
 const f=fixture(),r=await f.load('src/app/api/files/route.ts').GET({url:'https://jrm.example/api/files?bucket=signatures&path=inspecciones%2FABC%2Ffirma.png'})
 assert.equal(r.status,302);assert.equal(r.headers['Cache-Control'],'no-store');assert.equal(f.calls[0][3],120);assert.equal(f.calls.some(c=>c[0]==='create'),false)
 const links=f.load('src/lib/protected-files.ts');assert.equal(links.protectedFileHref('https://db.example.test/storage/v1/object/public/evidence/ot/foto.jpg'),'/api/files?bucket=evidence&path=ot%2Ffoto.jpg');assert.equal(links.protectedFileHref('javascript:alert(1)'),'#')
})
