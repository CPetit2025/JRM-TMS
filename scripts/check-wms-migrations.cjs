'use strict'
const fs=require('node:fs')
const path=require('node:path')
function checkWmsMigrations(root) {
 const base=path.join(root,'supabase/migrations'),wms=path.join(root,'supabase/wms/migrations')
 const errors=[]
 const baseFiles=fs.readdirSync(base).filter(f=>f.endsWith('.sql'))
 if(baseFiles.some(f=>/_(?:wms_|warehouse_wms_|wh_task_)/.test(f)))errors.push('WMS migration found in the TMS migration directory')
 const files=fs.readdirSync(wms).filter(f=>f.endsWith('.sql'))
 const versions=new Set(baseFiles.map(f=>f.split('_')[0]))
 for(const file of files){const version=file.split('_')[0];if(versions.has(version))errors.push('Duplicate migration version: '+version);versions.add(version)}
 const sql=files.map(f=>fs.readFileSync(path.join(wms,f),'utf8')).join('\n')
 for(const match of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?public\.([a-z0-9_]+)/gi)){
  const table=match[1]
  if(!table.startsWith('wh_'))errors.push('Unexpected table in WMS migrations: '+table)
  const policy=new RegExp(`CREATE POLICY security_active_account ON public\\.${table}\\s+AS RESTRICTIVE\\s+FOR ALL\\s+TO authenticated\\s+USING\\s*\\(\\s*\\(\\s*SELECT public\\.is_active_tms_user\\(\\)\\s*\\)\\s*\\)\\s*WITH CHECK\\s*\\(\\s*\\(\\s*SELECT public\\.is_active_tms_user\\(\\)\\s*\\)\\s*\\)`, 'i')
  if(!policy.test(sql))errors.push('Missing active-account restriction: '+table)
  if(!new RegExp(`REVOKE ALL ON (?:TABLE )?public\\.${table} FROM[^;]*authenticated`,'i').test(sql))errors.push('Missing explicit privilege revocation: '+table)
 }
 return errors
}
module.exports={checkWmsMigrations}
if(require.main===module){const errors=checkWmsMigrations(path.resolve(__dirname,'..'));if(errors.length){console.error(errors.join('\n'));process.exitCode=1}else console.log('PASS: WMS migrations isolated from TMS, unique versions and active-account/privilege barriers preserved.')}
