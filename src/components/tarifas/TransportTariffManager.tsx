'use client'
import { DataTable } from '@/components/ui/data-table'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Calculator, Download, History, Loader2, Pencil, Plus, Power, Search, Upload } from 'lucide-react'
import { toast } from 'sonner'
import * as XLSX from 'xlsx'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { Modal } from '@/components/ui/modal'

// Tarifario de Transporte (freight_rates): flete por destino y tipo de unidad, paradas adicionales y descarga.
// Alcance general / cliente / contrato, vigencias y precio al cliente. Las tarifas no se borran: se desactivan o se
// reemplazan por una nueva versión (la anterior queda con fecha de fin), porque solicitudes y despachos guardan qué
// tarifa usaron. El cálculo lo hace quote_transport en la base de datos.

type Rate = {
  id: string; concept: string; origin: string | null; district: string | null; department: string | null; province: string | null
  zone: string | null; vehicle_type: string | null; vehicle_class: string | null; capacity_ton: number | null; plate_number: string | null
  scope: string; client_id: string | null; contract_id: string | null; rate_basis: string; rate: number; client_price: number | null
  valid_from: string; valid_to: string | null; is_active: boolean; notes: string | null
}
type Named = { id: string; name: string }

const CONCEPTS: Record<string, string> = {
  FLETE: 'Flete', PARADA_ADICIONAL: 'Parada adicional', MONTACARGAS: 'Montacargas', GRUA: 'Grúa', ESTIBA: 'Estiba',
  OTROS: 'Otros (descarga)', ESPERA_HORA: 'Espera por hora',
}
const BASIS: Record<string, string> = { VIAJE: 'por viaje', TONELADA: 'por tonelada', UNIDAD: 'por servicio', HORA: 'por hora' }
const money = (n: number | null | undefined) => (n == null ? '—' : `S/ ${Number(n).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' })
const isCurrent = (r: Rate) => r.is_active && r.valid_from <= today() && (!r.valid_to || r.valid_to >= today())

// Costo JRM por defecto: 20 % menos que el precio al cliente (con IGV)
const COST_RATIO = 0.8
const costFromPrice = (price: string | number) => {
  const n = Number(price)
  return price === '' || !Number.isFinite(n) || n < 0 ? '' : (Math.round(n * COST_RATIO * 100) / 100).toString()
}

const EMPTY = {
  id: '', concept: 'FLETE', origin: 'Planta Chilca', district: '', department: '', province: '', zone: '', vehicle_type: '',
  vehicle_class: '', capacity_ton: '', plate_number: '', scope: 'GENERAL', client_id: '', contract_id: '', rate_basis: 'VIAJE',
  rate: '', client_price: '', valid_from: '', valid_to: '', notes: '',
}

export function TransportTariffManager() {
  const supabase = useMemo(() => createClient(), [])
  const { canWrite } = usePermissions()
  const editable = canWrite('tarifas')
  const [rates, setRates] = useState<Rate[] | null>(null)
  const [clients, setClients] = useState<Named[]>([])
  const [contracts, setContracts] = useState<Named[]>([])
  const [reload, setReload] = useState(0)
  const [q, setQ] = useState('')
  const [concept, setConcept] = useState('TODOS')
  const [vclass, setVclass] = useState('TODAS')
  const [scope, setScope] = useState('TODOS')
  const [showHistory, setShowHistory] = useState(false)
  const [form, setForm] = useState<typeof EMPTY | null>(null)
  const [versionOf, setVersionOf] = useState<Rate | null>(null)
  const [saving, setSaving] = useState(false)
  const [sim, setSim] = useState({ contract_id: '', districts: '', weight: '', plate: '' })
  const [simResult, setSimResult] = useState<Record<string, unknown> | null>(null)

  useEffect(() => {
    let cancel = false
    const run = async () => {
      const [r, c, k] = await Promise.all([
        supabase.from('freight_rates').select('*').order('concept').order('district'),
        supabase.from('clients').select('id, business_name').order('business_name'),
        supabase.from('contracts').select('id, code, parent_contract_id').is('parent_contract_id', null).order('code'),
      ])
      if (cancel) return
      if (r.error) toast.error('No se pudo cargar el tarifario: ' + r.error.message)
      setRates((r.data || []) as Rate[])
      setClients((c.data || []).map(x => ({ id: x.id, name: x.business_name })))
      setContracts((k.data || []).map(x => ({ id: x.id, name: x.code })))
    }
    void run()
    return () => { cancel = true }
  }, [supabase, reload])

  const clientName = useCallback((id: string | null) => clients.find(c => c.id === id)?.name || '—', [clients])
  const contractName = useCallback((id: string | null) => contracts.find(c => c.id === id)?.name || '—', [contracts])
  const classes = useMemo(() => [...new Set((rates || []).map(r => r.vehicle_class).filter(Boolean) as string[])].sort(), [rates])

  const visible = useMemo(() => (rates || []).filter(r => {
    if (!showHistory && !isCurrent(r)) return false
    if (concept !== 'TODOS' && r.concept !== concept) return false
    if (vclass !== 'TODAS' && r.vehicle_class !== vclass) return false
    if (scope !== 'TODOS' && r.scope !== scope) return false
    const text = [r.district, r.zone, r.department, r.province, r.plate_number, r.vehicle_class, clientName(r.client_id), contractName(r.contract_id)].join(' ').toLowerCase()
    return !q || text.includes(q.toLowerCase())
  }), [rates, showHistory, concept, vclass, scope, q, clientName, contractName])

  const openNew = () => { setVersionOf(null); setForm({ ...EMPTY, valid_from: today() }) }
  const toForm = (r: Rate) => ({
    id: r.id, concept: r.concept, origin: r.origin || '', district: r.district || '', department: r.department || '', province: r.province || '',
    zone: r.zone || '', vehicle_type: r.vehicle_type || '', vehicle_class: r.vehicle_class || '', capacity_ton: r.capacity_ton?.toString() || '',
    plate_number: r.plate_number || '', scope: r.scope, client_id: r.client_id || '', contract_id: r.contract_id || '', rate_basis: r.rate_basis,
    rate: String(r.rate), client_price: r.client_price?.toString() || '', valid_from: r.valid_from, valid_to: r.valid_to || '', notes: r.notes || '',
  })
  const openEdit = (r: Rate) => { setVersionOf(null); setForm(toForm(r)) }
  // Nueva versión: la tarifa actual termina ayer y la nueva rige desde hoy
  const openVersion = (r: Rate) => { setVersionOf(r); setForm({ ...toForm(r), id: '', valid_from: today(), valid_to: '' }) }

  const save = async () => {
    if (!form) return
    if (form.concept === 'FLETE' && !form.district.trim()) { toast.error('El flete necesita el distrito de destino'); return }
    if (form.client_price === '' || !(Number(form.client_price) >= 0)) { toast.error('Indique el precio al cliente (con IGV)'); return }
    if (!(Number(form.rate) >= 0) || form.rate === '') { toast.error('Indique el costo JRM'); return }
    if (form.scope === 'CLIENTE' && !form.client_id) { toast.error('Seleccione el cliente'); return }
    if (form.scope === 'CONTRATO' && !form.contract_id) { toast.error('Seleccione el contrato'); return }
    const payload = {
      concept: form.concept, origin: form.origin || 'Planta Chilca', district: form.district.trim() || null,
      department: form.department.trim() || null, province: form.province.trim() || null, zone: form.zone.trim() || null,
      vehicle_type: form.vehicle_type.trim() || (form.vehicle_class.trim().split(' ')[0] || null),
      vehicle_class: form.vehicle_class.trim() || null, capacity_ton: form.capacity_ton === '' ? null : Number(form.capacity_ton),
      plate_number: form.plate_number.trim().toUpperCase() || null, scope: form.scope,
      client_id: form.scope === 'CLIENTE' ? form.client_id : null, contract_id: form.scope === 'CONTRATO' ? form.contract_id : null,
      rate_basis: form.rate_basis, rate: Number(form.rate), client_price: form.client_price === '' ? null : Number(form.client_price),
      valid_from: form.valid_from || today(), valid_to: form.valid_to || null, notes: form.notes.trim() || null,
    }
    setSaving(true)
    try {
      if (versionOf) {
        const yesterday = new Date(Date.now() - 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Lima' })
        const { error: e1 } = await supabase.from('freight_rates').update({ valid_to: yesterday < versionOf.valid_from ? versionOf.valid_from : yesterday }).eq('id', versionOf.id)
        if (e1) throw e1
      }
      const { error } = form.id
        ? await supabase.from('freight_rates').update(payload).eq('id', form.id)
        : await supabase.from('freight_rates').insert([payload])
      if (error) throw error
      toast.success(versionOf ? 'Nueva versión registrada; la anterior quedó en el historial' : 'Tarifa guardada')
      setForm(null); setVersionOf(null); setReload(n => n + 1)
    } catch (e) { toast.error('No se pudo guardar: ' + (e as { message?: string }).message) } finally { setSaving(false) }
  }

  const toggleActive = async (r: Rate) => {
    const { error } = await supabase.from('freight_rates').update({ is_active: !r.is_active }).eq('id', r.id)
    if (error) toast.error(error.message); else { toast.success(r.is_active ? 'Tarifa desactivada' : 'Tarifa activada'); setReload(n => n + 1) }
  }

  const exportXlsx = () => {
    const rows = visible.map(r => ({
      concepto: r.concept, distrito: r.district || '', provincia: r.province || '', departamento: r.department || '', zona: r.zone || '',
      tipo_unidad: r.vehicle_class || '', capacidad_t: r.capacity_ton ?? '', placa: r.plate_number || '', alcance: r.scope,
      cliente: r.client_id ? clientName(r.client_id) : '', contrato: r.contract_id ? contractName(r.contract_id) : '',
      base: r.rate_basis, costo: r.rate, precio_cliente: r.client_price ?? '', vigente_desde: r.valid_from, vigente_hasta: r.valid_to || '',
    }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ concepto: 'FLETE', distrito: 'Ate', provincia: 'Lima', departamento: 'Lima', zona: 'ZONA ESTE', tipo_unidad: 'Trailer 32 t', capacidad_t: 32, placa: '', alcance: 'GENERAL', cliente: '', contrato: '', base: 'VIAJE', costo: 1430, precio_cliente: '', vigente_desde: today(), vigente_hasta: '' }]), 'Tarifario')
    XLSX.writeFile(wb, `tarifario-transporte-${today()}.xlsx`)
  }

  const importXlsx = async (file: File) => {
    const wb = XLSX.read(await file.arrayBuffer())
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]])
    const byName = (list: Named[], name: unknown) => list.find(x => x.name.toLowerCase() === String(name || '').trim().toLowerCase())?.id
    const errors: string[] = []
    const payload = rows.map((row, i) => {
      const scopeV = String(row.alcance || 'GENERAL').toUpperCase()
      const client_id = scopeV === 'CLIENTE' ? byName(clients, row.cliente) : undefined
      const contract_id = scopeV === 'CONTRATO' ? byName(contracts, row.contrato) : undefined
      if (scopeV === 'CLIENTE' && !client_id) errors.push(`Fila ${i + 2}: cliente no encontrado`)
      if (scopeV === 'CONTRATO' && !contract_id) errors.push(`Fila ${i + 2}: contrato no encontrado`)
      const conceptV = String(row.concepto || 'FLETE').toUpperCase()
      if (!CONCEPTS[conceptV]) errors.push(`Fila ${i + 2}: concepto inválido`)
      if (conceptV === 'FLETE' && !String(row.distrito || '').trim()) errors.push(`Fila ${i + 2}: falta distrito`)
      // precio_cliente es el precio con IGV; si falta el costo JRM se toma el 80 %
      const priceV = row.precio_cliente === '' || row.precio_cliente == null ? null : Number(row.precio_cliente)
      const costV = row.costo === '' || row.costo == null ? (priceV != null ? Number(costFromPrice(priceV)) : NaN) : Number(row.costo)
      if (!(costV >= 0)) errors.push(`Fila ${i + 2}: indique precio_cliente o costo`)
      const cls = String(row.tipo_unidad || '').trim()
      return {
        concept: conceptV, origin: 'Planta Chilca', district: String(row.distrito || '').trim() || null,
        province: String(row.provincia || '').trim() || null, department: String(row.departamento || '').trim() || null,
        zone: String(row.zona || '').trim() || null, vehicle_class: cls || null, vehicle_type: cls.split(' ')[0] || null,
        capacity_ton: row.capacidad_t === '' || row.capacidad_t == null ? null : Number(row.capacidad_t),
        plate_number: String(row.placa || '').trim().toUpperCase() || null, scope: scopeV,
        client_id: client_id || null, contract_id: contract_id || null, rate_basis: String(row.base || (conceptV === 'FLETE' ? 'VIAJE' : 'UNIDAD')).toUpperCase(),
        rate: costV, client_price: priceV,
        valid_from: String(row.vigente_desde || today()).slice(0, 10), valid_to: row.vigente_hasta ? String(row.vigente_hasta).slice(0, 10) : null,
      }
    })
    if (errors.length) { toast.error(errors.slice(0, 5).join(' · ')); return }
    const { error } = await supabase.from('freight_rates').insert(payload)
    if (error) toast.error('Importación cancelada: ' + error.message)
    else { toast.success(`${payload.length} tarifas importadas`); setReload(n => n + 1) }
  }

  const simulate = async () => {
    if (!sim.contract_id || !sim.districts.trim()) { toast.error('Elija contrato y al menos un distrito'); return }
    const { data, error } = await supabase.rpc('quote_transport', {
      p_contract_id: sim.contract_id,
      p_stops: sim.districts.split(',').map(d => ({ district: d.trim() })).filter(d => d.district),
      p_weight_kg: sim.weight ? Number(sim.weight) : null, p_vehicle_class: null, p_plate: sim.plate || null, p_unloading: [],
    })
    if (error) toast.error(error.message); else setSimResult(data as Record<string, unknown>)
  }

  const set = (patch: Partial<typeof EMPTY>) => setForm(f => (f ? { ...f, ...patch } : f))
  const scopeLabel = (r: Rate) => r.scope === 'CLIENTE' ? `Cliente: ${clientName(r.client_id)}` : r.scope === 'CONTRATO' ? `Contrato ${contractName(r.contract_id)}` : 'General'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold text-[#002855]">Tarifario de Transporte</h2>
          <p className="text-xs text-slate-500">Flete por destino y tipo de unidad, paradas adicionales y descarga. Prioridad: contrato → cliente → general; la placa es una excepción.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={exportXlsx} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"><Download className="h-4 w-4" />Exportar / plantilla</button>
          {editable && <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
            <Upload className="h-4 w-4" />Importar Excel
            <input type="file" accept=".xlsx,.xls" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void importXlsx(f); e.target.value = '' }} />
          </label>}
          {editable && <button onClick={openNew} className="inline-flex items-center gap-1.5 rounded-lg bg-[#002855] px-3 py-1.5 text-sm font-semibold text-white hover:bg-[#001f44]"><Plus className="h-4 w-4" />Nueva tarifa</button>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Distrito, zona, placa, cliente, contrato…" className="w-full rounded-lg border border-slate-200 py-1.5 pl-8 pr-3 text-sm" />
        </div>
        <select value={concept} onChange={e => setConcept(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm">
          <option value="TODOS">Todos los conceptos</option>{Object.entries(CONCEPTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={vclass} onChange={e => setVclass(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm">
          <option value="TODAS">Todas las unidades</option>{classes.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={scope} onChange={e => setScope(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm">
          <option value="TODOS">Todo alcance</option><option value="GENERAL">General</option><option value="CLIENTE">Por cliente</option><option value="CONTRATO">Por contrato</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm text-slate-600"><input type="checkbox" checked={showHistory} onChange={e => setShowHistory(e.target.checked)} /><History className="h-3.5 w-3.5" />Ver historial e inactivas</label>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <DataTable className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2.5">Concepto</th><th className="px-3 py-2.5">Destino</th><th className="px-3 py-2.5">Unidad</th>
              <th className="px-3 py-2.5">Alcance</th><th className="px-3 py-2.5 text-right">Costo JRM</th><th className="px-3 py-2.5 text-right">Precio cliente (con IGV)</th>
              <th className="px-3 py-2.5">Vigencia</th><th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rates === null ? <tr><td colSpan={8} className="p-6 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-400" /></td></tr>
              : visible.length === 0 ? <tr><td colSpan={8} className="p-6 text-center text-slate-400">Sin tarifas con estos filtros.</td></tr>
              : visible.map(r => {
                const margin = r.client_price != null && r.client_price > 0 ? ((r.client_price - r.rate) / r.client_price) * 100 : null
                return (
                  <tr key={r.id} className={isCurrent(r) ? '' : 'bg-slate-50 text-slate-400'}>
                    <td className="px-3 py-2"><div className="font-medium text-slate-800">{CONCEPTS[r.concept] || r.concept}</div><div className="text-[11px] text-slate-400">{BASIS[r.rate_basis] || r.rate_basis}</div></td>
                    <td className="px-3 py-2">{r.district || <span className="text-slate-400">Cualquier destino</span>}{r.zone && <div className="text-[11px] text-slate-400">{r.zone}</div>}</td>
                    <td className="px-3 py-2">{r.vehicle_class || <span className="text-slate-400">Cualquiera</span>}{r.plate_number && <div className="text-[11px] font-semibold text-amber-700">Placa {r.plate_number} (excepción)</div>}</td>
                    <td className="px-3 py-2 text-xs">{scopeLabel(r)}</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-800">{money(r.rate)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(r.client_price)}{margin != null && <div className={`text-[11px] ${margin < 0 ? 'text-red-600' : 'text-emerald-700'}`}>margen {margin.toFixed(0)}%</div>}</td>
                    <td className="px-3 py-2 text-xs">{r.valid_from}{r.valid_to ? ` → ${r.valid_to}` : ' → vigente'}{!r.is_active && <div className="font-semibold text-red-500">Inactiva</div>}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {editable && <>
                        <button onClick={() => openVersion(r)} className="rounded p-1 text-slate-500 hover:bg-blue-50 hover:text-[#002855]" title="Nueva versión (cambio de precio desde hoy)"><History className="h-4 w-4" /></button>
                        <button onClick={() => openEdit(r)} className="rounded p-1 text-slate-500 hover:bg-blue-50 hover:text-[#002855]" title="Corregir"><Pencil className="h-4 w-4" /></button>
                        <button onClick={() => toggleActive(r)} className={`rounded p-1 hover:bg-slate-100 ${r.is_active ? 'text-slate-500' : 'text-emerald-600'}`} title={r.is_active ? 'Desactivar' : 'Activar'}><Power className="h-4 w-4" /></button>
                      </>}
                    </td>
                  </tr>
                )
              })}
          </tbody>
        </DataTable>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-800"><Calculator className="h-4 w-4" />Simulador de cotización</h3>
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <select value={sim.contract_id} onChange={e => setSim({ ...sim, contract_id: e.target.value })} className="rounded-lg border border-slate-200 px-2 py-1.5">
            <option value="">Contrato…</option>{contracts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input value={sim.districts} onChange={e => setSim({ ...sim, districts: e.target.value })} placeholder="Distritos separados por coma" className="min-w-[220px] flex-1 rounded-lg border border-slate-200 px-2 py-1.5" />
          <input value={sim.weight} onChange={e => setSim({ ...sim, weight: e.target.value })} placeholder="Peso kg" inputMode="numeric" className="w-24 rounded-lg border border-slate-200 px-2 py-1.5" />
          <input value={sim.plate} onChange={e => setSim({ ...sim, plate: e.target.value })} placeholder="Placa (opcional)" className="w-32 rounded-lg border border-slate-200 px-2 py-1.5" />
          <button onClick={simulate} className="rounded-lg bg-slate-800 px-3 py-1.5 font-semibold text-white">Calcular</button>
        </div>
        {simResult && <QuoteBreakdown quote={simResult} />}
      </div>

      <Modal isOpen={!!form} onClose={() => { setForm(null); setVersionOf(null) }} title={versionOf ? 'Nueva versión de tarifa' : form?.id ? 'Corregir tarifa' : 'Nueva tarifa'} maxWidth="max-w-2xl">
        {form && (
          <div className="space-y-3 text-sm">
            {versionOf && <p className="rounded bg-blue-50 p-2 text-xs text-blue-800">La tarifa actual termina ayer y esta rige desde la fecha indicada. Las solicitudes y despachos anteriores conservan el precio con que se calcularon.</p>}
            <div className="grid grid-cols-2 gap-3">
              <label className="block">Concepto<select value={form.concept} onChange={e => set({ concept: e.target.value, rate_basis: e.target.value === 'FLETE' ? 'VIAJE' : 'UNIDAD' })} className="mt-1 w-full rounded-lg border px-2 py-1.5">{Object.entries(CONCEPTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <label className="block">Base de cobro<select value={form.rate_basis} onChange={e => set({ rate_basis: e.target.value })} className="mt-1 w-full rounded-lg border px-2 py-1.5">{Object.entries(BASIS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <label className="block">Distrito destino {form.concept === 'FLETE' ? '*' : '(vacío = cualquiera)'}<input value={form.district} onChange={e => set({ district: e.target.value })} className="mt-1 w-full rounded-lg border px-2 py-1.5" /></label>
              <label className="block">Zona<input value={form.zone} onChange={e => set({ zone: e.target.value })} className="mt-1 w-full rounded-lg border px-2 py-1.5" /></label>
              <label className="block">Provincia<input value={form.province} onChange={e => set({ province: e.target.value })} className="mt-1 w-full rounded-lg border px-2 py-1.5" /></label>
              <label className="block">Departamento<input value={form.department} onChange={e => set({ department: e.target.value })} className="mt-1 w-full rounded-lg border px-2 py-1.5" /></label>
              <label className="block">Tipo de unidad (vacío = cualquiera)<input list="tariff-classes" value={form.vehicle_class} onChange={e => set({ vehicle_class: e.target.value })} placeholder="Trailer 32 t" className="mt-1 w-full rounded-lg border px-2 py-1.5" /><datalist id="tariff-classes">{classes.map(c => <option key={c} value={c} />)}</datalist></label>
              <label className="block">Capacidad (t)<input value={form.capacity_ton} onChange={e => set({ capacity_ton: e.target.value })} inputMode="decimal" className="mt-1 w-full rounded-lg border px-2 py-1.5" /></label>
              <label className="block">Placa (solo excepción)<input value={form.plate_number} onChange={e => set({ plate_number: e.target.value })} className="mt-1 w-full rounded-lg border px-2 py-1.5" /></label>
              <label className="block">Alcance<select value={form.scope} onChange={e => set({ scope: e.target.value })} className="mt-1 w-full rounded-lg border px-2 py-1.5"><option value="GENERAL">General</option><option value="CLIENTE">Cliente</option><option value="CONTRATO">Contrato</option></select></label>
              {form.scope === 'CLIENTE' && <label className="col-span-2 block">Cliente<select value={form.client_id} onChange={e => set({ client_id: e.target.value })} className="mt-1 w-full rounded-lg border px-2 py-1.5"><option value="">Seleccione…</option>{clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
              {form.scope === 'CONTRATO' && <label className="col-span-2 block">Contrato / OT<select value={form.contract_id} onChange={e => set({ contract_id: e.target.value })} className="mt-1 w-full rounded-lg border px-2 py-1.5"><option value="">Seleccione…</option>{contracts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
              <label className="block">Precio al cliente S/ (con IGV) *<input value={form.client_price} inputMode="decimal" className="mt-1 w-full rounded-lg border px-2 py-1.5"
                onChange={e => {
                  const price = e.target.value
                  // El costo JRM sigue al precio (80 %) mientras no se haya ajustado a mano
                  const autoPrev = costFromPrice(form.client_price)
                  set({ client_price: price, ...(form.rate === '' || form.rate === autoPrev ? { rate: costFromPrice(price) } : {}) })
                }} /></label>
              <label className="block">Costo JRM S/ *<input value={form.rate} onChange={e => set({ rate: e.target.value })} inputMode="decimal" className="mt-1 w-full rounded-lg border px-2 py-1.5" />
                <span className="text-[11px] font-normal text-slate-500">Por defecto el 80 % del precio al cliente{form.client_price !== '' && costFromPrice(form.client_price) ? ` (S/ ${costFromPrice(form.client_price)})` : ''}</span></label>
              <label className="block">Vigente desde<input type="date" value={form.valid_from} onChange={e => set({ valid_from: e.target.value })} className="mt-1 w-full rounded-lg border px-2 py-1.5" /></label>
              <label className="block">Vigente hasta<input type="date" value={form.valid_to} onChange={e => set({ valid_to: e.target.value })} className="mt-1 w-full rounded-lg border px-2 py-1.5" /></label>
              <label className="col-span-2 block">Notas<input value={form.notes} onChange={e => set({ notes: e.target.value })} className="mt-1 w-full rounded-lg border px-2 py-1.5" /></label>
            </div>
            <div className="flex justify-end gap-2 border-t pt-3">
              <button onClick={() => { setForm(null); setVersionOf(null) }} className="rounded-lg px-3 py-1.5 text-slate-600 hover:bg-slate-100">Cancelar</button>
              <button onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-[#002855] px-4 py-1.5 font-semibold text-white disabled:opacity-50">{saving && <Loader2 className="h-4 w-4 animate-spin" />}Guardar</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

// Desglose de una cotización de quote_transport (se reutiliza en Solicitud y Despacho)
export function QuoteBreakdown({ quote, compact }: { quote: Record<string, unknown>; compact?: boolean }) {
  const lines = (quote.lines || []) as { label: string; scope: string; quantity: number; unit_rate: number; amount: number; basis: string }[]
  const missing = (quote.missing || []) as string[]
  const scopeTxt = (s: string) => (s === 'CONTRATO' ? 'tarifa del contrato' : s === 'CLIENTE' ? 'tarifa del cliente' : 'tarifa general')
  return (
    <div className={`mt-2 rounded-lg border border-slate-200 bg-slate-50 ${compact ? 'p-2 text-xs' : 'p-3 text-sm'}`}>
      {quote.vehicle_class ? <p className="mb-1 text-slate-600">Unidad: <strong>{String(quote.vehicle_class)}</strong>{quote.vehicle_class_suggested ? ' (sugerida por peso)' : ''}{quote.plate ? ` · placa ${String(quote.plate)}` : ''}</p> : null}
      {lines.length > 0 && (
        <ul className="space-y-0.5">
          {lines.map((l, i) => (
            <li key={i} className="flex justify-between gap-3">
              <span>{l.label}{Number(l.quantity) !== 1 ? ` × ${l.quantity}` : ''} <span className="text-slate-400">· {scopeTxt(l.scope)}</span></span>
              <span className="tabular-nums">{money(l.amount)}</span>
            </li>
          ))}
          <li className="mt-1 flex justify-between border-t pt-1 font-semibold"><span>Total</span><span className="tabular-nums">{money(Number(quote.total))}</span></li>
          {quote.client_total != null && <li className="flex justify-between text-slate-500"><span>Precio al cliente</span><span className="tabular-nums">{money(Number(quote.client_total))}</span></li>}
        </ul>
      )}
      {missing.map((m, i) => <p key={i} className="text-amber-700">⚠ {m}</p>)}
    </div>
  )
}
