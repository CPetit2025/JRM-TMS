'use client'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { SearchableSelect } from '@/components/ui/SearchableSelect'
import { isValidRuc, type Supplier } from '@/lib/suppliers'
import { toast } from 'sonner'
export type Forklift = { enabled: boolean; supplier_id: string; person_id: string; supplier_personnel_id: string; operator_name: string; document_number: string; license_number: string; license_expiration: string; phone: string; notes: string; hourly_rate: string }
export const EMPTY_FORKLIFT: Forklift = { enabled: false, supplier_id: '', person_id: '', supplier_personnel_id: '', operator_name: '', document_number: '', license_number: '', license_expiration: '', phone: '', notes: '', hourly_rate: '' }
export const forkliftValid = (f: Forklift) => !f.enabled || (!!(f.supplier_id && f.operator_name.trim().length >= 3) && Number.isFinite(Number(f.hourly_rate)) && Number(f.hourly_rate) > 0)
type SupplierPerson = { id: string; supplier_id: string; full_name: string; document_number: string | null; position: string | null; license_number: string | null; license_expiration: string | null; phone: string | null }
const input = 'min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm'
export function ForkliftFields({ value: f, onChange }: { value: Forklift; onChange: (value: Forklift) => void }) {
 const supabase = useMemo(() => createClient(), [])
 const [suppliers, setSuppliers] = useState<Supplier[]>([]), [supplierPeople, setSupplierPeople] = useState<SupplierPerson[]>([])
 const [error, setError] = useState(''), [creating, setCreating] = useState(false), [busy, setBusy] = useState(false)
 const [draft, setDraft] = useState({ tax_id: '', business_name: '', contact_name: '', contact_phone: '' })
 const set = (key: keyof Forklift, value: string | boolean) => onChange({ ...f, [key]: value })
 const loadSupplierPeople = (supplierId: string) => {
  if (!supplierId) { setSupplierPeople([]); return }
  void supabase.from('supplier_personnel').select('id,supplier_id,full_name,document_number,position,license_number,license_expiration,phone')
   .eq('supplier_id', supplierId).eq('is_active', true).order('full_name')
   .then(({ data, error: queryError }) => {
    if (queryError) setError(queryError.message)
    else setSupplierPeople((data || []) as SupplierPerson[])
   })
 }
 useEffect(() => {
  let alive = true
  void supabase.from('suppliers').select('id,tax_id,business_name,category,is_active,contact_name,contact_phone').eq('is_active', true).in('category',['MONTACARGA','SERVICIOS']).order('business_name').then(s => {
   if (!alive) return
   if (s.error) setError(s.error.message || 'No se pudieron cargar los proveedores')
   else setSuppliers(s.data as Supplier[])
  })
  return () => { alive = false }
 }, [supabase])
 useEffect(() => {
  let alive = true
  setSupplierPeople([])
  if (!f.supplier_id) return () => { alive = false }
  void supabase.from('supplier_personnel').select('id,supplier_id,full_name,document_number,position,license_number,license_expiration,phone')
   .eq('supplier_id', f.supplier_id).eq('is_active', true).order('full_name')
   .then(({ data, error: queryError }) => {
    if (!alive) return
    if (queryError) setError(queryError.message)
    else setSupplierPeople((data || []) as SupplierPerson[])
   })
  return () => { alive = false }
 }, [supabase, f.supplier_id])
 const createSupplier = async () => {
  if (!isValidRuc(draft.tax_id.trim()) || !draft.business_name.trim()) { toast.error('Complete un RUC válido y la razón social.'); return }
  setBusy(true)
  try {
   const { data, error } = await supabase.rpc('save_supplier', { p_supplier: { ...draft, tax_id: draft.tax_id.trim(), business_name: draft.business_name.trim(), category: 'MONTACARGA', is_active: true }, p_locations: [] })
   if (error) throw error
   const supplier = { ...draft, id: data as string, is_active: true, category: 'MONTACARGA' } as Supplier
   setSuppliers(prev => [...prev, supplier].sort((a, b) => a.business_name.localeCompare(b.business_name)))
   onChange({ ...f, supplier_id: supplier.id, person_id: '', supplier_personnel_id: '', operator_name: '', document_number: '', license_number: '', license_expiration: '', phone: '' })
   loadSupplierPeople(supplier.id); setCreating(false); setDraft({ tax_id: '', business_name: '', contact_name: '', contact_phone: '' })
   toast.success('Proveedor registrado y seleccionado')
  } catch (e) { toast.error((e as { message?: string }).message || 'No se pudo crear el proveedor') } finally { setBusy(false) }
 }
 return <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
  <label className="flex items-center gap-2 text-sm font-semibold text-[#002855]"><input type="checkbox" checked={f.enabled} onChange={e => set('enabled', e.target.checked)} />Montacarga · requiere apoyo</label>
  {f.enabled && <>
   {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
   <div className="flex items-center justify-between"><span className="text-xs font-semibold">Proveedor de montacarga *</span><button type="button" onClick={() => setCreating(v => !v)} className="min-h-9 text-xs font-semibold text-blue-800">{creating ? 'Cerrar alta' : '+ Nuevo proveedor'}</button></div>
   <SearchableSelect ariaLabel="Proveedor de montacarga" value={f.supplier_id} onChange={id => onChange({ ...f, supplier_id: id, person_id: '', supplier_personnel_id: '', operator_name: '', document_number: '', license_number: '', license_expiration: '', phone: '' })} options={suppliers.map(s => ({ value: s.id, label: `${s.business_name} · ${s.tax_id}` }))} placeholder="Buscar proveedor por razón social o RUC…" />
   {creating && <div className="grid gap-2 rounded-lg border bg-white p-3 sm:grid-cols-2">
    {(['tax_id', 'business_name', 'contact_name', 'contact_phone'] as const).map((key, i) => <label key={key} className="text-xs">{['RUC *', 'Razón social *', 'Contacto', 'Teléfono'][i]}<input aria-label={`Nuevo proveedor · ${['RUC', 'Razón social', 'Contacto', 'Teléfono'][i]}`} className={input} maxLength={key === 'tax_id' ? 11 : 200} value={draft[key]} onChange={e => setDraft({ ...draft, [key]: e.target.value })} /></label>)}
    <button type="button" disabled={busy} onClick={() => void createSupplier()} className="min-h-10 rounded-lg bg-[#002855] px-3 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Guardando…' : 'Registrar proveedor'}</button>
   </div>}
   <label className="block text-xs font-semibold text-slate-600">Tarifa del servicio (S/ por hora) *
    <input aria-label="Tarifa montacarga por hora" className={input} type="number" min="0.01" step="0.01" value={f.hourly_rate} onChange={e => set('hourly_rate', e.target.value)} placeholder="0.00" />
   </label>
   <span className="block text-xs font-semibold">Montacarguista registrado</span>
   <SearchableSelect ariaLabel="Montacarguista registrado" value={f.supplier_personnel_id} onChange={id => {
    const supplierPerson = supplierPeople.find(x => x.id === id && x.supplier_id === f.supplier_id)
    if (supplierPerson) onChange({ ...f, supplier_personnel_id: supplierPerson.id, person_id: '', operator_name: supplierPerson.full_name, document_number: supplierPerson.document_number || '', license_number: supplierPerson.license_number || '', license_expiration: supplierPerson.license_expiration || '', phone: supplierPerson.phone || '' })
   }} options={supplierPeople.filter(p => p.supplier_id === f.supplier_id).map(p => ({ value: p.id, label: `${p.full_name}${p.document_number ? ` · DNI ${p.document_number}` : ''}${p.license_number ? ` · Lic. ${p.license_number}` : ''}` }))} placeholder={f.supplier_id ? 'Buscar personal registrado del proveedor…' : 'Seleccione primero el proveedor…'} />
   <button type="button" onClick={() => onChange({ ...EMPTY_FORKLIFT, enabled: true, supplier_id: f.supplier_id })} className="min-h-9 text-xs font-semibold text-blue-800">Ingresar montacarguista externo</button>
   <div className="grid gap-3 sm:grid-cols-2">
    {(['operator_name', 'document_number', 'license_number', 'license_expiration', 'phone', 'notes'] as const).map((key, i) => <label key={key} className="text-xs font-semibold text-slate-600">{['Montacarguista *', 'DNI / documento', 'Licencia / acreditación', 'Vencimiento de licencia', 'Teléfono', 'Información del servicio'][i]}
     <input aria-label={`Montacarga · ${key}`} className={input} type={key === 'license_expiration' ? 'date' : 'text'} maxLength={key === 'notes' ? 1000 : key === 'phone' || key === 'document_number' ? 50 : key === 'license_number' ? 100 : 200} required={key === 'operator_name'} readOnly={!!f.person_id && (key === 'operator_name' || key === 'document_number')} value={f[key]} onChange={e => set(key, e.target.value)} />
    </label>)}
   </div>
   <p className="text-xs text-slate-500">La tarifa se conserva en la ruta. En Caja se ingresan las horas finales al cerrar la liquidación.</p>
  </>}
 </div>
}
