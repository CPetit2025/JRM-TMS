const {test}=require('node:test')
const assert=require('node:assert/strict')
const ts=require('typescript'),vm=require('node:vm'),{readFileSync}=require('node:fs'),path=require('node:path')
const load=(file,requireModule)=>{
 const context={exports:{},require:requireModule,process:{env:{NEXT_PUBLIC_SUPABASE_URL:'https://example.test',NEXT_PUBLIC_SUPABASE_ANON_KEY:'fixture'}},URL}
 const source=ts.transpileModule(readFileSync(path.join(__dirname,'../',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 vm.runInNewContext(source,context);return context.exports
}
const roles=load('src/lib/roles.ts'),packing=load('src/lib/packing-list.ts')
function fixture(profile={is_active:true,employee_type:'ADMINISTRATIVO',roles:{name:'Auditor de Despacho',permissions:['planificacion:read','packing-list:write']}}){
 return load('src/proxy.ts',name=>{
  if(name==='@/lib/roles')return roles
  if(name==='next/server')return{NextResponse:{next:()=>({kind:'next',cookies:{getAll:()=>[],set(){}}}),redirect:url=>({kind:'redirect',pathname:url.pathname,cookies:{set(){}}})}}
  if(name==='@supabase/ssr')return{createServerClient:()=>({
   auth:{getUser:async()=>({data:{user:{id:'fixture'}}})},
   from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:profile})})})})
  })}
  throw Error(name)
 })
}
const request=pathname=>({url:'https://jrm.example'+pathname,nextUrl:{pathname,clone:()=>new URL('https://jrm.example'+pathname)},cookies:{getAll:()=>[],set(){}}})
test('auditor accede a planificación, Packing List y su perfil; rutas administrativas y operativas redirigen',async()=>{
 const api=fixture()
 for(const pathname of ['/despacho/planificacion','/despacho/documentos','/perfil'])assert.equal((await api.proxy(request(pathname))).kind,'next')
 for(const pathname of ['/','/login','/caja','/despacho','/app','/usuarios','/mantenimiento/flota'])assert.equal((await api.proxy(request(pathname))).pathname,'/despacho/documentos')
})
test('la restricción no concede acceso a cuentas inactivas ni altera al administrador',async()=>{
 const inactive=fixture({is_active:false,roles:{name:'Auditor de Despacho'}})
 assert.equal((await inactive.proxy(request('/despacho/planificacion'))).pathname,'/login')
 const admin=fixture({is_active:true,roles:{name:'Administrador',permissions:[]}})
 assert.equal((await admin.proxy(request('/caja'))).kind,'next')
})
test('PDF, fotos y ambos formatos Excel funcionan aunque el navegador omita su MIME; tipos ajenos no pasan',()=>{
 for(const [name,mime] of [['packing.pdf','application/pdf'],['firma.JPG','image/jpeg'],['foto.png','image/png'],['foto.webp','image/webp'],['packing.xls','application/vnd.ms-excel'],['PACKING.XLSX','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']]){
  assert.equal(packing.packingMime({name,type:''}),mime);assert.equal(packing.packingMime({name,type:'application/octet-stream'}),mime)
 }
 assert.equal(packing.packingMime({name:'packing.exe',type:''}),null)
 assert.equal(packing.packingMime({name:'packing.csv',type:'application/vnd.ms-excel'}),null)
 assert.equal(packing.packingMime({name:'sin extension',type:'image/jpeg'}),'image/jpeg')
})
