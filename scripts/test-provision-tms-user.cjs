const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript')
const context = { exports: {}, URL, require(name) {
  if (name === 'server-only') return {}
  if (name === 'node:crypto') return require(name)
  if (name === '@/lib/roles') return { isSystemAdminRole: name => ['Administrador', 'admin'].includes(name) }
  throw Error(name)
} }
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/server/provision-tms-user.ts','utf8'), { compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022} }).outputText, context)
const { provisionTmsUser } = context.exports
const source = { id:'tms-person',first_name:'Ana',last_name:'Pérez',username:'ana@jrmsac.com.pe',document_number:'12345678',phone:'123' }
function fixture(options={}) {
 const calls={created:[],profiles:[],deleted:[],links:0}
 const tms={from(table){assert.equal(table,'profiles');return{select:()=>({eq:(_,id)=>{assert.equal(id,source.id);return{single:async()=>({data: options.missingSource?null:source})}}})}}}
 const wms={from(table){return table==='roles'?{select:()=>({eq:()=>({single:async()=>({data: options.invalidRole?null:{name:'Auditor de Despacho',permissions:['almacen-lectura','almacen-auditoria']}})})})}:{select:()=>({eq:(_,email)=>{assert.equal(email,source.username);return{maybeSingle:async()=>({data:options.existing||null})}}}),upsert:async row=>{calls.profiles.push(row);return{error:options.profileError?Error('db'):null}}}},auth:{admin:{
  createUser:async data=>{calls.created.push(data);return{data:{user:{id:'new-wms-id'}}}},
  getUserById:async()=>({data:{user:{email:source.username,app_metadata:options.metadata||{}}}}),
  deleteUser:async id=>{calls.deleted.push(id)},
  generateLink:async()=>{calls.links++;return options.linkError?{data:{},error:Error('link')}:{data:{properties:{hashed_token:'one-use-hash'}}}},
 }}}
 return{tms,wms,calls}
}
const body={tms_profile_id:source.id,role_id:'wms-auditor',is_active:true,username:'forged@jrmsac.com.pe',first_name:'Forged'}
test('new WMS access resolves TMS identity on server; never copies client identity or TMS password',async()=>{
 const f=fixture();const result=await provisionTmsUser(f.wms,f.tms,body)
 assert.equal(f.calls.created[0].email,source.username)
 assert.equal(f.calls.created[0].app_metadata.tms_profile_id,source.id)
 assert.equal(f.calls.profiles[0].first_name,source.first_name)
 assert.equal(f.calls.profiles[0].id,'new-wms-id');assert.equal(f.calls.profiles[0].role_id,'wms-auditor')
 assert.equal(f.calls.profiles[0].is_active,true)
 assert.equal(new URL(result.firstAccessUrl).origin,'https://wms.jrmlogistica.app')
 assert.equal(new URL(result.firstAccessUrl).searchParams.get('token_hash'),'one-use-hash')
})
test('existing WMS account is reused without password changes or reset links',async()=>{
 const f=fixture({existing:{id:'existing-wms-id',roles:{name:'Auditor de Despacho'}}})
 const result=await provisionTmsUser(f.wms,f.tms,{...body,is_active:false})
 assert.equal(f.calls.created.length,0);assert.equal(f.calls.links,0)
 assert.equal(f.calls.profiles[0].id,'existing-wms-id');assert.equal(f.calls.profiles[0].is_active,false)
 assert.equal(result.created,false);assert.equal(result.firstAccessUrl,null)
})
test('missing TMS source or invalid WMS role cannot provision any account',async()=>{
 for(const options of [{missingSource:true},{invalidRole:true}]){const f=fixture(options);await assert.rejects(provisionTmsUser(f.wms,f.tms,body));assert.equal(f.calls.created.length,0);assert.equal(f.calls.profiles.length,0)}
})
test('protected administrators and conflicting TMS bindings cannot be overwritten',async()=>{
 for(const options of [{existing:{id:'protected',roles:{name:'Administrador'}}},{existing:{id:'existing',roles:{name:'Auditor de Despacho'}},metadata:{tms_profile_id:'different-person'}}]){const f=fixture(options);await assert.rejects(provisionTmsUser(f.wms,f.tms,body));assert.equal(f.calls.profiles.length,0)}
})
test('profile creation failure removes the newly created WMS identity',async()=>{
 const f=fixture({profileError:true});await assert.rejects(provisionTmsUser(f.wms,f.tms,body));assert.deepEqual(f.calls.deleted,['new-wms-id']);assert.equal(f.calls.links,0)
})
test('setup link failure reports saved access and an alternate setup path',async()=>{
 const f=fixture({linkError:true});const result=await provisionTmsUser(f.wms,f.tms,body)
 assert.equal(result.success,true);assert.equal(result.firstAccessUrl,null);assert.match(result.message,/Olvidaste/)
})
