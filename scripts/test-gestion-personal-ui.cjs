const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), ts = require('typescript')
const React = require('react'), { create, act } = require('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT = true
const wrapper = ({ children, title, subtitle }) => React.createElement('div', null, title, subtitle, children)
function component(rows, calls, name="Attendance") {
 const file = path.resolve(__dirname, '../src/components/personal/gestion.tsx'), m = new Module(file, module)
 m.paths = module.paths
 const response = { day: null, rows, can_confirm: true, can_correct: true }
 const mocks = {
  'next/link': { __esModule: true, default: ({ children }) => React.createElement('a', null, children) },
  sonner: { toast: { success() {} } },
  '@/components/hhee/flujo/context': { Card: wrapper, Field: wrapper, Modal: wrapper, Kpi: wrapper, useFlow: () => ({ctx:{areas:[{id:'area',name:'Distribución',can_request:true}],people:[{id:'person',code:'P01',name:'Colaborador de prueba',active:true,area_id:'area'}]}}) },
  '@/lib/apt/export': { exportAptXlsx() {} },
  '@/lib/hhee/flujo': { today: () => '2026-10-24',fmtDate: String,fmtDateTime: String,fmtHours: String,
   call: async (name,args) => { calls.push({name,args}); if(name==='gp_overview') return {schedules:[]}; if(name==='gp_schedule_batch') return {updated:1}; return name==='gp_day_confirm' ? {...response,day:{id:'day',revision:1,confirmed_at:'2026-10-24'}} : response } },
 }
 m.require = n => mocks[n] ?? require(n)
 m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,file)
 return m.exports[name]
}
const pause = () => new Promise(r=>setTimeout(r,20))
const row = {person_id:'person',name:'Colaborador de prueba',code:'P01',status:'PENDIENTE',permit_minutes:0,note:null,shift:{kind:'TRABAJO',start:'08:00',end:'17:00',minutes:480}}
test('la pantalla solo declara asistencia tras confirmar y envía las excepciones elegidas',async()=>{
 const calls=[], Attendance=component([row],calls);let view
 await act(async()=>{view=create(React.createElement(Attendance))})
 await act(pause)
 assert.equal(calls.filter(c=>c.name==='gp_day_confirm').length,0)
 assert.match(JSON.stringify(view.toJSON()),/Día pendiente de confirmación/)
 const absent=view.root.findByProps({'aria-label':'Marcar ausencia de Colaborador de prueba'})
 await act(async()=>absent.props.onChange({target:{checked:true}}))
 const confirm=view.root.findAllByType('button').find(b=>b.children.includes('Confirmar asistencia del día'))
 assert.equal(confirm.props.disabled,false)
 await act(async()=>confirm.props.onClick())
 const payload=calls.find(c=>c.name==='gp_day_confirm').args.p
 assert.deepEqual(payload.absences,[{person_id:'person',note:'Ausencia por justificar'}])
 assert.equal(payload.revision,0)
 assert.match(JSON.stringify(view.toJSON()),/Confirmado:/)
 await act(async()=>view.unmount())
})
test('sin horario programado la pantalla bloquea la confirmación',async()=>{
 const calls=[], Attendance=component([{...row,shift:{kind:'SIN_HORARIO',minutes:null}}],calls);let view
 await act(async()=>{view=create(React.createElement(Attendance))})
 await act(pause)
 const confirm=view.root.findAllByType('button').find(b=>b.children.includes('Confirmar asistencia del día'))
 assert.equal(confirm.props.disabled,true)
 assert.match(JSON.stringify(view.toJSON()),/Falta programar horario/)
 assert.equal(calls.filter(c=>c.name==='gp_day_confirm').length,0)
 await act(async()=>view.unmount())
})

test('jornada base se revisa y se guarda solo para la selección explícita desde octubre',async()=>{
 const calls=[], Schedules=component([],calls,'Schedules');let view
 await act(async()=>{view=create(React.createElement(Schedules))})
 const button=text=>view.root.findAllByType('button').find(b=>b.children.includes(text))
 await act(async()=>button('Cargar jornada base en el formulario').props.onClick())
 const times=view.root.findAllByType('input').filter(i=>i.props.type==='time').map(i=>i.props.value)
 assert.deepEqual(times,['08:00','17:30','08:00','17:30','08:00','17:30','08:00','17:30','08:00','17:30','08:00','13:30'])
 const batch=view.root.findAllByType('label').find(l=>l.children.some(c=>typeof c==='string'&&c.includes('Aplicar esta jornada')))
 await act(async()=>batch.findByType('input').props.onChange({target:{checked:true}}))
 await act(async()=>button('Seleccionar todos los autorizados').props.onClick())
 assert.equal(calls.filter(c=>c.name==='gp_schedule_batch').length,0)
 await act(async()=>button('Guardar jornada para la selección').props.onClick())
 const p=calls.find(c=>c.name==='gp_schedule_batch').args.p
 assert.deepEqual(p.people,['person']);assert.equal(p.from,'2026-10-01');assert.equal(p.week[0].break_minutes,60);assert.equal(p.week[6].kind,'DESCANSO')
 await act(async()=>view.unmount())
})
