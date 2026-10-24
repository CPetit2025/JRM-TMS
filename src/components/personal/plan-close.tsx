'use client'
import { useState } from 'react'
import { Modal, Field, inputCls, btnCls } from '@/components/hhee/flujo/context'
import { call, limaLocal, type Line } from '@/lib/hhee/flujo'
export function PlanClose({line,version,onClose,onSaved}:{line:Line;version:number;onClose:()=>void;onSaved:()=>Promise<void>}) {
 const local=(v?:string|null)=>v?limaLocal(v).slice(0,16):''
 const [f,setF]=useState({start:local(line.actual_start||line.start),end:local(line.actual_end||line.end),meal_start:local(line.actual_meal ? line.actual_meal.start : line.work_plan?.meal_start),meal_end:local(line.actual_meal ? line.actual_meal.end : line.work_plan?.meal_end),no_meal_reason:line.actual_meal?.reason||line.work_plan?.no_meal_reason||'',reason:''})
 const [busy,setBusy]=useState(false),[error,setError]=useState('')
 return <Modal title={`Ejecución real · ${line.name}`} onClose={onClose}><form className="grid gap-3" onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{await call('gp_plan_close',{p:{line_id:line.id,version,...f}});await onSaved();onClose()}catch(e){setError(e instanceof Error?e.message:'No se pudo registrar')}finally{setBusy(false)}}}>
 <p className="text-sm">Se excluye la jornada ordinaria congelada al planificar. Ubique el refrigerio realmente tomado. Este cierre requiere validación posterior para acreditar saldo.</p>
 {(['start','end','meal_start','meal_end'] as const).map((k,i)=><Field key={k} label={['Inicio real','Fin real','Inicio refrigerio real','Fin refrigerio real'][i]}><input type="datetime-local" required={i<2} className={inputCls} value={f[k]} onChange={e=>setF({...f,[k]:e.target.value})}/></Field>)}
 <Field label="Motivo si no hubo refrigerio en la ejecución"><input className={inputCls} value={f.no_meal_reason} onChange={e=>setF({...f,no_meal_reason:e.target.value})}/></Field>
 <Field label="Sustento del cierre o corrección"><input required minLength={5} maxLength={300} className={inputCls} value={f.reason} onChange={e=>setF({...f,reason:e.target.value})}/></Field>
 {error&&<p role="alert" className="text-red-800">{error}</p>}<button disabled={busy} className={btnCls}>Registrar ejecución por tramos</button>
 </form></Modal>
}
