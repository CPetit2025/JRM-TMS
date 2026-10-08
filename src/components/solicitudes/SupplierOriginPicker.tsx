"use client"
import { useState } from 'react'
import { Loader2, MapPinPlus, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { SearchableSelect } from '@/components/ui/SearchableSelect'
import { isValidRuc, SUPPLIER_CATEGORIES, type Supplier, type SupplierCategory, type SupplierLocation } from '@/lib/suppliers'

type Origin = {
  supplier_id: string; supplier_location_id: string
  pickup_address: string; pickup_department: string; pickup_province: string; pickup_district: string
  pickup_contact: string; pickup_phone: string
}
type Point = { name: string; address: string; department: string; province: string; district: string; contact_name: string; contact_phone: string }
const EMPTY_POINT: Point = { name: '', address: '', department: '', province: '', district: '', contact_name: '', contact_phone: '' }
const input = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-[#002855] disabled:bg-slate-100'

function originFrom(point: SupplierLocation | Point, prev: Origin): Partial<Origin> {
  return { pickup_address: point.address, pickup_department: point.department || '', pickup_province: point.province || '', pickup_district: point.district || '',
    pickup_contact: point.contact_name || prev.pickup_contact, pickup_phone: point.contact_phone || prev.pickup_phone }
}

/** Proveedor de origen y punto de recojo, con alta rápida de ambos sin salir de la solicitud. */
export function SupplierOriginPicker({ suppliers, value, onChange, reload }: {
  suppliers: Supplier[]; value: Origin
  onChange: (patch: Partial<Origin>) => void
  reload: () => Promise<Supplier[]>
}) {
  const supabase = createClient()
  const [mode, setMode] = useState<'' | 'supplier' | 'point'>('')
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState({ tax_id: '', business_name: '', category: 'MATERIA_PRIMA' as SupplierCategory, contact_name: '', contact_phone: '' })
  const [point, setPoint] = useState<Point>(EMPTY_POINT)
  const supplier = suppliers.find(s => s.id === value.supplier_id)
  const points = (supplier?.supplier_locations || []).filter(l => l.is_active)
  const canSaveOrigin = Boolean(supplier && !value.supplier_location_id && value.pickup_address.trim() && value.pickup_district.trim())

  const selectSupplier = (id: string, list = suppliers) => {
    if (id === value.supplier_id) return
    const active = (list.find(s => s.id === id)?.supplier_locations || []).filter(l => l.is_active)
    const cleared: Origin = { ...value, supplier_id: id, supplier_location_id: '', pickup_address: '', pickup_department: '', pickup_province: '', pickup_district: '', pickup_contact: '', pickup_phone: '' }
    onChange(active.length === 1 ? { ...cleared, supplier_location_id: active[0].id!, ...originFrom(active[0], cleared) } : cleared)
  }
  const pickPoint = (id: string, list = points) => {
    const found = list.find(l => l.id === id)
    onChange({ supplier_location_id: id, ...(found ? originFrom(found, value) : {}) })
  }
  const pointValid = (p: Point) => p.name.trim() && p.address.trim() && p.district.trim()
  const pointRow = (p: Point) => ({ name: p.name.trim(), address: p.address.trim(), department: p.department.trim().toUpperCase() || null,
    province: p.province.trim().toUpperCase() || null, district: p.district.trim().toUpperCase(), contact_name: p.contact_name.trim() || null, contact_phone: p.contact_phone.trim() || null, is_active: true })

  const createSupplier = async () => {
    if (!isValidRuc(draft.tax_id.trim())) { toast.error('RUC inválido: 11 dígitos con dígito verificador correcto.'); return }
    if (!draft.business_name.trim()) { toast.error('Ingrese la razón social.'); return }
    const withPoint = Boolean(point.name.trim() || point.address.trim() || point.district.trim())
    if (withPoint && !pointValid(point)) { toast.error('Complete nombre, dirección y distrito del punto de recojo, o déjelo vacío.'); return }
    setSaving(true)
    const { data, error } = await supabase.rpc('save_supplier', {
      p_supplier: { tax_id: draft.tax_id.trim(), business_name: draft.business_name.trim(), category: draft.category, contact_name: draft.contact_name || null, contact_phone: draft.contact_phone || null, is_active: true },
      p_locations: withPoint ? [pointRow(point)] : [] })
    if (error) { setSaving(false); toast.error(error.message.includes('suppliers_tax_id_key') ? 'Ya existe un proveedor con ese RUC: búsquelo en la lista.' : 'No se pudo registrar: ' + error.message); return }
    const list = await reload(); setSaving(false)
    selectSupplier(data as string, list)
    setMode(''); setDraft({ tax_id: '', business_name: '', category: 'MATERIA_PRIMA', contact_name: '', contact_phone: '' }); setPoint(EMPTY_POINT)
    toast.success('Proveedor registrado y seleccionado')
  }

  const createPoint = async (p: Point) => {
    if (!supplier) return
    if (!pointValid(p)) { toast.error('Complete nombre, dirección y distrito del punto de recojo.'); return }
    setSaving(true)
    const { data, error } = await supabase.from('supplier_locations').insert({ supplier_id: supplier.id, ...pointRow(p) }).select('id').single()
    if (error) { setSaving(false); toast.error('No se pudo registrar el punto: ' + error.message); return }
    const list = await reload(); setSaving(false)
    const fresh = (list.find(s => s.id === supplier.id)?.supplier_locations || []).filter(l => l.is_active)
    pickPoint(data.id as string, fresh)
    setMode(''); setPoint(EMPTY_POINT)
    toast.success('Punto de recojo registrado')
  }

  const pointFields = <div className="grid gap-2 sm:grid-cols-6">
    <input className={`${input} sm:col-span-2`} placeholder="Nombre del punto *" value={point.name} onChange={e => setPoint({ ...point, name: e.target.value })} />
    <input className={`${input} sm:col-span-4`} placeholder="Dirección exacta *" value={point.address} onChange={e => setPoint({ ...point, address: e.target.value })} />
    <input className={`${input} sm:col-span-2`} placeholder="Departamento" value={point.department} onChange={e => setPoint({ ...point, department: e.target.value.toUpperCase() })} />
    <input className={`${input} sm:col-span-2`} placeholder="Provincia" value={point.province} onChange={e => setPoint({ ...point, province: e.target.value.toUpperCase() })} />
    <input className={`${input} sm:col-span-2`} placeholder="Distrito *" value={point.district} onChange={e => setPoint({ ...point, district: e.target.value.toUpperCase() })} />
    <input className={`${input} sm:col-span-3`} placeholder="Contacto (opcional)" value={point.contact_name} onChange={e => setPoint({ ...point, contact_name: e.target.value })} />
    <input className={`${input} sm:col-span-3`} type="tel" placeholder="Teléfono (opcional)" value={point.contact_phone} onChange={e => setPoint({ ...point, contact_phone: e.target.value })} />
  </div>
  const panelActions = (onSave: () => void, label: string) => <div className="mt-3 flex justify-end gap-2">
    <button type="button" onClick={() => { setMode(''); setPoint(EMPTY_POINT) }} className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100">Cancelar</button>
    <button type="button" disabled={saving} onClick={onSave} className="flex items-center gap-1.5 rounded-lg bg-[#002855] px-3 py-1.5 text-sm font-semibold text-white hover:bg-[#001d3d] disabled:opacity-50">
      {saving && <Loader2 className="h-4 w-4 animate-spin" />}{label}</button>
  </div>

  return <div className="space-y-3">
    <div className="grid gap-3 md:grid-cols-2">
      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-slate-700">Proveedor *</span>
          <button type="button" onClick={() => setMode(mode === 'supplier' ? '' : 'supplier')} className="flex items-center gap-1 text-xs font-semibold text-[#002855] hover:underline"><Plus className="h-3.5 w-3.5" />Nuevo proveedor</button>
        </div>
        <SearchableSelect placeholder="Buscar por razón social o RUC…" value={value.supplier_id}
          options={suppliers.map(s => ({ value: s.id, label: `${s.business_name} · ${s.tax_id}` }))} onChange={(id: string) => selectSupplier(id)} />
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-slate-700">Punto de recojo</span>
          {supplier && <button type="button" onClick={() => setMode(mode === 'point' ? '' : 'point')} className="flex items-center gap-1 text-xs font-semibold text-[#002855] hover:underline"><MapPinPlus className="h-3.5 w-3.5" />Nuevo punto</button>}
        </div>
        <select value={value.supplier_location_id} onChange={e => pickPoint(e.target.value)} disabled={!supplier} className={input}>
          <option value="">{!supplier ? 'Elija primero el proveedor' : points.length ? 'Seleccione (completa el origen)' : 'Sin puntos: registre uno o ingrese el origen'}</option>
          {points.map(l => <option key={l.id} value={l.id}>{l.name} · {l.district || l.address}</option>)}
        </select>
      </div>
    </div>

    {mode === 'supplier' && <div className="rounded-lg border border-[#002855]/20 bg-white p-3">
      <div className="mb-2 flex items-center justify-between"><p className="text-sm font-semibold text-slate-800">Registrar proveedor</p><button type="button" aria-label="Cerrar" onClick={() => setMode('')} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button></div>
      <div className="grid gap-2 sm:grid-cols-6">
        <input className={`${input} sm:col-span-2`} inputMode="numeric" maxLength={11} placeholder="RUC *" value={draft.tax_id} onChange={e => setDraft({ ...draft, tax_id: e.target.value.replace(/\D/g, '') })} />
        <input className={`${input} sm:col-span-4`} placeholder="Razón social *" value={draft.business_name} onChange={e => setDraft({ ...draft, business_name: e.target.value })} />
        <select className={`${input} sm:col-span-2`} value={draft.category} onChange={e => setDraft({ ...draft, category: e.target.value as SupplierCategory })}>
          {(Object.keys(SUPPLIER_CATEGORIES) as SupplierCategory[]).map(k => <option key={k} value={k}>{SUPPLIER_CATEGORIES[k]}</option>)}
        </select>
        <input className={`${input} sm:col-span-2`} placeholder="Contacto (opcional)" value={draft.contact_name} onChange={e => setDraft({ ...draft, contact_name: e.target.value })} />
        <input className={`${input} sm:col-span-2`} type="tel" placeholder="Teléfono (opcional)" value={draft.contact_phone} onChange={e => setDraft({ ...draft, contact_phone: e.target.value })} />
      </div>
      <p className="mb-2 mt-3 text-xs font-semibold text-slate-600">Punto de recojo (opcional, se puede agregar después)</p>
      {pointFields}
      {panelActions(createSupplier, 'Registrar y seleccionar')}
    </div>}

    {mode === 'point' && supplier && <div className="rounded-lg border border-[#002855]/20 bg-white p-3">
      <div className="mb-2 flex items-center justify-between"><p className="text-sm font-semibold text-slate-800">Nuevo punto de recojo · {supplier.business_name}</p><button type="button" aria-label="Cerrar" onClick={() => { setMode(''); setPoint(EMPTY_POINT) }} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button></div>
      {pointFields}
      {panelActions(() => void createPoint(point), 'Registrar y usar')}
    </div>}

    {!suppliers.length && mode !== 'supplier' && <p className="text-xs text-slate-500">No hay proveedores activos. Use «Nuevo proveedor» para registrarlo aquí.</p>}
    {canSaveOrigin && mode === '' && <button type="button" disabled={saving}
      onClick={() => void createPoint({ name: value.pickup_district || 'Punto de recojo', address: value.pickup_address, department: value.pickup_department, province: value.pickup_province, district: value.pickup_district, contact_name: value.pickup_contact, contact_phone: value.pickup_phone })}
      className="flex items-center gap-1.5 text-xs font-semibold text-[#002855] hover:underline disabled:opacity-50"><MapPinPlus className="h-3.5 w-3.5" />Guardar el origen ingresado como punto de recojo de {supplier?.business_name}</button>}
  </div>
}
