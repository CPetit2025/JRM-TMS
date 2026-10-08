'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Edit2, Factory, Loader2, MapPin, Plus, Search } from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable } from '@/components/ui/data-table'
import { FilterToolbar, FilterField, filterControl } from '@/components/ui/filter-toolbar'
import { StatusBadge } from '@/components/ui/status-badge'
import { Modal } from '@/components/ui/modal'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { errorMessage } from '@/lib/caja'
import { isValidRuc, SUPPLIER_CATEGORIES, type Supplier, type SupplierCategory, type SupplierLocation } from '@/lib/suppliers'

// Proveedores de materia prima, insumos, producción y proyectos (los transportistas y talleres tienen su propio
// maestro). Los recojos y traslados punto a punto de la solicitud se vinculan a un proveedor y su punto de recojo.

type SupplierForm = Omit<Supplier, 'id' | 'supplier_locations'> & { id?: string }
type LocationForm = Omit<SupplierLocation, 'id' | 'supplier_id'> & { id?: string }

const EMPTY_SUPPLIER: SupplierForm = { tax_id: '', business_name: '', category: 'MATERIA_PRIMA', contact_name: '', contact_phone: '', contact_email: '', notes: '', is_active: true }
const EMPTY_LOCATION: LocationForm = { name: '', address: '', department: '', province: '', district: '', contact_name: '', contact_phone: '', is_active: true }
const input = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-jrm-navy'
const MANAGE = ['proveedores', 'clientes', 'solicitudes', 'despacho']

export default function ProveedoresPage() {
  const supabase = useMemo(() => createClient(), [])
  const { canRead, canWrite, isLoaded } = usePermissions()
  const canManage = MANAGE.some(module => canWrite(module))
  const canView = canManage || [...MANAGE, 'torre-control', 'documentario'].some(module => canRead(module))
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [status, setStatus] = useState<'active' | 'inactive' | ''>('active')
  const [form, setForm] = useState<SupplierForm | null>(null)
  const [locations, setLocations] = useState<LocationForm[]>([])
  const [draft, setDraft] = useState<LocationForm>(EMPTY_LOCATION)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase.from('suppliers')
      .select('id, tax_id, business_name, category, contact_name, contact_phone, contact_email, notes, is_active, supplier_locations(id, supplier_id, name, address, department, province, district, contact_name, contact_phone, is_active)')
      .order('business_name')
    if (error) toast.error('No se pudo cargar proveedores: ' + errorMessage(error))
    else setSuppliers((data || []) as Supplier[])
    setLoading(false)
  }, [supabase])
  useEffect(() => { if (isLoaded && canView) void Promise.resolve().then(load) }, [isLoaded, canView, load])

  const visible = useMemo(() => {
    const q = search.trim().toLocaleLowerCase('es-PE')
    return suppliers.filter(s => (!q || [s.business_name, s.tax_id, s.contact_name, ...(s.supplier_locations || []).map(l => `${l.name} ${l.district}`)].join(' ').toLocaleLowerCase('es-PE').includes(q))
      && (!category || s.category === category) && (!status || (status === 'active') === s.is_active))
  }, [suppliers, search, category, status])

  const open = (supplier?: Supplier) => {
    setForm(supplier ? { ...supplier } : { ...EMPTY_SUPPLIER })
    setLocations((supplier?.supplier_locations || []).map(l => ({ ...l })))
    setDraft(EMPTY_LOCATION)
  }
  const addLocation = () => {
    if (!draft.name.trim() || !draft.address.trim() || !draft.district?.trim()) { toast.error('Complete nombre, dirección y distrito del punto de recojo.'); return }
    setLocations(prev => [...prev, { ...draft, district: draft.district?.toUpperCase() || null }]); setDraft(EMPTY_LOCATION)
  }

  const save = async () => {
    if (!form) return
    const taxId = form.tax_id.trim()
    if (!isValidRuc(taxId)) { toast.error('RUC inválido: 11 dígitos con dígito verificador correcto.'); return }
    if (!form.business_name.trim()) { toast.error('Ingrese la razón social.'); return }
    setSaving(true)
    try {
      const payload = { tax_id: taxId, business_name: form.business_name.trim(), category: form.category, contact_name: form.contact_name || null,
        contact_phone: form.contact_phone || null, contact_email: form.contact_email || null, notes: form.notes || null, is_active: form.is_active }
      const { data, error } = form.id
        ? await supabase.from('suppliers').update(payload).eq('id', form.id).select('id').single()
        : await supabase.from('suppliers').insert(payload).select('id').single()
      if (error) throw error
      const supplierId = data.id as string
      for (const l of locations) {
        const row = { supplier_id: supplierId, name: l.name.trim(), address: l.address.trim(), department: l.department || null, province: l.province || null,
          district: l.district || null, contact_name: l.contact_name || null, contact_phone: l.contact_phone || null, is_active: l.is_active }
        const { error: locError } = l.id ? await supabase.from('supplier_locations').update(row).eq('id', l.id) : await supabase.from('supplier_locations').insert(row)
        if (locError) throw locError
      }
      toast.success(form.id ? 'Proveedor actualizado' : 'Proveedor registrado')
      setForm(null); await load()
    } catch (e) {
      const message = errorMessage(e)
      toast.error(message.includes('suppliers_tax_id_key') ? 'Ya existe un proveedor con ese RUC.' : 'No se pudo guardar: ' + message)
    } finally { setSaving(false) }
  }

  if (isLoaded && !canView) return <p className="rounded-jrm border border-jrm-line bg-jrm-surface p-6 text-sm text-slate-600">No tiene acceso al maestro de proveedores.</p>

  return <div className="space-y-3">
    <PageHeader showTitle title="Proveedores" description="Materia prima, insumos, producción y proyectos · puntos de recojo"
      actions={canManage ? <button type="button" onClick={() => open()} className="flex min-h-10 items-center gap-2 rounded-lg bg-jrm-navy px-4 text-sm font-semibold text-white hover:bg-jrm-navy-dark"><Plus className="h-4 w-4" />Nuevo proveedor</button> : undefined} />
    <FilterToolbar compact label="Búsqueda y filtros de proveedores" onClear={() => { setSearch(''); setCategory(''); setStatus('active') }}>
      <label className="relative min-w-0 flex-1 basis-60"><span className="sr-only">Buscar proveedores</span><Search className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" aria-hidden />
        <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por razón social, RUC, contacto o distrito…" className={`${filterControl} pl-9`} /></label>
      <FilterField inline label="Categoría" className="w-56"><select className={filterControl} value={category} onChange={e => setCategory(e.target.value)}>
        <option value="">Todas</option>{(Object.keys(SUPPLIER_CATEGORIES) as SupplierCategory[]).map(k => <option key={k} value={k}>{SUPPLIER_CATEGORIES[k]}</option>)}</select></FilterField>
      <FilterField inline label="Estado" className="w-48"><select className={filterControl} value={status} onChange={e => setStatus(e.target.value as typeof status)}>
        <option value="active">Activos</option><option value="inactive">Inactivos</option><option value="">Todos</option></select></FilterField>
    </FilterToolbar>
    <div className="overflow-x-auto rounded-jrm border border-jrm-line bg-jrm-surface shadow-jrm-card">
      <DataTable dense className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500"><tr>{['Razón social', 'RUC', 'Categoría', 'Contacto', 'Puntos de recojo', 'Estado', 'Acciones'].map((t, i) => <th key={t} className={`whitespace-nowrap font-semibold ${i === 6 ? 'text-right' : ''}`}>{t}</th>)}</tr></thead>
        <tbody className="divide-y divide-slate-100">
          {loading ? <tr><td colSpan={7} className="p-8 text-center text-slate-500"><Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />Cargando proveedores…</td></tr>
            : !visible.length ? <tr><td colSpan={7} className="p-8 text-center text-slate-500">{suppliers.length ? 'No hay proveedores con estos filtros.' : 'Aún no hay proveedores registrados.'}</td></tr>
            : visible.map(s => { const points = (s.supplier_locations || []).filter(l => l.is_active); return <tr key={s.id} className="hover:bg-slate-50">
              <td className="max-w-64"><p className="truncate font-semibold text-slate-800" title={s.business_name}>{s.business_name}</p></td>
              <td className="whitespace-nowrap tabular-nums text-slate-700">{s.tax_id}</td>
              <td className="whitespace-nowrap text-slate-700">{SUPPLIER_CATEGORIES[s.category]}</td>
              <td className="max-w-48"><p className="truncate text-slate-700" title={[s.contact_name, s.contact_phone, s.contact_email].filter(Boolean).join(' · ') || undefined}>{s.contact_name || '—'}</p></td>
              <td className="max-w-56"><p className="truncate text-slate-700" title={points.map(l => `${l.name}: ${l.address}`).join('\n') || undefined}>{points.length ? `${points.length} · ${points.map(l => l.district || l.name).join(', ')}` : 'Sin puntos'}</p></td>
              <td><StatusBadge tone={s.is_active ? 'success' : 'neutral'}>{s.is_active ? 'Activo' : 'Inactivo'}</StatusBadge></td>
              <td className="text-right"><button type="button" onClick={() => open(s)} title={canManage ? 'Editar' : 'Ver'} aria-label={`${canManage ? 'Editar' : 'Ver'} ${s.business_name}`} className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-slate-300 px-2.5 text-xs font-semibold text-jrm-navy hover:bg-slate-50"><Edit2 className="h-3.5 w-3.5" />{canManage ? 'Editar' : 'Ver'}</button></td>
            </tr> })}
        </tbody>
      </DataTable>
    </div>

    <Modal isOpen={!!form} onClose={() => setForm(null)} title={form?.id ? `Proveedor · ${form.business_name}` : 'Nuevo proveedor'} maxWidth="max-w-3xl"
      footer={<div className="flex justify-end gap-2"><button type="button" onClick={() => setForm(null)} className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700">Cerrar</button>
        {canManage && <button type="button" onClick={() => void save()} disabled={saving} className="flex min-h-11 items-center gap-2 rounded-lg bg-jrm-navy px-4 text-sm font-semibold text-white disabled:opacity-50">{saving && <Loader2 className="h-4 w-4 animate-spin" />}Guardar</button>}</div>}>
      {form && <fieldset disabled={!canManage} className="space-y-4 text-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block"><span className="mb-1 block text-xs font-semibold text-slate-600">RUC *</span><input className={input} inputMode="numeric" maxLength={11} value={form.tax_id} onChange={e => setForm({ ...form, tax_id: e.target.value.replace(/\D/g, '') })} /></label>
          <label className="block"><span className="mb-1 block text-xs font-semibold text-slate-600">Categoría *</span><select className={input} value={form.category} onChange={e => setForm({ ...form, category: e.target.value as SupplierCategory })}>{(Object.keys(SUPPLIER_CATEGORIES) as SupplierCategory[]).map(k => <option key={k} value={k}>{SUPPLIER_CATEGORIES[k]}</option>)}</select></label>
          <label className="block sm:col-span-2"><span className="mb-1 block text-xs font-semibold text-slate-600">Razón social *</span><input className={input} value={form.business_name} onChange={e => setForm({ ...form, business_name: e.target.value })} /></label>
          <label className="block"><span className="mb-1 block text-xs font-semibold text-slate-600">Contacto</span><input className={input} value={form.contact_name || ''} onChange={e => setForm({ ...form, contact_name: e.target.value })} /></label>
          <label className="block"><span className="mb-1 block text-xs font-semibold text-slate-600">Teléfono</span><input className={input} value={form.contact_phone || ''} onChange={e => setForm({ ...form, contact_phone: e.target.value })} /></label>
          <label className="block"><span className="mb-1 block text-xs font-semibold text-slate-600">Correo</span><input type="email" className={input} value={form.contact_email || ''} onChange={e => setForm({ ...form, contact_email: e.target.value })} /></label>
          <label className="flex items-center gap-2 self-end pb-2"><input type="checkbox" checked={form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} className="h-4 w-4" /><span className="font-medium text-slate-700">Proveedor activo</span></label>
          <label className="block sm:col-span-2"><span className="mb-1 block text-xs font-semibold text-slate-600">Notas</span><textarea rows={2} className={input} value={form.notes || ''} onChange={e => setForm({ ...form, notes: e.target.value })} /></label>
        </div>
        <section className="rounded-lg border border-slate-200 p-3">
          <h3 className="mb-2 flex items-center gap-2 font-semibold text-slate-800"><MapPin className="h-4 w-4 text-blue-600" />Puntos de recojo</h3>
          {locations.length ? <ul className="mb-3 divide-y divide-slate-100 rounded-lg border border-slate-100">{locations.map((l, i) => <li key={l.id || `new-${i}`} className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="min-w-0"><b className="text-slate-800">{l.name}</b><span className="block truncate text-xs text-slate-500" title={l.address}>{l.address} · {l.district}{l.contact_name ? ` · ${l.contact_name}` : ''}{l.contact_phone ? ` ${l.contact_phone}` : ''}</span></span>
            <label className="flex shrink-0 items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={l.is_active} onChange={e => setLocations(prev => prev.map((x, j) => j === i ? { ...x, is_active: e.target.checked } : x))} />Activo</label>
          </li>)}</ul> : <p className="mb-3 text-xs text-slate-500">Sin puntos de recojo. Agregue la planta o almacén donde se recoge la carga.</p>}
          {canManage && <div className="grid gap-2 sm:grid-cols-3">
            <input className={input} placeholder="Nombre (ej. Planta Ate)" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
            <input className={`${input} sm:col-span-2`} placeholder="Dirección exacta" value={draft.address} onChange={e => setDraft({ ...draft, address: e.target.value })} />
            <input className={input} placeholder="Distrito *" value={draft.district || ''} onChange={e => setDraft({ ...draft, district: e.target.value.toUpperCase() })} />
            <input className={input} placeholder="Provincia" value={draft.province || ''} onChange={e => setDraft({ ...draft, province: e.target.value.toUpperCase() })} />
            <input className={input} placeholder="Departamento" value={draft.department || ''} onChange={e => setDraft({ ...draft, department: e.target.value.toUpperCase() })} />
            <input className={input} placeholder="Contacto en el punto" value={draft.contact_name || ''} onChange={e => setDraft({ ...draft, contact_name: e.target.value })} />
            <input className={input} placeholder="Teléfono" value={draft.contact_phone || ''} onChange={e => setDraft({ ...draft, contact_phone: e.target.value })} />
            <button type="button" onClick={addLocation} className="flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-jrm-navy px-3 text-sm font-semibold text-jrm-navy hover:bg-blue-50"><Factory className="h-4 w-4" />Agregar punto</button>
          </div>}
        </section>
      </fieldset>}
    </Modal>
  </div>
}
