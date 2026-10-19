// Real PostgreSQL regression with a production-like profile schema, isolated from all linked databases.
const {spawnSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path')
const root=path.resolve(__dirname,'..'),name='jrm-hhee-test-'+process.pid+'-'+Date.now()
function docker(args,input){
 const r=spawnSync('docker',args,{input,encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024})
 if(r.error)throw r.error
 return {status:r.status,output:(r.stdout||'')+(r.stderr||'')}
}
function sql(file){return docker(['exec','-i',name,'psql','-U','postgres','-v','ON_ERROR_STOP=1'],fs.readFileSync(path.join(root,file),'utf8'))}
async function main(){
 try{
  const start=docker(['run','-d','--rm','--network','none','--name',name,'-e','POSTGRES_PASSWORD=isolated-local-test','postgres:16-alpine'])
  if(start.status!==0)throw Error('No se pudo iniciar PostgreSQL aislado: '+start.output)
  let ready=false
  for(let i=0;i<40;i++){
   if(docker(['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres']).status===0){ready=true;break}
   await new Promise(resolve=>setTimeout(resolve,250))
  }
  if(!ready)throw Error('PostgreSQL no inició dentro del límite de la prueba.')
  for(const file of ['scripts/fixtures/hhee-schema.sql','supabase/migrations/20261020210000_hhee_control.sql','supabase/migrations/20261020220000_hhee_production_scope.sql']){
   const result=sql(file);if(result.status!==0)throw Error(file+'\n'+result.output)
  }
  for(const [file,label] of [['supabase/tests/caja_c120_hhee.test.sql','C120'],['supabase/tests/caja_c121_hhee_operacion.test.sql','C121']]){
   const result=sql(file)
   // These suites deliberately throw PASS to force a rollback, including changes to test profiles and roles.
   if(!result.output.includes('CAJA '+label+' PASS')||result.output.includes('CAJA '+label+' FAIL'))throw Error(file+'\n'+result.output)
   console.log('PASS HHEE PostgreSQL '+label+': producción con profiles.area y roles.name VARCHAR(50).')
  }
 }finally{docker(['rm','-f',name])}
}
main().catch(error=>{console.error(error.message);process.exitCode=1})
