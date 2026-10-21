'use client'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { SearchableSelect } from '@/components/ui/SearchableSelect'
import { isValidRuc, type Supplier } from '@/lib/suppliers'
import { toast } from 'sonner'
export type Forklift = { enabled: boolean; supplier_id: string; person_id: string; operator_name: string; document_number: string; license_number: string; license_expiration: string; phone: string; notes: string }
export const EMPTY_FORKLIFT: Forklift = { enabled: false, supplier_id: '', person_id: '', operator_name: '', document_number: '', license_number: '', license_expiration: '', phone: '', notes: '' }
export const forkliftValid = (f: Forklift) => !f.enabled || !!(f.supplier_id && f.operator_name.trim().length >= 3)
type Candidate = { id: string; code: string; name: string; document_number: string | null; position: string | null; license_number: string | null; license_expiration: string | null; phone: string | null }
const input = 'min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm'
export function ForkliftFields({ value: f, onChange }: { value: Forklift; onChange: (value: Forklift) => void }) {
 const supabase = useMemo(() => createClient(), [])
 const [suppliers, setSuppliers] = useState<Supplier[]>([]), [people, setPeople] = useState<Candidate[]>([])
 const [error, setError] = useState(''), [creating, setCreating] = useState(false), [busy, setBusy] = useState(false)
 const [draft, setDraft] = useState({ tax_id: '', business_name: '', contact_name: '', contact_phone: '' })
 const set = (key: keyof Forklift, value: string | boolean) => onChange({ ...f, [key]: value })
 useEffect(() => {
  let alive = true
  void Promise.all([supabase.from('suppliers').select('id,tax_id,business_name,is_active,contact_name,contact_phone').eq('is_active', true).order('business_name'), supabase.rpc('route_forklift_candidates')]).then(([s, p]) => {
   if (!alive) return
   if (s.error || p.error) setError(s.error?.message || p.error?.message || 'No se pudieron cargar los registros')
   else { setSuppliers(s.data as Supplier[]); setPeople((p.data || []) as Candidate[]) }
  })
  return () => { alive = false }
 }, [supabase])
 const createSupplier = async () => {
  if (!isValidRuc(draft.tax_id.trim()) || !draft.business_name.trim()) { toast.error('Complete un RUC válido y la razón social.'); return }
  setBusy(true)
  try {
   const { data, error } = await supabase.rpc('save_supplier', { p_supplier: { ...draft, tax_id: draft.tax_id.trim(), business_name: draft.business_name.trim(), category: 'SERVICIOS', is_active: true }, p_locations: [] })
   if (error) throw error
   const supplier = { ...draft, id: data as string, is_active: true, category: 'SERVICIOS' } as Supplier
   setSuppliers(prev => [...prev, supplier].sort((a, b) => a.business_name.localeCompare(b.business_name)))
   set('supplier_id', supplier.id); setCreating(false); setDraft({ tax_id: '', business_name: '', contact_name: '', contact_phone: '' })
   toast.success('Proveedor registrado y seleccionado')
  } catch (e) { toast.error((e as { message?: string }).message || 'No se pudo crear el proveedor') } finally { setBusy(false) }
 }
 return <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
  <label className="flex items-center gap-2 text-sm font-semibold text-[#002855]"><input type="checkbox" checked={f.enabled} onChange={e => set('enabled', e.target.checked)} />Montacarga · requiere apoyo</label>
  {f.enabled && <>
   {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
   <div className="flex items-center justify-between"><span className="text-xs font-semibold">Proveedor de montacarga *</span><button type="button" onClick={() => setCreating(v => !v)} className="min-h-9 text-xs font-semibold text-blue-800">{creating ? 'Cerrar alta' : '+ Nuevo proveedor'}</button></div>
   <SearchableSelect ariaLabel="Proveedor de montacarga" value={f.supplier_id} onChange={id => set('supplier_id', id)} options={suppliers.map(s => ({ value: s.id, label: `${s.business_name} · ${s.tax_id}` }))} placeholder="Buscar proveedor por razón social o RUC…" />
   {creating && <div className="grid gap-2 rounded-lg border bg-white p-3 sm:grid-cols-2">
    {(['tax_id', 'business_name', 'contact_name', 'contact_phone'] as const).map((key, i) => <label key={key} className="text-xs">{['RUC *', 'Razón social *', 'Contacto', 'Teléfono'][i]}<input aria-label={`Nuevo proveedor · ${['RUC', 'Razón social', 'Contacto', 'Teléfono'][i]}`} className={input} maxLength={key === 'tax_id' ? 11 : 200} value={draft[key]} onChange={e => setDraft({ ...draft, [key]: e.target.value })} /></label>)}
    <button type="button" disabled={busy} onClick={() => void createSupplier()} className="min-h-10 rounded-lg bg-[#002855] px-3 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Guardando…' : 'Registrar proveedor'}</button>
   </div>}
   <span className="block text-xs font-semibold">Montacarguista registrado</span>
   <SearchableSelect ariaLabel="Montacarguista registrado" value={f.person_id} onChange={id => {
    const p = people.find(x => x.id === id)
    if (p) onChange({ ...f, person_id: p.id, operator_name: p.name, document_number: p.document_number || '', license_number: p.license_number || '', license_expiration: p.license_expiration || '', phone: p.phone || '' })
   }} options={people.map(p => ({ value: p.id, label: `${p.code} · ${p.name}${p.document_number ? ` · ${p.document_number}` : ''}${p.position ? ` · ${p.position}` : ''}` }))} placeholder="Buscar en Personal por código, nombre o DNI…" />
   <button type="button" onClick={() => onChange({ ...EMPTY_FORKLIFT, enabled: true, supplier_id: f.supplier_id })} className="min-h-9 text-xs font-semibold text-blue-800">Ingresar montacarguista externo</button>
   <div className="grid gap-3 sm:grid-cols-2">
    {(['operator_name', 'document_number', 'license_number', 'license_expiration', 'phone', 'notes'] as const).map((key, i) => <label key={key} className="text-xs font-semibold text-slate-600">{['Montacarguista *', 'DNI / documento', 'Licencia / acreditación', 'Vencimiento de licencia', 'Teléfono', 'Información del servicio'][i]}
     <input aria-label={`Montacarga · ${key}`} className={input} type={key === 'license_expiration' ? 'date' : 'text'} maxLength={key === 'notes' ? 1000 : key === 'phone' || key === 'document_number' ? 50 : key === 'license_number' ? 100 : 200} required={key === 'operator_name'} readOnly={!!f.person_id && (key === 'operator_name' || key === 'document_number')} value={f[key]} onChange={e => set(key, e.target.value)} />
    </label>)}
   </div>
   <p className="text-xs text-slate-500">La licencia se completa con la información registrada, si existe. Los costos de descarga se gestionan por separado.</p>
  </>}
 </div>
}
