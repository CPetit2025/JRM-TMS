const {test}=require('node:test'),assert=require('node:assert/strict'),ts=require('typescript'),{readFileSync}=require('node:fs'),Module=require('node:module'),path=require('node:path')
const file=path.resolve(__dirname,'../src/lib/request-schedule.ts'),mod=new Module(file,module)
mod._compile(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,file)
const {serviceDate,withRescheduling,wasRescheduled}=mod.exports
const event={request_id:'RT-20',fecha_anterior:'2026-10-08',fecha_nueva:'2026-10-12',at:'2026-10-06T14:00:00Z'}
test('cancelar la ruta y volver a APROBADA conserva el rótulo de reprogramación',()=>{
 const [request]=withRescheduling([{id:'RT-20',status:'APROBADA',required_date:'2026-10-12'}],[event]);assert.equal(wasRescheduled(request),true);assert.equal(serviceDate(request.required_date),'12/10/2026')
 assert.equal(wasRescheduled({status:'REPROGRAMADA'}),true);assert.equal(wasRescheduled({status:'APROBADA'}),false)
})
test('historial se enlaza por solicitud y nunca reemplaza la fecha vigente editada',()=>{
 const requests=withRescheduling([{id:'RT-20',required_date:'2026-10-14'},{id:'RT-21',required_date:'2026-10-09'}],[event])
 assert.equal(requests[0].required_date,'2026-10-14');assert.equal(requests[0].rescheduling.fecha_nueva,'2026-10-12');assert.equal(requests[1].rescheduling,undefined)
})
test('fecha civil mantiene su día en Lima y otras zonas horarias',()=>{
 const previous=process.env.TZ;try{for(const zone of ['America/Lima','UTC','Pacific/Kiritimati']){process.env.TZ=zone;assert.equal(serviceDate('2026-10-12'),'12/10/2026')}}finally{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous}
 assert.equal(serviceDate(null),'Sin fecha')
})
