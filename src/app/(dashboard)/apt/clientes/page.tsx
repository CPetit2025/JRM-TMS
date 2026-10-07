'use client'
import { DataTable } from '@/components/ui/data-table'

import { Fragment, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronDown, ChevronRight, Info, Loader2 } from 'lucide-react'
import { aptApi } from '@/lib/apt/api'
import { exportAptXlsx } from '@/lib/apt/export'
import { APT_COLORS, fmtDate, fmtDias, fmtInt, fmtPct, fmtTn } from '@/lib/apt/format'
import { loteHref, useAptFilters } from '@/lib/apt/useAptFilters'
import type { AptFilters, AptGroupRow } from '@/lib/apt/types'
import { ChartCard, DiasBadge, EmptyState, ErrorBlock, EstadoBadge, InlineBar, KpiCard, LoadingBlock, TipoBadge } from '@/components/apt/ui'
import { ExportButton, RankBars, Segmented, SortTh, truncate, useAsyncData } from '@/components/apt/PphShared'

// Análisis por Cliente → OT → Lote: primer ingreso a APT, último despacho y saldo final de cada uno.
// El cliente del lote sale de sus guías de SALIDA (o las de su OT, o el cliente de la OT en Contratos).

type Vista = 'cliente' | 'contrato' | 'lote'
const VISTAS: Array<{ value: Vista; label: string }> = [
  { value: 'cliente', label: 'Por cliente' },
  { value: 'contrato', label: 'Por OT' },
  { value: 'lote', label: 'Por lote (NumRel)' },
]
const NIVEL_HIJO: Record<Vista, Vista | null> = { cliente: 'contrato', contrato: 'lote', lote: null }
const SIN_CLIENTE = '(Sin cliente identificado)'
const LIMIT = 20000

type SortKey = 'clave' | 'primer_ingreso' | 'ultimo_despacho' | 'tn_in' | 'tn_out' | 'tn_saldo' | 'dias' | 'tn_dias' | 'lotes'
const val = (r: AptGroupRow, k: SortKey) => (k === 'clave' ? r.clave : r[k] ?? null)
function sortRows(rows: AptGroupRow[], k: SortKey, desc: boolean) {
  return [...rows].sort((a, b) => {
    const x = val(a, k), y = val(b, k)
    if (x === y) return 0
    if (x === null) return 1
    if (y === null) return -1
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'es')
    return desc ? -c : c
  })
}

// Filtro que acota un nivel hijo a su padre
function childFilters(base: AptFilters, vista: Vista, r: AptGroupRow): AptFilters {
  if (vista === 'cliente') return { ...base, clientes: [r.clave] }
  if (vista === 'contrato') return { ...base, contratos: [r.clave] }
  return base
}

function Fila({ r, vista, depth, filters, alert, maxSaldo }: {
  r: AptGroupRow; vista: Vista; depth: number; filters: AptFilters; alert: number; maxSaldo: number
}) {
  const [open, setOpen] = useState(false)
  const hijo = NIVEL_HIJO[vista]
  const sinCliente = vista === 'cliente' && r.clave === SIN_CLIENTE
  return (
    <Fragment>
      <tr className={`border-b border-slate-100 ${depth === 0 ? 'hover:bg-slate-50' : depth === 1 ? 'bg-slate-50/60 hover:bg-slate-100/60' : 'bg-slate-100/50 hover:bg-slate-100'}`}>
        <td className="px-3 py-2" style={{ paddingLeft: 12 + depth * 22 }}>
          <div className="flex items-start gap-1.5">
            {hijo ? (
              <button type="button" onClick={() => setOpen(o => !o)} aria-label={open ? 'Contraer' : 'Desplegar'}
                className="mt-0.5 rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-[#002855]">
                {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
            ) : <span className="w-5" />}
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                {vista === 'lote'
                  ? <Link href={loteHref(r.clave, filters)} className="font-bold text-[#002855] hover:text-[#cf152d] hover:underline">{r.clave}</Link>
                  : <span className={`font-bold ${sinCliente ? 'italic text-slate-500' : 'text-slate-800'} ${vista === 'cliente' ? 'max-w-[300px] truncate' : ''}`} title={r.clave}>
                      {vista === 'contrato' ? `OT ${r.clave}` : r.clave}
                    </span>}
                {vista !== 'cliente' && r.tipo && r.tipo !== 'CONTRATO' && <TipoBadge tipo={r.tipo} />}
              </div>
              {vista !== 'cliente' && (
                <p className="max-w-[300px] truncate text-[11px] text-slate-500" title={[r.cliente, r.etiqueta].filter(Boolean).join(' · ')}>
                  {depth === 0 && r.cliente ? <b className="font-semibold text-slate-600">{truncate(r.cliente, 40)} · </b> : null}{r.etiqueta || ''}
                </p>
              )}
            </div>
          </div>
        </td>
        <td className="px-3 py-2 text-right tabular-nums text-slate-600">
          {vista === 'cliente' ? `${fmtInt(r.contratos)} / ${fmtInt(r.lotes)}` : vista === 'contrato' ? fmtInt(r.lotes) : fmtInt(r.productos)}
        </td>
        <td className="px-3 py-2 text-center tabular-nums">{fmtDate(r.primer_ingreso)}</td>
        <td className="px-3 py-2 text-center tabular-nums">{fmtDate(r.ultimo_ingreso)}</td>
        <td className="px-3 py-2 text-center tabular-nums">{fmtDate(r.primera_salida)}</td>
        <td className="px-3 py-2 text-center tabular-nums font-semibold text-slate-700">{fmtDate(r.ultimo_despacho)}</td>
        <td className="px-3 py-2 text-right tabular-nums">{fmtTn(r.tn_in)}</td>
        <td className="px-3 py-2 text-right tabular-nums">{fmtTn(r.tn_out)}</td>
        <td className="px-3 py-2 text-right tabular-nums text-slate-500">{fmtPct(r.pct_despachado)}</td>
        <td className="px-3 py-2 text-right">
          <div className="flex min-w-[100px] flex-col items-end gap-1">
            <span className={`font-bold tabular-nums ${r.tn_saldo > 0.0005 ? 'text-[#002855]' : 'text-slate-400'}`}>{fmtTn(r.tn_saldo)}</span>
            {r.tn_saldo > 0.0005 && <InlineBar value={r.tn_saldo} max={maxSaldo} />}
          </div>
        </td>
        <td className="px-3 py-2 text-center">{r.kg_saldo > 0.5 ? <DiasBadge dias={r.dias} alert={alert} /> : <span className="text-slate-300">—</span>}</td>
        <td className="px-3 py-2 text-right tabular-nums">{fmtTn(r.tn_dias)}</td>
        <td className="px-3 py-2"><EstadoBadge estado={r.estado} /></td>
      </tr>
      {open && hijo && <Hijos vista={hijo} filters={childFilters(filters, vista, r)} depth={depth + 1} alert={alert} maxSaldo={maxSaldo} />}
    </Fragment>
  )
}

function Hijos({ vista, filters, depth, alert, maxSaldo }: { vista: Vista; filters: AptFilters; depth: number; alert: number; maxSaldo: number }) {
  const key = `${vista}|${JSON.stringify(filters)}`
  const q = useAsyncData(key, () => aptApi.detail<AptGroupRow>(filters, vista, 'kg_saldo', true, 500))
  if (q.loading && !q.data) {
    return <tr><td colSpan={13} className="px-3 py-2 text-xs text-slate-400" style={{ paddingLeft: 12 + depth * 22 }}><Loader2 className="mr-1 inline h-3 w-3 animate-spin" />Cargando…</td></tr>
  }
  if (q.error) return <tr><td colSpan={13} className="px-3 py-2 text-xs text-red-600">{q.error}</td></tr>
  return <>{(q.data?.rows || []).map(r => <Fila key={r.clave} r={r} vista={vista} depth={depth} filters={filters} alert={alert} maxSaldo={maxSaldo} />)}</>
}

export default function AptClientesPage() {
  const { filters, filterKey, patchFilters } = useAptFilters()
  const router = useRouter()
  const [vista, setVista] = useState<Vista>('cliente')
  const [sort, setSort] = useState<SortKey>('tn_saldo')
  const [desc, setDesc] = useState(true)
  const [exporting, setExporting] = useState(false)

  const q = useAsyncData(`${vista}|${filterKey}`, () => Promise.all([
    aptApi.detail<AptGroupRow>(filters, vista, 'kg_saldo', true, LIMIT),
    aptApi.settings(),
  ]))
  const det = q.data?.[0]
  const alert = q.data?.[1]?.settings.alert_days ?? 60
  const rows = useMemo(() => sortRows(det?.rows || [], sort, desc), [det, sort, desc])
  const conSaldo = rows.filter(r => r.kg_saldo > 0.5)
  const maxSaldo = Math.max(0, ...rows.map(r => Number(r.tn_saldo) || 0))
  const onSort = (k: string) => {
    if (k === sort) setDesc(d => !d)
    else { setSort(k as SortKey); setDesc(k !== 'clave') }
  }

  const exportar = async () => {
    setExporting(true)
    try {
      const [cl, ot, lo] = await Promise.all((['cliente', 'contrato', 'lote'] as const).map(l => aptApi.detail<AptGroupRow>(filters, l, 'kg_saldo', true, LIMIT)))
      const map = (r: AptGroupRow, l: Vista) => ({
        ...(l === 'cliente' ? { Cliente: r.clave, 'N° OT': r.contratos, 'N° lotes': r.lotes }
          : l === 'contrato' ? { OT: r.clave, Cliente: r.cliente, 'N° lotes': r.lotes }
            : { Lote: r.clave, Tipo: r.tipo, Cliente: r.cliente, 'OT madre': r.clave.split('-')[0], 'Glosa principal': r.etiqueta }),
        'Primer ingreso APT': r.primer_ingreso, 'Último ingreso APT': r.ultimo_ingreso, 'Primer despacho': r.primera_salida,
        'Último despacho': r.ultimo_despacho, 'TN ingresada': r.tn_in, 'TN despachada': r.tn_out, '% despachado': r.pct_despachado,
        'Saldo final TN': r.tn_saldo, 'Días del saldo más antiguo': r.kg_saldo > 0.5 ? r.dias : null, 'Aging ponderado': r.aging_pond,
        'TN×Días': r.tn_dias, Estado: r.estado,
      })
      exportAptXlsx(`APT_cliente_OT_lote_${new Date().toISOString().slice(0, 10)}`, {
        Clientes: cl.rows.map(r => map(r, 'cliente')), OT: ot.rows.map(r => map(r, 'contrato')), Lotes: lo.rows.map(r => map(r, 'lote')),
      })
    } finally {
      setExporting(false)
    }
  }

  const etiqueta = vista === 'cliente' ? 'clientes' : vista === 'contrato' ? 'OT' : 'lotes'
  const sinCliente = vista === 'cliente' ? rows.find(r => r.clave === SIN_CLIENTE) : undefined
  const top = conSaldo.slice().sort((a, b) => b.tn_saldo - a.tn_saldo).slice(0, 10)
  const topAntiguos = conSaldo.slice().sort((a, b) => (b.dias ?? 0) - (a.dias ?? 0)).slice(0, 10)
  const selectKey = (k: string) => {
    if (vista === 'cliente') patchFilters({ clientes: [k] })
    else if (vista === 'contrato') patchFilters({ contratos: [k] })
    else router.push(loteHref(k, filters))
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented value={vista} options={VISTAS} onChange={v => { setVista(v); setSort('tn_saldo'); setDesc(true) }} label="Ver" />
        <ExportButton onClick={exportar} busy={exporting} disabled={!rows.length} />
      </div>

      {q.error && !det ? <ErrorBlock message={q.error} onRetry={q.reload} /> : !det ? <LoadingBlock /> : rows.length === 0 ? (
        <EmptyState title="Sin datos para estos filtros">Cargue ENTRADA y SALIDA en “Cargas y parámetros” o quite filtros.</EmptyState>
      ) : (
        <div className={`space-y-4 transition-opacity ${q.loading ? 'opacity-60' : ''}`}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <KpiCard label={`${etiqueta} con saldo`} value={fmtInt(conSaldo.length)} hint={`de ${fmtInt(rows.length)} con ingreso a APT`} tone="navy" />
            <KpiCard label="Saldo final" value={fmtTn(det.totals.tn_saldo)} unit="TN" hint={`${fmtTn(det.totals.tn_in)} TN ingresadas`} />
            <KpiCard label="Despachado" value={fmtTn(det.totals.tn_out)} unit="TN"
              hint={`${fmtPct(det.totals.tn_in ? (100 * det.totals.tn_out) / det.totals.tn_in : null)} de lo ingresado`} tone="ok" />
            <KpiCard label="TN×Días" value={fmtTn(det.totals.tn_dias)} tone="crit" hint="Saldo × días en APT" />
            <KpiCard label={`${etiqueta} > ${alert} días`} value={fmtInt(conSaldo.filter(r => (r.dias ?? 0) > alert).length)} tone="warn"
              hint="Con saldo más antiguo que el plazo de alerta" />
          </div>

          {sinCliente && sinCliente.kg_saldo > 0.5 && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                <b>{fmtTn(sinCliente.tn_saldo)} TN</b> en {fmtInt(sinCliente.lotes)} lotes no tienen cliente identificado: el lote ni su OT tienen guías
                de despacho y la OT no está registrada con cliente en Contratos. Al registrar la OT con su cliente en el TMS, se asigna en la próxima carga.
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <ChartCard title={`Top 10 ${etiqueta} por saldo final`} subtitle="TN pendientes en APT al corte">
              <RankBars items={top.map(r => ({ key: r.clave, label: vista === 'contrato' ? `OT ${r.clave}` : truncate(r.clave, 28), sub: vista === 'cliente' ? null : r.cliente,
                value: r.tn_saldo, extra: [['Días', fmtDias(r.dias)], ['Último despacho', fmtDate(r.ultimo_despacho)]] }))}
                format={fmtTn} color={APT_COLORS.navy} onSelect={selectKey} labelWidth={180} />
            </ChartCard>
            <ChartCard title={`Top 10 ${etiqueta} con saldo más antiguo`} subtitle="Días desde el ingreso del saldo más antiguo">
              <RankBars items={topAntiguos.map(r => ({ key: r.clave, label: vista === 'contrato' ? `OT ${r.clave}` : truncate(r.clave, 28), sub: vista === 'cliente' ? null : r.cliente,
                value: r.dias ?? 0, extra: [['Saldo TN', fmtTn(r.tn_saldo)], ['Primer ingreso', fmtDate(r.primer_ingreso)]] }))}
                format={fmtDias} color={APT_COLORS.red} onSelect={selectKey} labelWidth={180} />
            </ChartCard>
          </div>

          <ChartCard title={vista === 'cliente' ? 'Cliente → OT → Lote' : vista === 'contrato' ? 'OT → Lote' : 'Lotes'}
            subtitle="Despliegue cada fila para ver su detalle. Último despacho = última guía de SALIDA de sus lotes; saldo final = ingresado − despachado (FIFO)."
            bodyClassName="p-0">
            <div className="max-h-[70vh] overflow-auto">
              <DataTable className="w-full min-w-[1250px] text-xs">
                <thead>
                  <tr>
                    <SortTh label={vista === 'cliente' ? 'Cliente' : vista === 'contrato' ? 'OT' : 'Lote / NumRel'} k="clave" sort={sort} desc={desc} onSort={onSort} align="left" />
                    <SortTh label={vista === 'cliente' ? 'OT / Lotes' : vista === 'contrato' ? 'Lotes' : 'Productos'} k="lotes" sort={sort} desc={desc} onSort={onSort} />
                    <SortTh label="Primer ingreso" k="primer_ingreso" sort={sort} desc={desc} onSort={onSort} align="center" />
                    <th className="sticky top-0 z-10 whitespace-nowrap border-b border-slate-200 bg-slate-50 px-3 py-2 text-center text-[11px] font-bold uppercase tracking-wide text-slate-500">Último ingreso</th>
                    <th className="sticky top-0 z-10 whitespace-nowrap border-b border-slate-200 bg-slate-50 px-3 py-2 text-center text-[11px] font-bold uppercase tracking-wide text-slate-500">Primer despacho</th>
                    <SortTh label="Último despacho" k="ultimo_despacho" sort={sort} desc={desc} onSort={onSort} align="center" />
                    <SortTh label="TN ingresada" k="tn_in" sort={sort} desc={desc} onSort={onSort} />
                    <SortTh label="TN despachada" k="tn_out" sort={sort} desc={desc} onSort={onSort} />
                    <th className="sticky top-0 z-10 whitespace-nowrap border-b border-slate-200 bg-slate-50 px-3 py-2 text-right text-[11px] font-bold uppercase tracking-wide text-slate-500">% desp.</th>
                    <SortTh label="Saldo final TN" k="tn_saldo" sort={sort} desc={desc} onSort={onSort} />
                    <SortTh label="Días saldo" k="dias" sort={sort} desc={desc} onSort={onSort} align="center" />
                    <SortTh label="TN×Días" k="tn_dias" sort={sort} desc={desc} onSort={onSort} />
                    <th className="sticky top-0 z-10 whitespace-nowrap border-b border-slate-200 bg-slate-50 px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => <Fila key={`${vista}|${r.clave}`} r={r} vista={vista} depth={0} filters={filters} alert={alert} maxSaldo={maxSaldo} />)}
                </tbody>
                <tfoot>
                  <tr className="sticky bottom-0 border-t-2 border-slate-300 bg-slate-100 font-bold">
                    <td className="px-3 py-2">Total ({fmtInt(rows.length)} {etiqueta})</td>
                    <td colSpan={5} />
                    <td className="px-3 py-2 text-right tabular-nums">{fmtTn(det.totals.tn_in)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtTn(det.totals.tn_out)}</td>
                    <td />
                    <td className="px-3 py-2 text-right tabular-nums text-[#002855]">{fmtTn(det.totals.tn_saldo)}</td>
                    <td />
                    <td className="px-3 py-2 text-right tabular-nums">{fmtTn(det.totals.tn_dias)}</td>
                    <td />
                  </tr>
                </tfoot>
              </DataTable>
            </div>
          </ChartCard>
        </div>
      )}
    </div>
  )
}
