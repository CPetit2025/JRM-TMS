'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pencil, Plus, Truck, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import type { SupplierCategory } from '@/lib/suppliers'

type Person = { id: string; full_name: string; document_number: string | null; position: string | null; phone: string | null; email: string | null; license_number: string | null; license_expiration: string | null; notes: string | null; is_active: boolean }
type Unit = { id: string; personnel_id: string | null; plate: string; unit_type: string; brand: string | null; model: string | null; year: number | null; capacity_tons: number | null; soat_expiration: string | null; technical_review_expiration: string | null; is_active: boolean; notes: string | null }
type Form = Record<string, string>
const emptyPerson: Form = { full_name: '', document_number: '', position: 'Conductor', phone: '', email: '', license_number: '', license_expiration: '', notes: '' }
const emptyUnit: Form = { plate: '', unit_type: 'CAMION', brand: '', model: '', year: '', capacity_tons: '', soat_expiration: '', technical_review_expiration: '', personnel_id: '', notes: '' }
const input = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm'

export function SupplierFleetManager({ supplierId, category, canManage }: { supplierId: string; category: SupplierCategory; canManage: boolean }) {
 const db = useMemo(() => createClient(), [])
 const [people, setPeople] = useState<Person[]>([]), [units, setUnits] = useState<Unit[]>([])
 const [kind, setKind] = useState<'person' | 'unit'>('person'), [form, setForm] = useState<Form | null>(null), [editingId, setEditingId] = useState(''), [busy, setBusy] = useState(false)
 const transport = category === 'TRANSPORTE'
 const load = useCallback(async () => {
  const [p, u] = await Promise.all([
   db.from('supplier_personnel').select('id,full_name,document_number,position,phone,email,license_number,license_expiration,notes,is_active').eq('supplier_id', supplierId).order('full_name'),
   db.from('supplier_vehicles').select('id,personnel_id,plate,unit_type,brand,model,year,capacity_tons,soat_expiration,technical_review_expiration,is_active,notes').eq('supplier_id', supplierId).order('plate'),
  ])
  if (p.error || u.error) toast.error(`No se pudo cargar el personal o equipos: ${p.error?.message || u.error?.message}`)
  setPeople((p.data || []) as Person[]); setUnits((u.data || []) as Unit[])
 }, [db, supplierId])
 // eslint-disable-next-line react-hooks/set-state-in-effect
 useEffect(() => { void load() }, [load])
 const open = (next: 'person' | 'unit', row?: Person | Unit) => {
  setKind(next); setEditingId(row?.id || '')
  setForm(row ? Object.fromEntries(Object.entries(row).map(([k,v]) => [k, v == null ? '' : String(v)])) : { ...(next === 'person' ? emptyPerson : emptyUnit) })
 }
 const save = async () => {
  if (!form) return
  setBusy(true)
  let result: { error: { message: string } | null }
  if (kind === 'person') {
   const payload = {
   supplier_id: supplierId, full_name: form.full_name.trim(), document_number: form.document_number.trim() || null,
   position: form.position.trim() || null, phone: form.phone.trim() || null, email: form.email.trim() || null,
   license_number: form.license_number.trim() || null, license_expiration: form.license_expiration || null, notes: form.notes.trim() || null,
   }
   result = editingId ? await db.from('supplier_personnel').update(payload).eq('id', editingId) : await db.from('supplier_personnel').insert(payload)
  } else {
   const payload = {
   supplier_id: supplierId, plate: form.plate.toUpperCase().replace(/\s/g, ''), unit_type: form.unit_type.trim(), brand: form.brand.trim() || null,
   model: form.model.trim() || null, year: form.year ? Number(form.year) : null, capacity_tons: form.capacity_tons ? Number(form.capacity_tons) : null,
   soat_expiration: form.soat_expiration || null, technical_review_expiration: form.technical_review_expiration || null,
   personnel_id: form.personnel_id || null, notes: form.notes.trim() || null,
   }
   result = editingId ? await db.from('supplier_vehicles').update(payload).eq('id', editingId) : await db.from('supplier_vehicles').insert(payload)
  }
  setBusy(false)
  if (result.error) { toast.error(`No se pudo guardar: ${result.error.message}`); return }
  toast.success(kind === 'person' ? 'Personal del proveedor guardado' : 'Unidad del proveedor guardada')
  setForm(null); await load()
 }
 const toggle = async (type: 'person' | 'unit', row: Person | Unit) => {
  const table = type === 'person' ? 'supplier_personnel' : 'supplier_vehicles'
  const { error } = await db.from(table).update({ is_active: !row.is_active }).eq('id', row.id)
  if (error) toast.error(error.message); else void load()
 }
 return <section className="space-y-3 rounded-xl border border-slate-200 p-3">
  <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-semibold text-slate-800">Personal y equipos del proveedor</h3><p className="text-xs text-slate-500">Registros vinculados a esta empresa y reutilizables al programar rutas.</p></div>
   {canManage && <div className="flex gap-2"><button type="button" onClick={() => open('person')} className="inline-flex min-h-9 items-center gap-1 rounded-lg border px-3 text-xs font-semibold"><UserRound className="h-4 w-4" />Agregar persona</button>{transport && <button type="button" onClick={() => open('unit')} className="inline-flex min-h-9 items-center gap-1 rounded-lg border px-3 text-xs font-semibold"><Truck className="h-4 w-4" />Agregar placa</button>}</div>}
  </div>
  <div className="grid gap-3 lg:grid-cols-2">
   <div className="overflow-x-auto rounded-lg border"><table className="w-full text-left text-xs"><thead className="bg-slate-50"><tr><th className="p-2">Nombre / DNI</th><th className="p-2">Licencia</th><th className="p-2">Estado</th>{canManage && <th className="p-2" />}</tr></thead><tbody className="divide-y">
    {!people.length ? <tr><td colSpan={canManage ? 4 : 3} className="p-3 text-slate-400">Sin personal registrado.</td></tr> : people.map(p => <tr key={p.id} className={!p.is_active ? 'opacity-50' : ''}><td className="p-2 font-medium">{p.full_name}<span className="block text-slate-500">{p.position || 'Personal'}{p.document_number ? ` · ${p.document_number}` : ''}{p.phone ? ` · ${p.phone}` : ''}</span></td><td className="p-2">{p.license_number || '—'}{p.license_expiration ? <span className="block text-slate-500">Vence {p.license_expiration}</span> : null}</td><td className="p-2">{p.is_active ? 'Activo' : 'Inactivo'}</td>{canManage && <td className="p-2 whitespace-nowrap"><button type="button" title="Editar" onClick={() => open('person', p)} className="rounded p-1"><Pencil className="h-3.5 w-3.5" /></button><button type="button" onClick={() => void toggle('person', p)} className="px-1 text-blue-700">{p.is_active ? 'Desactivar' : 'Activar'}</button></td>}</tr>)}
   </tbody></table></div>
   {transport && <div className="overflow-x-auto rounded-lg border"><table className="w-full text-left text-xs"><thead className="bg-slate-50"><tr><th className="p-2">Placa / tipo</th><th className="p-2">Unidad / capacidad</th><th className="p-2">Conductor base</th><th className="p-2">Estado</th>{canManage && <th className="p-2" />}</tr></thead><tbody className="divide-y">
    {!units.length ? <tr><td colSpan={canManage ? 5 : 4} className="p-3 text-slate-400">Sin placas registradas.</td></tr> : units.map(v => <tr key={v.id} className={!v.is_active ? 'opacity-50' : ''}><td className="p-2 font-semibold">{v.plate}<span className="block font-normal text-slate-500">{v.unit_type}</span></td><td className="p-2">{[v.brand,v.model,v.year].filter(Boolean).join(' ') || '—'}{v.capacity_tons ? <span className="block text-slate-500">{v.capacity_tons} t</span> : null}</td><td className="p-2">{people.find(p => p.id === v.personnel_id)?.full_name || '—'}</td><td className="p-2">{v.is_active ? 'Activa' : 'Inactiva'}</td>{canManage && <td className="p-2 whitespace-nowrap"><button type="button" title="Editar" onClick={() => open('unit', v)} className="rounded p-1"><Pencil className="h-3.5 w-3.5" /></button><button type="button" onClick={() => void toggle('unit', v)} className="px-1 text-blue-700">{v.is_active ? 'Desactivar' : 'Activar'}</button></td>}</tr>)}
   </tbody></table></div>}
  </div>
  {form && <div role="dialog" aria-modal="true" className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/40 p-4" onClick={() => !busy && setForm(null)}><div className="max-h-[90vh] w-full max-w-xl space-y-3 overflow-auto rounded-xl bg-white p-5 shadow-2xl" onClick={e => e.stopPropagation()}>
   <div className="flex items-center justify-between"><h3 className="font-bold">{editingId ? 'Editar' : 'Registrar'} {kind === 'person' ? 'personal del proveedor' : 'unidad'}</h3><button type="button" onClick={() => setForm(null)} aria-label="Cerrar">×</button></div>
   {kind === 'person' ? <div className="grid gap-2 sm:grid-cols-2">{(['full_name','document_number','position','phone','email','license_number','license_expiration','notes'] as const).map((k,i) => <label key={k} className={`text-xs font-semibold ${k==='full_name'||k==='notes'?'sm:col-span-2':''}`}>{['Nombre completo *','DNI / CE','Cargo','Teléfono','Correo','Licencia / acreditación','Vence licencia','Notas'][i]}<input className={input} type={k==='license_expiration'?'date':'text'} value={form[k] || ''} onChange={e => setForm({...form,[k]:e.target.value})} /></label>)}</div>
    : <div className="grid gap-2 sm:grid-cols-2">{(['plate','unit_type','brand','model','year','capacity_tons','soat_expiration','technical_review_expiration'] as const).map((k,i) => <label key={k} className="text-xs font-semibold">{['Placa *','Tipo de unidad *','Marca','Modelo','Año','Capacidad (t)','Vencimiento SOAT','Revisión técnica'][i]}<input className={input} type={k.includes('expiration')?'date':k==='year'||k==='capacity_tons'?'number':'text'} placeholder={k==='plate' ? 'ABC123 · tracto/semirremolque: ABC123/XYZ987' : undefined} value={form[k] || ''} onChange={e => setForm({...form,[k]:e.target.value})} /></label>)}<label className="text-xs font-semibold sm:col-span-2">Conductor habitual<select className={input} value={form.personnel_id || ''} onChange={e => setForm({...form,personnel_id:e.target.value})}><option value="">Sin asignar</option>{people.filter(p => p.is_active).map(p => <option key={p.id} value={p.id}>{p.full_name} · {p.document_number || 'sin DNI'}</option>)}</select></label></div>}
   <div className="flex justify-end gap-2"><button type="button" disabled={busy} onClick={() => setForm(null)} className="rounded-lg border px-3 py-2 text-sm">Cancelar</button><button type="button" disabled={busy || (kind==='person'?!form.full_name?.trim():!form.plate?.trim()||!form.unit_type?.trim())} onClick={() => void save()} className="inline-flex items-center gap-1 rounded-lg bg-[#002855] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"><Plus className="h-4 w-4" />Guardar</button></div>
  </div></div>}
 </section>
}
