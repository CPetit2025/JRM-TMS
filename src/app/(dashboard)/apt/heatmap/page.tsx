'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { aptApi } from '@/lib/apt/api'
import { agingColor, fmtDec1, fmtInt, fmtPct, fmtTn } from '@/lib/apt/format'
import { exportAptXlsx } from '@/lib/apt/export'
import { loteHref, useAptFilters } from '@/lib/apt/useAptFilters'
import type { AptDim, AptHeatmap } from '@/lib/apt/types'
import { ChartCard, EmptyState, ErrorBlock, InlineBar, LoadingBlock } from '@/components/apt/ui'
import { ExportButton, Segmented, TooltipBox, useAsyncData } from '@/components/apt/PphShared'

// Mapa de calor: TN de saldo por elemento (filas) y rango de aging (columnas).
// El tono indica la antigüedad del rango (verde reciente → rojo antiguo) y la intensidad, las TN (escala logarítmica).

type Row = AptHeatmap['rows'][number]
const DIMS: Array<{ value: AptDim; label: string }> = [
  { value: 'lote', label: 'NumRel' },
  { value: 'producto', label: 'Producto' },
  { value: 'familia', label: 'Familia' },
  { value: 'glosa', label: 'Glosa' },
]
const TOPS = [15, 25, 50, 100].map(n => ({ value: n, label: String(n) }))

// Escala: la intensidad crece con log(1 + 4·TN) para distinguir 0,1 TN de 2 TN sin que 40 TN aplaste todo lo demás
const intensity = (tn: number, max: number) => (tn <= 0.0005 || max <= 0 ? 0 : 0.12 + 0.88 * Math.min(1, Math.log1p(4 * tn) / Math.log1p(4 * max)))

function hexRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function cellStyle(color: string, a: number) {
  if (a <= 0) return { background: 'transparent', color: '#cbd5e1' }
  const [r, g, b] = hexRgb(color).map(c => Math.round(255 * (1 - a) + c * a))
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return { background: `rgb(${r}, ${g}, ${b})`, color: lum < 0.55 ? '#ffffff' : '#0f172a' }
}

export default function AptHeatmapPage() {
  const router = useRouter()
  const { filters, patchFilters, filterKey } = useAptFilters()
  const [dim, setDim] = useState<AptDim>('lote')
  const [top, setTop] = useState(25)
  const [hover, setHover] = useState<{ x: number; y: number; row: Row; i: number } | null>(null)
  const q = useAsyncData(`heat|${dim}|${top}|${filterKey}`, () => aptApi.heatmap(filters, dim, top))
  const d = q.data

  const m = useMemo(() => {
    if (!d) return null
    const n = d.rangos.length
    const colTot = d.rangos.map((_, i) => d.rows.reduce((s, r) => s + (r.celdas[i]?.tn || 0), 0))
    const tn = d.rows.reduce((s, r) => s + r.tn, 0)
    const txd = d.rows.reduce((s, r) => s + r.tn_dias, 0)
    const maxCell = Math.max(0, ...d.rows.flatMap(r => r.celdas.map(c => c.tn)))
    const maxRow = Math.max(0, ...d.rows.map(r => r.tn))
    const colors = d.rangos.map((_, i) => agingColor(i, n))
    return { colTot, tn, txd, maxCell, maxRow, colors }
  }, [d])

  const open = (r: Row) => {
    if (dim === 'lote') { router.push(loteHref(r.clave, filters)); return }
    patchFilters(dim === 'producto' ? { producto: r.clave } : dim === 'glosa' ? { glosa: r.clave } : { familias: [r.clave] })
    toast.success(`Filtro aplicado: ${r.clave}`)
  }

  const exportar = () => {
    if (!d) return
    const label = DIMS.find(x => x.value === dim)!.label
    exportAptXlsx(`APT_Mapa_calor_${label}`, {
      'Mapa de calor': d.rows.map(r => ({
        [label]: r.clave, ...(dim === 'lote' || dim === 'producto' ? { 'Glosa principal': r.etiqueta } : {}),
        ...Object.fromEntries(d.rangos.map((rg, i) => [rg, r.celdas[i]?.tn ?? 0])),
        'Total TN': r.tn, 'TN×Días': r.tn_dias, 'Aging ponderado (d)': r.tn > 0 ? Math.round((10 * r.tn_dias) / r.tn) / 10 : null,
      })),
    })
  }

  const showSub = dim === 'lote' || dim === 'producto'
  const hv = hover && d ? { r: hover.row, c: hover.row.celdas[hover.i], rango: d.rangos[hover.i] } : null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Segmented label="Filas" value={dim} options={DIMS} onChange={setDim} />
        <Segmented label="Top" value={top} options={TOPS} onChange={setTop} />
      </div>

      {q.error && !d ? <ErrorBlock message={q.error} onRetry={q.reload} /> : !d || !m ? <LoadingBlock /> : d.rows.length === 0 ? (
        <EmptyState title="Aún no hay movimientos: cargue ENTRADA y SALIDA">No hay saldo en APT para los filtros seleccionados.</EmptyState>
      ) : (
        <ChartCard title={`Saldo en APT por ${DIMS.find(x => x.value === dim)!.label.toLowerCase()} y rango de aging`}
          subtitle={`Top ${fmtInt(d.rows.length)} por TN de saldo · ${fmtTn(m.tn)} TN · ${fmtInt(m.txd)} TN×Días · clic en una fila para ${dim === 'lote' ? 'abrir la ficha del lote' : 'filtrar el módulo'}`}
          info="Cada celda es el saldo (TN) de ese elemento cuyo ingreso cae en el rango de días. Una concentración de color a la derecha indica inventario antiguo que conviene liberar primero."
          actions={<ExportButton onClick={exportar} />} bodyClassName="p-0">
          <div className={`transition-opacity ${q.loading ? 'opacity-60' : ''}`}>
            <div className="max-h-[680px] overflow-auto" onMouseLeave={() => setHover(null)}>
              <table className="w-full min-w-[960px] border-separate border-spacing-0 text-xs">
                <thead>
                  <tr>
                    <th className="sticky left-0 top-0 z-30 min-w-[220px] border-b border-slate-200 bg-slate-50 px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">
                      {DIMS.find(x => x.value === dim)!.label}
                    </th>
                    {d.rangos.map((rg, i) => (
                      <th key={rg} className="sticky top-0 z-20 border-b border-slate-200 bg-slate-50 px-1 py-2 text-center text-[11px] font-bold text-slate-600">
                        <span className="mx-auto mb-1 block h-1 w-10 rounded-full" style={{ background: m.colors[i] }} />
                        <span className="whitespace-nowrap">{rg}</span>
                      </th>
                    ))}
                    <th className="sticky top-0 z-20 border-b border-l border-slate-200 bg-slate-50 px-3 py-2 text-right text-[11px] font-bold uppercase tracking-wide text-slate-500">Total TN</th>
                    <th className="sticky top-0 z-20 border-b border-slate-200 bg-slate-50 px-3 py-2 text-right text-[11px] font-bold uppercase tracking-wide text-slate-500">TN×Días</th>
                    <th className="sticky top-0 z-20 border-b border-slate-200 bg-slate-50 px-3 py-2 text-right text-[11px] font-bold uppercase tracking-wide text-slate-500" title="Σ(TN×días)/Σ TN">Aging pond.</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map(r => (
                    <tr key={r.clave} onClick={() => open(r)} className="group cursor-pointer">
                      <td className="sticky left-0 z-10 max-w-[260px] border-b border-slate-100 bg-white px-3 py-1.5 group-hover:bg-slate-50">
                        <p className="truncate font-semibold text-[#002855]" title={r.clave}>{r.clave}</p>
                        {showSub && r.etiqueta && <p className="truncate text-[10px] text-slate-400" title={r.etiqueta}>{r.etiqueta}</p>}
                      </td>
                      {r.celdas.map((c, i) => {
                        const st = cellStyle(m.colors[i], intensity(c.tn, m.maxCell))
                        return (
                          <td key={i} className="border-b border-r border-white p-0" style={{ background: st.background }}
                            onMouseMove={e => setHover({ x: e.clientX, y: e.clientY, row: r, i })}>
                            <div className="flex h-9 min-w-[64px] items-center justify-center px-1 font-semibold tabular-nums" style={{ color: st.color }}>
                              {c.tn > 0.0005 ? (c.tn < 0.01 ? '<0,01' : fmtTn(c.tn)) : '·'}
                            </div>
                          </td>
                        )
                      })}
                      <td className="border-b border-l border-slate-100 px-3 py-1.5 text-right group-hover:bg-slate-50">
                        <p className="font-bold tabular-nums text-slate-900">{fmtTn(r.tn)}</p>
                        <InlineBar value={r.tn} max={m.maxRow} />
                      </td>
                      <td className="border-b border-slate-100 px-3 py-1.5 text-right tabular-nums text-slate-700 group-hover:bg-slate-50">{fmtInt(r.tn_dias)}</td>
                      <td className="border-b border-slate-100 px-3 py-1.5 text-right tabular-nums text-slate-700 group-hover:bg-slate-50">
                        {r.tn > 0 ? fmtDec1(r.tn_dias / r.tn) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-bold">
                    <td className="sticky bottom-0 left-0 z-20 border-t-2 border-slate-300 bg-slate-100 px-3 py-2 text-[11px] uppercase tracking-wide text-slate-600">Total top {fmtInt(d.rows.length)}</td>
                    {m.colTot.map((v, i) => (
                      <td key={i} className="sticky bottom-0 z-10 border-t-2 border-slate-300 bg-slate-100 px-1 py-2 text-center tabular-nums text-slate-800">
                        {fmtTn(v)}
                        <span className="block text-[10px] font-semibold text-slate-500">{fmtPct(m.tn > 0 ? (100 * v) / m.tn : null)}</span>
                      </td>
                    ))}
                    <td className="sticky bottom-0 z-10 border-l border-t-2 border-slate-300 bg-slate-100 px-3 py-2 text-right tabular-nums">{fmtTn(m.tn)}</td>
                    <td className="sticky bottom-0 z-10 border-t-2 border-slate-300 bg-slate-100 px-3 py-2 text-right tabular-nums">{fmtInt(m.txd)}</td>
                    <td className="sticky bottom-0 z-10 border-t-2 border-slate-300 bg-slate-100 px-3 py-2 text-right tabular-nums">{m.tn > 0 ? fmtDec1(m.txd / m.tn) : '—'}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="flex flex-wrap items-start justify-between gap-4 border-t border-slate-100 px-4 py-3 text-[11px] text-slate-500">
              <div className="space-y-1.5">
                <p className="font-bold uppercase tracking-wide text-slate-600">Cómo leerlo</p>
                <p className="max-w-xl">
                  Color = antigüedad del rango (verde reciente → rojo antiguo). Intensidad = TN de la celda (escala logarítmica).
                  La concentración de inventario antiguo aparece <span className="font-semibold text-red-700">a la derecha</span>: esas filas son las primeras a liberar.
                </p>
              </div>
              <div className="flex flex-wrap items-end gap-4">
                <div>
                  <p className="mb-1 font-semibold text-slate-600">Tono por rango</p>
                  <div className="flex">
                    {m.colors.map((c, i) => <span key={i} className="h-3 w-6 first:rounded-l last:rounded-r" style={{ background: c }} title={d.rangos[i]} />)}
                  </div>
                  <div className="flex justify-between text-[10px]"><span>{d.rangos[0]}</span><span>{d.rangos[d.rangos.length - 1]}</span></div>
                </div>
                <div>
                  <p className="mb-1 font-semibold text-slate-600">Intensidad por TN</p>
                  <div className="flex gap-0.5">
                    {[0.05, 0.5, 2, 10, m.maxCell].filter((v, i, a) => v <= m.maxCell && a.indexOf(v) === i).map(v => {
                      const st = cellStyle(m.colors[m.colors.length - 1], intensity(v, m.maxCell))
                      return (
                        <span key={v} className="flex h-6 min-w-[44px] items-center justify-center rounded px-1 text-[10px] font-semibold tabular-nums" style={st}>
                          {fmtTn(v)}
                        </span>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {hv && hover && (
            <div className="pointer-events-none fixed z-50" style={{ left: hover.x + 14, top: hover.y + 14 }}>
              <TooltipBox title={`${hv.r.clave} · ${hv.rango}`} subtitle={showSub ? hv.r.etiqueta : null} rows={[
                ['Saldo en el rango', `${fmtTn(hv.c?.tn)} TN`],
                ['% de la fila', fmtPct(hv.r.tn > 0 ? (100 * (hv.c?.tn || 0)) / hv.r.tn : null)],
                ['Total de la fila', `${fmtTn(hv.r.tn)} TN`],
              ]} />
            </div>
          )}
        </ChartCard>
      )}
    </div>
  )
}
