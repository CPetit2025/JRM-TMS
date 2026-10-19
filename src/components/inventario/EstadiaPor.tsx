'use client'

import { useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Download, Search, X } from 'lucide-react'
import { ChartCard, ErrorBlock, KpiCard, LoadingBlock } from '@/components/apt/ui'
import { DiasPill, PeriodBar, Table, td, tdNum, th } from '@/components/inventario/parts'
import { ProductoCell, useAmbito } from '@/components/inventario/ambito'
import { useInvQuery } from '@/components/inventario/useInvQuery'
import { invApi } from '@/lib/inventario/api'
import { fmtDias, fmtN, fmtPeso, fmtQty } from '@/lib/inventario/format'
import type { InvDwellDim, InvDwellDimRow } from '@/lib/inventario/types'
import { fmtDate } from '@/lib/apt/format'
import { exportAptXlsx } from '@/lib/apt/export'

// Estadía abierta por contrato / OT, ID (glosa) o cliente: días en bodega de lo que salió (FIFO) y stock que queda
type Ver = InvDwellDim | 'bodega'
const VER: Array<[Ver, string]> = [['ot', 'Contrato / OT'], ['producto', 'ID / Glosa'], ['cliente', 'Cliente'], ['bodega', 'Bodega']]
const PAGE = 300

// Selector «Ver por» guardado en la dirección (?ver=ot|producto|cliente|bodega)
export function VerPor({ bodegas, detalle }: { bodegas: ReactNode; detalle: (dim: InvDwellDim) => ReactNode }) {
  const sp = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const ver = (VER.some(([v]) => v === sp.get('ver')) ? sp.get('ver') : 'ot') as Ver
  const go = (v: Ver) => {
    const next = new URLSearchParams(sp.toString())
    next.set('ver', v)
    if (v !== 'producto') next.delete('ot')
    router.replace(`${pathname}?${next.toString()}`)
  }
  return (
    <div className="space-y-4">
      <div role="group" aria-label="Ver la estadía por" className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-2 shadow-sm">
        <span className="px-2 text-xs font-bold uppercase tracking-wide text-slate-500">Ver por</span>
        {VER.map(([v, label]) => <button key={v} type="button" aria-pressed={ver === v} onClick={() => go(v)}
          className={`min-h-9 rounded-lg px-3 text-xs font-semibold ${ver === v ? 'bg-[#002855] text-white' : 'text-slate-600 hover:bg-slate-50'}`}>{label}</button>)}
      </div>
      {ver === 'bodega' ? bodegas : detalle(ver)}
    </div>
  )
}

const LABEL: Record<InvDwellDim, string> = { ot: 'Contrato / OT', producto: 'ID / glosa', cliente: 'Cliente' }

export function EstadiaPor({ dim }: { dim: InvDwellDim }) {
  const sp = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const apt = useAmbito() === 'apt'
  const ot = sp.get('ot') ?? ''
  const [period, setPeriod] = useState({ desde: '', hasta: '' })
  const [draft, setDraft] = useState(sp.get('q') ?? '')
  const [q, setQ] = useState(draft)
  const [limit, setLimit] = useState(PAGE)
  const filtro = useMemo(() => ({ dim, ...(apt ? { ambito: 'apt' as const } : {}), desde: period.desde || undefined, hasta: period.hasta || undefined,
    ot: ot || undefined, q: q || undefined, limit }), [dim, apt, period, ot, q, limit])
  const r = useInvQuery(`dwelldim|${JSON.stringify(filtro)}`, () => invApi.dwellDim(filtro))
  const d = r.data
  const setOt = (v: string) => {
    const next = new URLSearchParams(sp.toString())
    next.set('ver', 'producto')
    if (v) next.set('ot', v); else next.delete('ot')
    router.replace(`${pathname}?${next.toString()}`)
  }
  const [exporting, setExporting] = useState(false)
  const exportar = async () => {
    setExporting(true)
    try {
      const all = await invApi.dwellDim({ ...filtro, limit: 5000 })
      exportAptXlsx(`estadia-${dim}${ot ? `-ot-${ot}` : ''}-${all.corte}`, { [LABEL[dim]]: all.filas.map(f => ({
        [LABEL[dim]]: f.key, ...(dim === 'producto' ? { Glosa: f.glosa ?? '', Unidad: f.unidad ?? '' } : {}), ...(dim === 'ot' ? { Cliente: f.cliente ?? '' } : {}),
        ...(dim !== 'ot' ? { OT: f.ots } : {}), 'Stock kg': f.stock_kg, 'Stock cantidad': f.stock_qty, 'Días en stock (pond. kg)': f.stock_dias ?? '',
        'Días máx. en stock': f.stock_dias_max ?? '', 'Stock > 60 d kg': f.stock_kg_60, 'Salidas (líneas)': f.salidas, 'Salidas kg': f.kg_salidas,
        'Despachado kg': f.kg_despachado, 'Días en bodega (prom.)': f.prom_dias ?? '', 'Días en bodega (pond. kg)': f.prom_dias_kg ?? '',
        p50: f.p50 ?? '', p90: f.p90 ?? '', Máx: f.max ?? '', 'Días desde origen': f.prom_origen ?? '',
      })) })
    } finally { setExporting(false) }
  }
  const sum = (k: 'stock_kg' | 'kg_despachado' | 'stock_kg_60') => (d?.filas ?? []).reduce((t, f) => t + f[k], 0)
  return (
    <div className="space-y-4">
      <PeriodBar desde={period.desde || d?.desde || ''} hasta={period.hasta || d?.hasta || ''} onChange={(a, b) => { setPeriod({ desde: a, hasta: b }); setLimit(PAGE) }}>
        <form onSubmit={e => { e.preventDefault(); setQ(draft.trim()); setLimit(PAGE) }} className="flex items-end gap-2">
          <label className="text-xs font-semibold text-slate-600">Buscar
            <span className="mt-1 flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 px-2"><Search className="h-4 w-4 text-slate-400" />
              <input value={draft} onChange={e => setDraft(e.target.value)} placeholder={dim === 'ot' ? 'OT o cliente' : dim === 'producto' ? 'ID o glosa' : 'Cliente'} className="w-48 text-sm outline-none" /></span>
          </label>
          <button type="submit" className="min-h-10 rounded-lg bg-[#002855] px-3 text-sm font-semibold text-white">Buscar</button>
        </form>
        {dim === 'producto' && <OtFiltro key={ot} value={ot} onChange={setOt} />}
        <button type="button" onClick={exportar} disabled={exporting || !d?.total} className="flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-[#002855] disabled:opacity-50"><Download className="h-4 w-4" /> Excel</button>
      </PeriodBar>
      {r.loading ? <LoadingBlock label="Calculando la estadía…" /> : r.error ? <ErrorBlock message={r.error} onRetry={r.reload} /> : d && <>
        {ot && <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <KpiCard label={`Stock de la OT ${d.ot ?? ot}`} value={fmtPeso(sum('stock_kg'))} tone="navy" hint={`${fmtN(d.total)} IDs`} />
          <KpiCard label="Stock con más de 60 días" value={fmtPeso(sum('stock_kg_60'))} tone={sum('stock_kg_60') > 0 ? 'warn' : 'ok'} />
          <KpiCard label="Despachado en el período" value={fmtPeso(sum('kg_despachado'))} hint={`${fmtDate(d.desde)} – ${fmtDate(d.hasta)}`} />
          <KpiCard label="Ficha y kardex" value={<Link href={`/apt/contratos?ot=${encodeURIComponent(d.ot ?? ot)}`} className="text-base underline">Abrir OT {d.ot ?? ot}</Link>} hint="Ingresos, salidas y saldo" />
        </div>}
        <ChartCard title={`Estadía por ${LABEL[dim].toLowerCase()}`}
          subtitle={`${fmtN(d.total)} ${dim === 'ot' ? 'OT' : dim === 'producto' ? 'IDs' : 'clientes'}${d.filas.length < d.total ? ` · mostrando ${fmtN(d.filas.length)}` : ''} · ${apt ? 'APT 647 · 540 · ST' : 'todas las bodegas'} · salidas del ${fmtDate(d.desde)} al ${fmtDate(d.hasta)} · stock al ${fmtDate(d.corte)}`}
          info="Stock: lo que queda hoy y cuántos días lleva (promedio ponderado por kg desde su ingreso a la bodega). Salidas: cada salida del período cruzada con el ingreso más antiguo de la misma bodega, producto y lote (FIFO); días en bodega = fecha de salida − fecha de ingreso.">
          <DimTable dim={dim} rows={d.filas} onOt={setOt} />
          {d.filas.length < d.total && <div className="mt-3 text-right"><button type="button" onClick={() => setLimit(l => l + PAGE)} className="min-h-9 rounded-lg border border-slate-300 px-3 text-xs font-semibold text-[#002855]">Ver {fmtN(Math.min(PAGE, d.total - d.filas.length))} más</button></div>}
        </ChartCard>
      </>}
    </div>
  )
}

function OtFiltro({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value)
  return (
    <form onSubmit={e => { e.preventDefault(); onChange(draft.trim()) }} className="flex items-end gap-2">
      <label className="text-xs font-semibold text-slate-600">Contrato / OT
        <span className="mt-1 flex min-h-10 items-center gap-1 rounded-lg border border-slate-300 px-2">
          <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="Ej. 16339" className="w-28 text-sm outline-none" />
          {value && <button type="button" aria-label="Quitar la OT" onClick={() => { setDraft(''); onChange('') }}><X className="h-4 w-4 text-slate-400" /></button>}
        </span>
      </label>
      <button type="submit" className="min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-[#002855]">Filtrar</button>
    </form>
  )
}

function DimTable({ dim, rows, onOt }: { dim: InvDwellDim; rows: InvDwellDimRow[]; onOt: (ot: string) => void }) {
  return (
    <Table empty={!rows.length} head={<>
      <tr>
        <th className={th} rowSpan={2}>{LABEL[dim]}</th>
        {dim !== 'ot' && <th className={`${th} text-right`} rowSpan={2}>OT</th>}
        <th className={`${th} border-l border-slate-200 text-center`} colSpan={4}>Stock actual</th>
        <th className={`${th} border-l border-slate-200 text-center`} colSpan={6}>Salidas del período · días en bodega</th>
      </tr>
      <tr>
        <th className={`${th} border-l border-slate-200 text-right`}>Saldo</th><th className={th}>Días</th><th className={th}>Máx.</th><th className={`${th} text-right`}>&gt; 60 d</th>
        <th className={`${th} border-l border-slate-200 text-right`}>Despachado</th><th className={`${th} text-right`}>Líneas</th><th className={th}>Prom.</th><th className={th}>p50</th><th className={th}>p90</th><th className={th}>Desde origen</th>
      </tr>
    </>}>
      {rows.map(f => <tr key={f.key} className="hover:bg-slate-50">
        <td className={td}>
          {dim === 'ot' ? <>
            <Link href={`/apt/contratos?ot=${encodeURIComponent(f.key)}`} className="font-bold text-[#002855] underline">{f.key}</Link>
            <p className="max-w-60 truncate text-[11px] text-slate-500" title={f.cliente ?? ''}>{f.cliente ?? 'Cliente no identificado'}</p>
            <button type="button" onClick={() => onOt(f.key)} className="text-[11px] font-semibold text-[#002855] underline decoration-dotted">Ver por ID</button>
          </> : dim === 'producto' ? <ProductoCell producto={f.key} glosa={f.glosa} /> : <p className="max-w-72 font-semibold text-slate-800">{f.key}</p>}
        </td>
        {dim !== 'ot' && <td className={tdNum}>{fmtN(f.ots)}</td>}
        <td className={`${tdNum} border-l border-slate-100 font-semibold`}>{f.stock_kg > 0 ? fmtPeso(f.stock_kg) : f.stock_qty > 0 ? (dim === 'producto' ? '' : 'Sin peso') : '—'}
          {dim === 'producto' && f.stock_qty > 0 && <p className="text-[10px] font-normal text-slate-500">{fmtQty(f.stock_qty)} {f.unidad ?? ''}</p>}</td>
        <td className={td}>{f.stock_qty > 0 ? <DiasPill dias={f.stock_dias} title="Promedio ponderado por kg desde el ingreso a la bodega" /> : '—'}</td>
        <td className={td}>{f.stock_qty > 0 ? fmtDias(f.stock_dias_max) : '—'}</td>
        <td className={tdNum}>{f.stock_kg_60 > 0 ? <span className="font-semibold text-amber-700">{fmtPeso(f.stock_kg_60)}</span> : '—'}</td>
        <td className={`${tdNum} border-l border-slate-100`}>{f.kg_despachado > 0 ? fmtPeso(f.kg_despachado) : '—'}</td>
        <td className={tdNum}>{f.salidas ? fmtN(f.salidas) : '—'}</td>
        <td className={td}>{f.salidas ? <DiasPill dias={f.prom_dias} title={f.prom_dias_kg === null ? undefined : `Ponderado por kg: ${fmtDias(f.prom_dias_kg)}`} /> : '—'}</td>
        <td className={td}>{f.salidas ? fmtDias(f.p50) : '—'}</td><td className={td}>{f.salidas ? fmtDias(f.p90) : '—'}</td>
        <td className={td}>{f.prom_origen === null ? '—' : <DiasPill dias={f.prom_origen} title="Desde la producción, compra o servicio de origen" />}</td>
      </tr>)}
    </Table>
  )
}
