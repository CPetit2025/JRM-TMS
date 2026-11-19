'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Plus, RefreshCw, Truck } from 'lucide-react'

type VehicleType={code:string;name:string;capacity_kg:number|null;capacity_pallets:number|null;capacity_m3:number|null;active:boolean;updated_at:string}
const empty={code:'',name:'',kg:'',pallets:'',m3:''}
const num=(v:string)=>v.trim()===''?null:Number(v)
const cap=(v:number|null,u:string)=>v===null?`${u}: sin dato`:`${Number(v).toLocaleString('es-PE')} ${u}`

/** Tipos de unidad de carga con su capacidad: alimentan la alerta de capacidad de Despacho (nunca bloquea). */
export default function WarehouseVehicleTypesPage(){
 const [rows,setRows]=useState<VehicleType[]>([]),[form,setForm]=useState(empty),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
 const load=useCallback(async()=>{setLoading(true);const {data,error}=await createClient().from('wh_vehicle_types').select('code,name,capacity_kg,capacity_pallets,capacity_m3,active,updated_at').order('name');if(error)setError(error.message);else setRows((data||[]) as VehicleType[]);setLoading(false)},[])
 // eslint-disable-next-line react-hooks/set-state-in-effect
 useEffect(()=>{void load()},[load])
 const save=async(r:{code:string;name:string;kg:number|null;pallets:number|null;m3:number|null;active:boolean},text:string)=>{setBusy(true);setError('');setNotice('');const {error}=await createClient().rpc('wh_vehicle_type_save',{p_code:r.code,p_name:r.name,p_capacity_kg:r.kg,p_capacity_pallets:r.pallets,p_capacity_m3:r.m3,p_active:r.active});if(error)setError(error.message);else{setNotice(text);await load()}setBusy(false);return !error}
 const submit=async(e:FormEvent)=>{e.preventDefault();if(await save({code:form.code,name:form.name,kg:num(form.kg),pallets:num(form.pallets),m3:num(form.m3),active:true},`Tipo ${form.code.toUpperCase()} guardado.`))setForm(empty)}
 const edit=(r:VehicleType)=>setForm({code:r.code,name:r.name,kg:r.capacity_kg?.toString()??'',pallets:r.capacity_pallets?.toString()??'',m3:r.capacity_m3?.toString()??''})
 const field='mt-1 w-full rounded-lg border px-3 py-2.5 font-normal'
 return <div className="w-full space-y-5"><header className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-widest text-blue-700">Maestros · Supervisión</p><h1 className="mt-1 text-3xl font-black text-[#002855]">Tipos de unidad de carga</h1><p className="mt-1 text-sm text-slate-600">Capacidad en peso, pallets y volumen. Despacho avisa si lo asignado la supera, sin bloquear; una capacidad vacía se informa como «no calculable».</p></div><button onClick={()=>void load()} className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold"><RefreshCw size={16}/>Actualizar</button></header>
 {error&&<p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</p>}{notice&&<p role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}
 <form onSubmit={submit} className="grid gap-3 rounded-xl border bg-white p-5 sm:grid-cols-[1fr_1.4fr_1fr_1fr_1fr_auto] sm:items-end">
  <label className="text-sm font-semibold">Código<input required maxLength={30} pattern="[A-Za-z0-9_\-]{2,30}" value={form.code} onChange={e=>setForm({...form,code:e.target.value})} placeholder="CAMION_10T" className={field}/></label>
  <label className="text-sm font-semibold">Nombre<input required maxLength={80} value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="Camión 10 t" className={field}/></label>
  <label className="text-sm font-semibold">Capacidad kg<input type="number" min="0.001" step="0.001" value={form.kg} onChange={e=>setForm({...form,kg:e.target.value})} className={field}/></label>
  <label className="text-sm font-semibold">Pallets<input type="number" min="1" step="1" value={form.pallets} onChange={e=>setForm({...form,pallets:e.target.value})} className={field}/></label>
  <label className="text-sm font-semibold">Volumen m³<input type="number" min="0.001" step="0.001" value={form.m3} onChange={e=>setForm({...form,m3:e.target.value})} className={field}/></label>
  <button disabled={busy} className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#002855] px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50"><Plus size={16}/>Guardar</button></form>
 <section className="overflow-hidden rounded-xl border bg-white"><header className="flex items-center gap-2 border-b p-4"><Truck size={18} className="text-blue-700"/><h2 className="font-bold text-[#002855]">Tipos registrados · {rows.length}</h2></header>{loading?<p className="p-8 text-center text-sm text-slate-500">Cargando tipos…</p>:rows.length===0?<p className="p-8 text-center text-sm text-slate-500">No hay tipos de unidad. Sin tipo, Despacho no puede calcular la capacidad.</p>:<div className="divide-y">{rows.map(r=><article key={r.code} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"><div><b className="text-[#002855]">{r.name}</b><small className="ml-2 font-mono text-slate-500">{r.code}</small>{!r.active&&<small className="ml-2 rounded bg-slate-100 px-2 text-slate-600">Inactivo</small>}<small className="block text-slate-600">{cap(r.capacity_kg,'kg')} · {cap(r.capacity_pallets,'pallets')} · {cap(r.capacity_m3,'m³')}</small><small className="block text-xs text-slate-400">Actualizado {new Date(r.updated_at).toLocaleString('es-PE')}</small></div><div className="flex gap-2"><button disabled={busy} onClick={()=>edit(r)} className="rounded-lg border px-3 py-2 text-xs font-semibold">Editar</button><button disabled={busy} onClick={()=>void save({code:r.code,name:r.name,kg:r.capacity_kg,pallets:r.capacity_pallets,m3:r.capacity_m3,active:!r.active},r.active?`${r.code} desactivado.`:`${r.code} activado.`)} className="rounded-lg border px-3 py-2 text-xs font-semibold">{r.active?'Desactivar':'Activar'}</button></div></article>)}</div>}</section></div>
}
