const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
function fixture(system){
 let adminCalls=0;
 const context={exports:{},process:{env:{NEXT_PUBLIC_DEPLOYMENT_SYSTEM:system}},require(name){
  if(name==='@supabase/supabase-js')return{createClient(){adminCalls++;throw Error('Privileged key must not be read')}};
  if(name==='next/server')return{NextResponse:{json:(body,options)=>({body,...options})}};
  if(name==='@/lib/server/registration-limit')return{reserveRegistration(){throw Error('Unexpected quota call')}};
  throw Error(name);
 }};
 const source=ts.transpileModule(readFileSync('src/app/api/register-driver/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
 vm.runInNewContext(source,context);
 return{post:context.exports.POST,get adminCalls(){return adminCalls}};
}
test('WMS can import and reject TMS registration without a service key',async()=>{
 const f=fixture('wms');const response=await f.post({json(){throw Error('WMS must reject before reading the request')}});
 assert.equal(response.status,404);assert.equal(f.adminCalls,0);
});
test('TMS invalid registrations retain validation without creating an admin client',async()=>{
 const f=fixture('tms');assert.equal((await f.post({json:async()=>({})})).status,400);assert.equal(f.adminCalls,0);
});
