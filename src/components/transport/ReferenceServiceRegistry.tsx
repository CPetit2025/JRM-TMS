'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Loader2, RefreshCw, Search } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { referenceRegistryTotals, type ReferenceServiceRegistryRow } from '@/lib/reference-service-registry'
import { DataTable } from '@/components/ui/data-table'
import { FilterField, FilterToolbar, filterControl } from '@/components/ui/filter-toolbar'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'

const stageLabels = { COMPROMETIDO: 'Comprometido', REALIZADO: 'Realizado', ANULADO: 'Anulado' }
const stageTones: Record<ReferenceServiceRegistryRow['stage'], StatusTone> = { COMPROMETIDO: 'warning', REALIZADO: 'success', ANULADO: 'danger' }
const ledgerLabels = { RESERVADO: 'Importe reservado', CONSUMIDO: 'Costo registrado', LIBERADO: 'Importe liberado' }
const money = (value: number) => `S/ ${Number(value || 0).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function ReferenceServiceRegistry() {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<ReferenceServiceRegistryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [search, setSearch] = useState('')
  const [reference, setReference] = useState('TODOS')
  const [stage, setStage] = useState('TODOS')
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    let cancelled = false
    void Promise.resolve().then(async () => {
      if (cancelled) return
      setLoading(true)
      setError('')
      setRows([])
      if (from && to && from > to) {
        setError('La fecha inicial debe ser anterior o igual a la fecha final.')
        setLoading(false)
        return
      }
      try {
        const { data, error: queryError } = await supabase.rpc('get_reference_service_registry', { p_from: from || null, p_to: to || null })
        if (queryError) throw queryError
        if (!cancelled) setRows(Array.isArray(data) ? data as ReferenceServiceRegistryRow[] : [])
      } catch {
        if (!cancelled) setError('No se pudieron consultar los servicios por referencia. Reintente o verifique su acceso al registro.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [supabase, from, to, refresh])

  const filtered = rows.filter(row =>
    (reference === 'TODOS' || row.reference_type === reference) &&
    (stage === 'TODOS' || row.stage === stage) &&
    (!search.trim() || [row.reference_type, row.reference_number, row.request_number, row.dispatch_number, row.plate, row.driver_name, row.provider_name, row.description].join(' ').toLocaleLowerCase('es').includes(search.trim().toLocaleLowerCase('es'))))
  const totals = referenceRegistryTotals(filtered)

  return <section className="space-y-3" aria-label="Servicios con OC, OS o RQ">
    <p className="text-sm text-slate-600">Recojos y traslados aprobados por el supervisor con OC, OS o RQ. Los importes corresponden al flete y la descarga de la ruta; no descuentan una partida de OT. El cierre operativo no significa pago.</p>
    <FilterToolbar compact label="Filtros de servicios por referencia" onClear={() => { setFrom(''); setTo(''); setSearch(''); setReference('TODOS'); setStage('TODOS') }}>
      <label className="relative min-w-0 flex-1 basis-64"><span className="sr-only">Buscar referencia o servicio</span><Search aria-hidden className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" /><input type="search" placeholder="Referencia, solicitud, placa o conductor" value={search} onChange={event => setSearch(event.target.value)} className={`${filterControl} pl-9`} /></label>
      <FilterField inline label="Referencia"><select className={filterControl} value={reference} onChange={event => setReference(event.target.value)}><option value="TODOS">Todas</option>{['OC', 'OS', 'RQ'].map(value => <option key={value} value={value}>{value}</option>)}</select></FilterField>
      <FilterField inline label="Etapa"><select className={filterControl} value={stage} onChange={event => setStage(event.target.value)}><option value="TODOS">Todas</option>{Object.entries(stageLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></FilterField>
      <FilterField inline label="Desde"><input type="date" value={from} onChange={event => setFrom(event.target.value)} className={filterControl} /></FilterField>
      <FilterField inline label="Hasta"><input type="date" value={to} onChange={event => setTo(event.target.value)} className={filterControl} /></FilterField>
      <button type="button" onClick={() => setRefresh(value => value + 1)} disabled={loading} className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm text-jrm-navy disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Actualizar</button>
    </FilterToolbar>
    {error ? <div role="alert" className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"><AlertCircle className="h-4 w-4 shrink-0" />{error}</div> : null}
    {!loading && !error && rows.length >= 500 && <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Se muestran los 500 movimientos más recientes. Acote las fechas para consultar el período completo; los importes corresponden a los movimientos mostrados.</p>}
    <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-jrm border border-jrm-line bg-jrm-surface px-4 py-3 text-sm">
      <span>{loading ? 'Consultando…' : `${filtered.length} movimiento(s)`}</span><span>Reservado: <strong>{money(totals.reserved)}</strong></span><span>Costo registrado: <strong>{money(totals.consumed)}</strong></span><span>Liberado: <strong>{money(totals.released)}</strong></span>
    </div>
    <div className="overflow-auto rounded-jrm border border-jrm-line bg-jrm-surface shadow-jrm-card">
      <DataTable dense className="min-w-[1050px] text-left">
        <thead><tr>{['Fecha', 'Referencia', 'Solicitud / tipo', 'Servicio', 'Unidad / conductor', 'Proveedor', 'Monto', 'Despacho', 'Etapa'].map(label => <th key={label}>{label}</th>)}</tr></thead>
        <tbody>
          {loading ? <tr><td colSpan={9} className="p-8 text-center text-slate-500"><Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />Consultando servicios…</td></tr> : error ? <tr><td colSpan={9} className="p-8 text-center text-slate-500">La consulta no está disponible. Use Actualizar para reintentar.</td></tr> : filtered.length === 0 ? <tr><td colSpan={9} className="p-8 text-center text-slate-500">No hay movimientos por OC, OS o RQ para estos filtros.</td></tr> : filtered.map(row => <tr key={`${row.service_type}:${row.id}`} className="hover:bg-slate-50">
            <td className="whitespace-nowrap" data-sort-value={row.service_date || ''}>{row.service_date ? new Date(`${row.service_date.slice(0, 10)}T12:00:00`).toLocaleDateString('es-PE') : 'Sin fecha'}</td>
            <td className="font-semibold text-jrm-navy">{row.reference_type} · {row.reference_number}</td>
            <td><span className="font-medium">{row.request_number}</span><span className="block text-xs text-slate-500">{row.request_type === 'RECOJO' ? 'Recojo' : 'Traslado punto a punto'}</span></td>
            <td><span className="font-medium">{row.service_type === 'FLETE' ? 'Flete' : 'Descarga'}</span><span className="block max-w-48 truncate text-xs text-slate-500" title={row.description || undefined}>{row.description || '—'}</span></td>
            <td><span className="font-medium">{row.plate || 'Sin placa'}</span><span className="block text-xs text-slate-500">{row.driver_name || 'Sin conductor'}</span></td>
            <td>{row.provider_name || '—'}</td>
            <td className="whitespace-nowrap text-right font-semibold" data-sort-value={row.amount_pen}>{money(row.amount_pen)}</td>
            <td><a className="font-medium text-jrm-navy underline underline-offset-2" href={`/torre-control?despacho=${encodeURIComponent(row.dispatch_id)}`}>{row.dispatch_number}</a><span className="block text-xs text-slate-500">{row.operation_state || '—'}</span></td>
            <td><StatusBadge tone={stageTones[row.stage]}>{stageLabels[row.stage]}</StatusBadge><span className="mt-1 block text-xs text-slate-500" title={row.status === 'CONSUMIDO' && row.stage === 'ANULADO' ? 'La cancelación operativa no revierte este costo ya registrado.' : undefined}>{ledgerLabels[row.status]}</span></td>
          </tr>)}
        </tbody>
      </DataTable>
    </div>
    {rows.length >= 500 && <p className="text-xs text-amber-700">La consulta muestra hasta 500 movimientos. Acote las fechas para revisar un periodo completo.</p>}
  </section>
}
