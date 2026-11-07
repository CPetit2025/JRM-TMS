// Metadata only. Never prints secret values, downloads rows or applies database changes.
'use strict'
const fs = require('node:fs')
const target = process.env.AUDIT_TARGET
const refs = { staging: 'rquujukgtturdlkuzgdc', production: 'glecgvomkaqmkfkhtxhi' }
async function main() {
 if (!refs[target]) throw Error('Invalid audit target')
 const report = { configured_ref_matches: process.env.SUPABASE_PROJECT_REF === refs[target], target, expected_ref: refs[target], missing: [], supabase: 'not checked', vercel: 'not checked' }
 for (const name of ['WMS_SUPABASE_ACCESS_TOKEN','WMS_SUPABASE_DB_PASSWORD','WMS_VERCEL_TOKEN','WMS_VERCEL_PROJECT_ID','WMS_VERCEL_ORG_ID','SUPABASE_PROJECT_REF']) {
   if (!process.env[name]) report.missing.push(name)
 }
 if (process.env.SUPABASE_PROJECT_REF && process.env.SUPABASE_PROJECT_REF !== refs[target]) report.supabase = 'configured project ref mismatch'
 if (process.env.WMS_SUPABASE_ACCESS_TOKEN) {
   const response = await fetch(`https://api.supabase.com/v1/projects/${refs[target]}`, { headers: { Authorization: `Bearer ${process.env.WMS_SUPABASE_ACCESS_TOKEN}` }, signal: AbortSignal.timeout(20000) })
   report.supabase = `HTTP ${response.status}`
   if (response.ok) {
     const project = await response.json()
     report.supabase = project.id === refs[target] ? 'access verified' : 'response project mismatch'
     report.database_status = project.status
   }
 }
 if (process.env.WMS_VERCEL_TOKEN && process.env.WMS_VERCEL_PROJECT_ID && process.env.WMS_VERCEL_ORG_ID) {
   const query = new URLSearchParams({teamId:process.env.WMS_VERCEL_ORG_ID})
   const response = await fetch(`https://api.vercel.com/v9/projects/${encodeURIComponent(process.env.WMS_VERCEL_PROJECT_ID)}?${query}`, { headers:{Authorization:`Bearer ${process.env.WMS_VERCEL_TOKEN}`}, signal:AbortSignal.timeout(20000) })
   report.vercel = `HTTP ${response.status}`
   if (response.ok) {
     const project = await response.json()
     report.git_connected = Boolean(project.link)
     report.vercel = project.name === (target === 'staging' ? 'jrm-wms-staging' : 'jrm-wms') ? 'dedicated project verified' : 'project name mismatch; deployment must remain blocked'
   }
 }
 const file=`wms-environment-${target}.json`
 fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n')
 const summary='```json\n'+JSON.stringify(report,null,2)+'\n```\n'
 if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,summary)
 console.log(summary)
 if(report.missing.length || !report.configured_ref_matches || report.git_connected || report.supabase!=='access verified' || report.vercel!=='dedicated project verified')process.exitCode=1
}
main().catch(()=>{console.error('Environment metadata audit failed; no database changes were attempted.');process.exitCode=1})
