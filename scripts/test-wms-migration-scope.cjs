const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {prepare}=require('./prepare-wms-migrations.cjs')
test('migration preparation refuses TMS and wrong projects before writing; preserves versions and refuses conflicts',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wms-migration-scope-'))
 try{
  fs.mkdirSync(path.join(root,'supabase/migrations'),{recursive:true});fs.mkdirSync(path.join(root,'supabase/wms/migrations'),{recursive:true})
  const file='20261226150000_wms_example.sql'
  fs.writeFileSync(path.join(root,'supabase/wms/migrations',file),'SELECT 1;')
  assert.throws(()=>prepare(root,{JRM_APP:'tms',SUPABASE_PROJECT_REF:'eojfsbogysifxrlrnjvx'}),/explicit WMS/)
  assert.throws(()=>prepare(root,{JRM_APP:'wms-staging',SUPABASE_PROJECT_REF:'eojfsbogysifxrlrnjvx'}))
  assert.deepEqual(fs.readdirSync(path.join(root,'supabase/migrations')),[])
  const env={JRM_APP:'wms-staging',SUPABASE_PROJECT_REF:'rquujukgtturdlkuzgdc'}
  assert.equal(prepare(root,env),1);assert.equal(prepare(root,env),1)
  assert.equal(fs.readFileSync(path.join(root,'supabase/migrations',file),'utf8'),'SELECT 1;')
  fs.writeFileSync(path.join(root,'supabase/migrations',file),'SELECT 2;')
  assert.throws(()=>prepare(root,env),/Conflicting/)
  assert.equal(fs.readFileSync(path.join(root,'supabase/migrations',file),'utf8'),'SELECT 2;')
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})
