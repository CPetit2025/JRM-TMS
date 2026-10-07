'use client'
import { DataTable } from '@/components/ui/data-table'

import { useMemo, useState } from 'react'
import { ArrowRight, Search } from 'lucide-react'
import { fmtDate, fmtDias, fmtInt, fmtTn } from '@/lib/apt/format'
import { exportAptXlsx } from '@/lib/apt/export'
import type { FlowAdelantos } from '@/lib/apt/flowTypes'
import { ExportButton, Segmented, SortTh, sortRows, type SortState } from '@/components/apt/TfcShared'
import { short } from '@/components/apt/dashCharts'
import { AlmacenBadge, HATCH_BG, TraceLink } from './TrazaParts'
import { ASIG_COLOR, REASIG_COLOR } from './AdelantosCharts'

// Tablas de la página "Adelantos y 540": cambios de lote (asignación / reasignación), contratos y consumos internos

type Cambio = FlowAdelantos['cambios'][number]
type Consumo = FlowAdelantos['consumos'][number]
type Contrato = FlowAdelantos['contratos'][number]

const PAGE = 100
const norm = (s: unknown) => String(s ?? '').toLowerCase()
const matches = (q: string, ...vals: unknown[]) => !q || vals.some(v => norm(v).includes(q))

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="relative block">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="w-56 rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-2 text-xs outline-none focus:border-[#002855] focus:ring-2 focus:ring-[#002855]/10" />
    </label>
  )
}

function MoreRows({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  if (shown >= total) return null
  return (
    <div className="border-t border-slate-100 p-2 text-center">
      <button type="button" onClick={onMore} className="text-xs font-bold text-[#002855] hover:underline">
        Ver {fmtInt(Math.min(PAGE, total - shown))} más ({fmtInt(shown)} de {fmtInt(total)})
      </button>
    </div>
  )
}

export function ClaseBadge({ clase }: { clase: 'ASIGNACION' | 'REASIGNACION' }) {
  const a = clase === 'ASIGNACION'
  const c = a ? ASIG_COLOR : REASIG_COLOR
  return (
    <span className="inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-bold"
      style={{ color: a ? '#b45309' : c, borderColor: `${c}66`, background: `${c}14` }}
      title={a ? 'Asignación de contrato: el adelanto (sin contrato) pasa a un lote de contrato' : 'Reasignación: el material cambia de una OT a otra'}>
      {a ? 'Asignación' : 'Reasignación'}
    </span>
  )
}

type Clase = 'TODAS' | 'ASIGNACION' | 'REASIGNACION'

export function CambiosTable({ rows }: { rows: Cambio[] }) {
  const [clase, setClase] = useState<Clase>('TODAS')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<SortState>({ key: 'fecha', desc: true })
  const [limit, setLimit] = useState(PAGE)

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    return sortRows(rows.filter(r => (clase === 'TODAS' || r.clase === clase)
      && matches(s, r.lote, r.lote_destino, r.producto, r.glosa, r.cliente, r.documento)), sort)
  }, [rows, clase, q, sort])
  const tot = filtered.reduce((acc, r) => acc + r.tn, 0)
  const ini = filtered.reduce((acc, r) => acc + (r.inicial_tn || 0), 0)

  const doExport = () => exportAptXlsx('APT_flujo_cambios_lote', {
    'Cambios de lote': filtered.map(r => ({
      Fecha: fmtDate(r.fecha), Clase: r.clase === 'ASIGNACION' ? 'Asignación' : 'Reasignación', Desde: r.desde, Hacia: r.hacia,
      'Lote origen': r.lote, 'Lote destino': r.lote_destino, Producto: r.producto, Glosa: r.glosa, Documento: r.documento, Cliente: r.cliente,
      TN: r.tn, 'Días espera': r.dias_espera, 'TN de stock previo': r.inicial_tn,
    })),
  })

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<Clase> label="Clase de cambio" value={clase} onChange={v => { setClase(v); setLimit(PAGE) }} options={[
            { value: 'TODAS', label: 'Todas' }, { value: 'ASIGNACION', label: 'Asignación' }, { value: 'REASIGNACION', label: 'Reasignación' },
          ]} />
          <SearchBox value={q} onChange={v => { setQ(v); setLimit(PAGE) }} placeholder="Lote, producto, cliente, documento…" />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] tabular-nums text-slate-500">{fmtInt(filtered.length)} filas · <b className="text-slate-700">{fmtTn(tot)} TN</b> · {fmtTn(ini)} TN de stock previo</span>
          <ExportButton onClick={doExport} disabled={!filtered.length} />
        </div>
      </div>
      <div className="max-h-[560px] overflow-auto">
        <DataTable className="w-full min-w-[1100px] text-xs">
          <thead className="sticky top-0 z-10 bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <SortTh k="fecha" sort={sort} onSort={setSort} right={false}>Fecha</SortTh>
              <SortTh k="clase" sort={sort} onSort={setSort} right={false}>Clase</SortTh>
              <th className="px-3 py-2 text-left font-bold">Movimiento</th>
              <SortTh k="lote" sort={sort} onSort={setSort} right={false}>Lote origen → destino</SortTh>
              <SortTh k="producto" sort={sort} onSort={setSort} right={false}>Producto</SortTh>
              <SortTh k="cliente" sort={sort} onSort={setSort} right={false}>Cliente</SortTh>
              <SortTh k="tn" sort={sort} onSort={setSort}>TN</SortTh>
              <SortTh k="dias_espera" sort={sort} onSort={setSort} title="Días desde la producción del adelanto hasta que se le asignó el contrato">Días espera</SortTh>
              <SortTh k="inicial_tn" sort={sort} onSort={setSort} title="Parte que venía del stock previo (sin fecha de producción)">Stock previo</SortTh>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.slice(0, limit).map((r, i) => (
              <tr key={i} className="hover:bg-slate-50">
                <td className="whitespace-nowrap px-3 py-2 tabular-nums text-slate-600">{fmtDate(r.fecha)}</td>
                <td className="px-3 py-2"><ClaseBadge clase={r.clase} /></td>
                <td className="whitespace-nowrap px-3 py-2">
                  <span className="inline-flex items-center gap-1"><AlmacenBadge almacen={r.desde} short /><ArrowRight className="h-3 w-3 text-slate-400" /><AlmacenBadge almacen={r.hacia} short /></span>
                  {r.documento && <span className="mt-0.5 block text-[10px] text-slate-400">Doc. {r.documento}</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  <span className="inline-flex items-center gap-1.5"><TraceLink q={r.lote} /><ArrowRight className="h-3 w-3 text-slate-400" /><TraceLink q={r.lote_destino} /></span>
                </td>
                <td className="max-w-[280px] px-3 py-2">
                  <span className="block font-mono text-[11px] text-slate-700">{r.producto}</span>
                  <span className="block truncate text-[11px] text-slate-500" title={r.glosa || ''}>{r.glosa || '—'}</span>
                </td>
                <td className="max-w-[200px] truncate px-3 py-2 text-slate-600" title={r.cliente || ''}>{short(r.cliente, 40)}</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-800">{fmtTn(r.tn)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtDias(r.dias_espera)}</td>
                <td className="px-3 py-2 text-right">
                  {r.inicial_tn > 0
                    ? <span className="inline-flex rounded border border-slate-200 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-slate-600" style={{ background: HATCH_BG }}>{fmtTn(r.inicial_tn)}</span>
                    : <span className="text-slate-300">—</span>}
                </td>
              </tr>
            ))}
            {!filtered.length && <tr><td colSpan={9} className="p-6 text-center text-sm text-slate-500">Sin cambios de lote con estos criterios.</td></tr>}
          </tbody>
        </DataTable>
      </div>
      <MoreRows shown={Math.min(limit, filtered.length)} total={filtered.length} onMore={() => setLimit(l => l + PAGE)} />
    </div>
  )
}

export function ContratosTable({ rows }: { rows: Contrato[] }) {
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<SortState>({ key: 'tn', desc: true })
  const [limit, setLimit] = useState(PAGE)
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    return sortRows(rows.filter(r => matches(s, r.contrato, r.cliente)), sort)
  }, [rows, q, sort])
  const doExport = () => exportAptXlsx('APT_flujo_contratos_asignados', {
    Contratos: filtered.map(r => ({
      Contrato: r.contrato, Cliente: r.cliente, Clase: r.clase === 'ASIGNACION' ? 'Asignación' : 'Reasignación', TN: r.tn,
      'Lotes de origen': r.lotes_origen, Primera: fmtDate(r.primera), Última: fmtDate(r.ultima),
    })),
  })
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
        <SearchBox value={q} onChange={v => { setQ(v); setLimit(PAGE) }} placeholder="Contrato o cliente…" />
        <ExportButton onClick={doExport} disabled={!filtered.length} />
      </div>
      <div className="max-h-[420px] overflow-auto">
        <DataTable className="w-full min-w-[640px] text-xs">
          <thead className="sticky top-0 z-10 bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <SortTh k="contrato" sort={sort} onSort={setSort} right={false}>Contrato</SortTh>
              <SortTh k="cliente" sort={sort} onSort={setSort} right={false}>Cliente</SortTh>
              <SortTh k="clase" sort={sort} onSort={setSort} right={false}>Clase</SortTh>
              <SortTh k="tn" sort={sort} onSort={setSort}>TN</SortTh>
              <SortTh k="lotes_origen" sort={sort} onSort={setSort} title="Lotes de adelanto u OT de los que vino el material">Lotes origen</SortTh>
              <SortTh k="primera" sort={sort} onSort={setSort}>Primera</SortTh>
              <SortTh k="ultima" sort={sort} onSort={setSort}>Última</SortTh>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.slice(0, limit).map(r => (
              <tr key={`${r.contrato}-${r.clase}`} className="hover:bg-slate-50">
                <td className="whitespace-nowrap px-3 py-2"><TraceLink q={r.contrato} /></td>
                <td className="max-w-[220px] truncate px-3 py-2 text-slate-600" title={r.cliente || ''}>{short(r.cliente, 42)}</td>
                <td className="px-3 py-2"><ClaseBadge clase={r.clase} /></td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-800">{fmtTn(r.tn)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtInt(r.lotes_origen)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-600">{fmtDate(r.primera)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-600">{fmtDate(r.ultima)}</td>
              </tr>
            ))}
            {!filtered.length && <tr><td colSpan={7} className="p-6 text-center text-sm text-slate-500">Sin contratos con estos criterios.</td></tr>}
          </tbody>
        </DataTable>
      </div>
      <MoreRows shown={Math.min(limit, filtered.length)} total={filtered.length} onMore={() => setLimit(l => l + PAGE)} />
    </div>
  )
}

export function ConsumosTable({ rows }: { rows: Consumo[] }) {
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<SortState>({ key: 'fecha', desc: true })
  const [limit, setLimit] = useState(PAGE)
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    return sortRows(rows.filter(r => matches(s, r.lote, r.producto, r.glosa, r.numrel, r.docrel, r.almacen, r.documento)), sort)
  }, [rows, q, sort])
  const tot = filtered.reduce((acc, r) => acc + r.tn, 0)
  const doExport = () => exportAptXlsx('APT_flujo_consumos_internos', {
    Consumos: filtered.map(r => ({
      Fecha: fmtDate(r.fecha), Almacén: r.almacen, Lote: r.lote, 'OP/OT (NumRel)': r.numrel, DocRel: r.docrel, Documento: r.documento,
      Producto: r.producto, Glosa: r.glosa, Cliente: r.cliente, TN: r.tn,
    })),
  })
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
        <SearchBox value={q} onChange={v => { setQ(v); setLimit(PAGE) }} placeholder="Lote, OP/OT, DocRel, producto…" />
        <div className="flex items-center gap-3">
          <span className="text-[11px] tabular-nums text-slate-500">{fmtInt(filtered.length)} filas · <b className="text-slate-700">{fmtTn(tot)} TN</b></span>
          <ExportButton onClick={doExport} disabled={!filtered.length} />
        </div>
      </div>
      <div className="max-h-[460px] overflow-auto">
        <DataTable className="w-full min-w-[900px] text-xs">
          <thead className="sticky top-0 z-10 bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <SortTh k="fecha" sort={sort} onSort={setSort} right={false}>Fecha</SortTh>
              <SortTh k="almacen" sort={sort} onSort={setSort} right={false}>Almacén</SortTh>
              <SortTh k="lote" sort={sort} onSort={setSort} right={false}>Lote</SortTh>
              <SortTh k="numrel" sort={sort} onSort={setSort} right={false} title="OP u OT que consumió el material (NumRel)">OP / OT</SortTh>
              <SortTh k="docrel" sort={sort} onSort={setSort} right={false}>DocRel</SortTh>
              <SortTh k="producto" sort={sort} onSort={setSort} right={false}>Producto</SortTh>
              <SortTh k="tn" sort={sort} onSort={setSort}>TN</SortTh>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.slice(0, limit).map((r, i) => (
              <tr key={i} className="hover:bg-slate-50">
                <td className="whitespace-nowrap px-3 py-2 tabular-nums text-slate-600">{fmtDate(r.fecha)}</td>
                <td className="px-3 py-2"><AlmacenBadge almacen={r.almacen} short /></td>
                <td className="whitespace-nowrap px-3 py-2"><TraceLink q={r.lote} /></td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-slate-700">{r.numrel || '—'}</td>
                <td className="whitespace-nowrap px-3 py-2 text-slate-600">{r.docrel || '—'}{r.documento && <span className="block text-[10px] text-slate-400">Doc. {r.documento}</span>}</td>
                <td className="max-w-[320px] px-3 py-2">
                  <span className="block font-mono text-[11px] text-slate-700">{r.producto}</span>
                  <span className="block truncate text-[11px] text-slate-500" title={r.glosa || ''}>{r.glosa || '—'}</span>
                </td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-800">{fmtTn(r.tn)}</td>
              </tr>
            ))}
            {!filtered.length && <tr><td colSpan={7} className="p-6 text-center text-sm text-slate-500">Sin consumos internos con estos criterios.</td></tr>}
          </tbody>
        </DataTable>
      </div>
      <MoreRows shown={Math.min(limit, filtered.length)} total={filtered.length} onMore={() => setLimit(l => l + PAGE)} />
    </div>
  )
}
