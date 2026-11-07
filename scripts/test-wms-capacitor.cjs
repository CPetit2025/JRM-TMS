const assert=require('node:assert/strict')
const vm=require('node:vm')
const ts=require('typescript')
const fs=require('node:fs')
const source=ts.transpileModule(fs.readFileSync('capacitor.config.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText
for(const [env,url,id,start] of [
 [{},'https://jrm-tms.vercel.app','com.jrm.tms','/app/login'],
 [{JRM_APP:'wms-staging'},'https://jrm-tms.vercel.app','com.jrm.tms','/app/login'],
 [{CAPACITOR_APP:'warehouse',JRM_APP:'wms-staging'},'https://jrm-wms-staging.vercel.app','com.jrm.almacen','/almacen/login'],
 [{CAPACITOR_APP:'warehouse',JRM_APP:'wms-production'},'https://jrm-wms.vercel.app','com.jrm.almacen','/almacen/login'],
]){
 const context={exports:{},process:{env}};vm.runInNewContext(source,context)
 const config=context.exports.default;assert.equal(config.server.url,url);assert.equal(config.appId,id);assert.equal(config.server.appStartPath,start)
}
console.log('PASS: warehouse mobile flavor uses WMS only; TMS mobile identity, host and start path stay unchanged.')
