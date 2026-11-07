'use strict'
const fs=require('node:fs')
const path=require('node:path')
const {checkTarget}=require('./check-supabase-target.cjs')
function prepare(root,env){
 if(!['wms-staging','wms-production'].includes(env.JRM_APP))throw Error('Preparing WMS migrations requires an explicit WMS application identity')
 const errors=checkTarget({app:env.JRM_APP,ref:env.SUPABASE_PROJECT_REF,url:env.NEXT_PUBLIC_SUPABASE_URL,strict:true})
 if(errors.length)throw Error(errors.join(' '))
 const source=path.join(root,'supabase/wms/migrations'),destination=path.join(root,'supabase/migrations')
 const files=fs.readdirSync(source).filter(f=>f.endsWith('.sql'))
 const versions=new Map(fs.readdirSync(destination).filter(f=>f.endsWith('.sql')).map(f=>[f.split('_')[0],f]))
 // Validate the full plan before copying a single file. Existing names/content are never overwritten.
 for(const file of files){
  const existing=versions.get(file.split('_')[0])
  if(existing && (existing!==file || !fs.readFileSync(path.join(destination,existing)).equals(fs.readFileSync(path.join(source,file)))))throw Error('Conflicting migration version: '+file)
  versions.set(file.split('_')[0],file)
 }
 for(const file of files)if(!fs.existsSync(path.join(destination,file)))fs.copyFileSync(path.join(source,file),path.join(destination,file),fs.constants.COPYFILE_EXCL)
 return files.length
}
module.exports={prepare}
if(require.main===module){try{console.log(`Prepared ${prepare(path.resolve(__dirname,'..'),process.env)} WMS migration files in the isolated runner.`)}catch(error){console.error(error.message);process.exitCode=1}}
