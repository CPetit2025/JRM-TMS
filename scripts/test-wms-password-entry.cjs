const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript')
function proxy(user){
 const context={exports:{},URL,process:{env:{NEXT_PUBLIC_DEPLOYMENT_SYSTEM:'wms',NEXT_PUBLIC_SUPABASE_URL:'https://glecgvomkaqmkfkhtxhi.supabase.co',VERCEL_ENV:'production'}},require(name){
 if(name==='@/lib/warehouse/dispatch')return{DISPATCH_STAGES:{}}
 if(name==='@/lib/deployment-isolation.mjs')return{assertDeploymentIsolation(){},wmsRouteAllowed:()=>true}
 if(name==='@/lib/roles')return{isDispatchAuditorRole:()=>false,dispatchAuditorPathAllowed:()=>false,roleDeniesPath:()=>false}
 if(name==='@/lib/nav/web-access')return{canOpenPath:()=>true,hasWebAccess:()=>true}
 if(name==='next/server')return{NextResponse:{next:()=>({kind:'next',cookies:{getAll:()=>[],set(){}}}),redirect:url=>({kind:'redirect',url:url.toString(),cookies:{set(){}}})}}
 if(name==='@supabase/ssr')return{createServerClient:()=>({auth:{getUser:async()=>({data:{user}})},from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{is_active:true,roles:{name:'Administrador',permissions:['almacen-lectura']}}})})})})})}
 throw Error(name)
 }}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/proxy.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context)
 return context.exports.proxy
}
const request=path=>({url:'https://wms.jrmlogistica.app'+path,method:'GET',nextUrl:{pathname:path.split('?')[0],search:'',clone:()=>new URL('https://wms.jrmlogistica.app'+path)},cookies:{getAll:()=>[],set(){}}})
test('first-access/password link stays open with an existing WMS session',async()=>{assert.equal((await proxy({id:'already-signed-in'})(request('/login/restablecer?token_hash=new-user'))).kind,'next')})
test('first-access/password link stays open without a session',async()=>{assert.equal((await proxy(null)(request('/login/restablecer?token_hash=new-user'))).kind,'next')})
