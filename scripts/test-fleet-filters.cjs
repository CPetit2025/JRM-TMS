const {test}=require('node:test'), assert=require('node:assert/strict'), ts=require('typescript'), {readFileSync}=require('node:fs'), Module=require('node:module'), path=require('node:path')
const file=path.resolve(__dirname,'../src/lib/fleet-filters.ts'), mod=new Module(file,module)
mod._compile(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,file)
const {emptyFleetFilters,filterFleetVehicles,filterFleetDrivers}=mod.exports
const carriers=[{id:'own',business_name:'JRM'},{id:'supplier',business_name:'Transportes Pérez'}]
const drivers=[{id:'victor',first_name:'Víctor',last_name:'Medardo',is_active:true,profile_id:'app-victor',carrier_id:'own'}, {id:'inactive',first_name:'José',last_name:'Pérez',is_active:false,carrier_id:'supplier'}]
const vehicles=[{id:'1',plate:'CFO-930',type:'CAMION',status:'DISPONIBLE',carrier_id:'own',assigned_driver_id:'victor',soat_expiration:'2026-10-06',technical_review_expiration:'2027-01-01'}, {id:'2',plate:'ABC-100',type:'MONTACARGAS',status:'MANTENIMIENTO',carrier_id:'own'}, {id:'3',plate:'XYZ-123',type:'CAMION',status:'DISPONIBLE',carrier_id:'supplier',soat_expiration:'2026-10-05',technical_review_expiration:'2027-01-01'}]
const units=filters=>filterFleetVehicles(vehicles,drivers,carriers,{...emptyFleetFilters,...filters},'2026-10-06').map(v=>v.id)
const people=filters=>filterFleetDrivers(drivers,vehicles,carriers,{...emptyFleetFilters,...filters}).map(d=>d.id)
test('combina transporte, transportista, conductor y estado sin mezclar equipos',()=>{
 assert.deepEqual(units({group:'TRANSPORTE',carrier:'own',assignment:'ASIGNADO',status:'DISPONIBLE'}),['1'])
 assert.deepEqual(units({group:'EQUIPOS'}),['2']);assert.deepEqual(units({group:'TRANSPORTE',status:'MANTENIMIENTO'}),[])
})
test('búsqueda normaliza placas y acentos; permite localizar conductor y proveedor',()=>{
 assert.deepEqual(units({search:'cfo930'}),['1']);assert.deepEqual(units({search:'victor medardo'}),['1'])
 assert.deepEqual(units({search:'transportes perez'}),['3']);assert.deepEqual(people({search:'CFO930'}),['victor'])
})
test('vigencia incluye el día de expiración; distingue vencidos e incompletos',()=>{
 assert.deepEqual(units({documents:'VIGENTES'}),['1']);assert.deepEqual(units({documents:'VENCIDOS'}),['3']);assert.deepEqual(units({documents:'INCOMPLETOS'}),['2'])
})
test('conductores usan is_active; filtros de app y unidad se combinan',()=>{
 assert.deepEqual(people({status:'ACTIVO',app:'VINCULADO',assignment:'ASIGNADO'}),['victor'])
 assert.deepEqual(people({status:'INACTIVO',app:'SIN_VINCULAR',assignment:'SIN_ASIGNAR'}),['inactive'])
 assert.deepEqual(people({status:'INACTIVO',assignment:'ASIGNADO'}),[])
})
