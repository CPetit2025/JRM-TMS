'use client'
import { DataTable } from '@/components/ui/data-table'

import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { ChevronLeft, ChevronRight, ExternalLink, Filter } from 'lucide-react'
import { aptApi } from '@/lib/apt/api'
import { APT_COLORS, agingColor, diasTone, fmtDec1, fmtDias, fmtInt, fmtTn } from '@/lib/apt/format'
import { exportAptXlsx } from '@/lib/apt/export'
import { useAptFilters } from '@/lib/apt/useAptFilters'
import type { AptFilters, AptGroupRow } from '@/lib/apt/types'
import { ChartCard, DiasBadge, EmptyState, ErrorBlock, EstadoBadge, InlineBar, KpiCard, LoadingBlock } from '@/components/apt/ui'
import { ExportButton, RankBars, Segmented, SortTh, useAsyncData, type RankItem } from '@/components/apt/PphShared'

// Productos y glosas: rankings de volumen, TN×Días y permanencia, y tabla completa por producto, glosa o familia.
// Un clic en un elemento filtra todo el módulo por él.

type Vista = 'producto' | 'glosa' | 'familia'
const VISTAS: Array<{ value: Vista; label: string }> = [
  { value: 'producto', label: 'Producto' },
  { value: 'glosa', label: 'Glosa' },
  { value: 'familia', label: 'Familia' },
]
const NOMBRE: Record<Vista, { uno: string; varios: string }> = {
  producto: { uno: 'producto', varios: 'productos' },
  glosa: { uno: 'glosa', varios: 'glosas' },
  familia: { uno: 'familia', varios: 'familias' },
}
const PAGE = 50
const RANK_N = 10
const TONE_TEXT = { ok: 'text-emerald-700', warn: 'text-amber-700', crit: 'text-red-700', none: 'text-slate-400' } as const

const filtroDe = (vista: Vista, clave: string): Partial<AptFilters> =>
  vista === 'producto' ? { productos: [clave] } : vista === 'glosa' ? { glosas: [clave] } : { familias: [clave] }

export default function AptProductosPage() {
  const { filters, patchFilters, hrefWith, filterKey } = useAptFilters()
  const [vista, setVista] = useState<Vista>('producto')
  const [sort, setSort] = useState('tn_dias')
  const [desc, setDesc] = useState(true)
  const [page, setPage] = useState(0)
  const [exporting, setExporting] = useState(false)

  const settings = useAsyncData('settings', () => aptApi.settings())
  const alert = settings.data?.settings.alert_days ?? 60
  const nRangos = settings.data?.ranges.length ?? 8

  // Rankings (solo elementos con saldo, salvo el conteo de registros de glosa)
  const ranks = useAsyncData(`rank|${vista}|${filterKey}`, async () => {
    const conSaldo = { ...filters, solo_saldo: true }
    const [tn, txd, dias, capas] = await Promise.all([
      aptApi.detail<AptGroupRow>(conSaldo, vista, 'kg_saldo', true, RANK_N),
      aptApi.detail<AptGroupRow>(conSaldo, vista, 'tn_dias', true, RANK_N),
      aptApi.detail<AptGroupRow>(conSaldo, vista, 'dias', true, RANK_N),
      vista === 'glosa' ? aptApi.detail<AptGroupRow>(filters, vista, 'capas', true, RANK_N) : Promise.resolve(null),
    ])
    return { tn: tn.rows, txd: txd.rows, dias: dias.rows, capas: capas?.rows ?? null, conSaldo: tn.total }
  })

  const table = useAsyncData(`tab|${vista}|${sort}|${desc}|${page}|${filterKey}`,
    () => aptApi.detail<AptGroupRow>(filters, vista, sort, desc, PAGE, page * PAGE))

  const cambiarVista = (v: Vista) => { setVista(v); setPage(0) }
  const onSort = (k: string) => {
    if (k === sort) setDesc(d => !d)
    else { setSort(k); setDesc(!['clave', 'etiqueta', 'estado'].includes(k)) }
    setPage(0)
  }
  const select = (clave: string) => {
    patchFilters(filtroDe(vista, clave))
    toast.success(`Filtro aplicado: ${NOMBRE[vista].uno} ${clave}`)
  }

  const toItem = (r: AptGroupRow, value: number, extra: Array<[string, string]> = [], color?: string): RankItem => ({
    key: r.clave,
    label: r.clave,
    sub: vista === 'producto' ? r.etiqueta : null,
    value,
    color,
    extra,
  })
  const rk = ranks.data
  const rankTn = (rk?.tn || []).map(r => toItem(r, r.tn_saldo, [['N° NumRel', fmtInt(r.lotes)], ['Aging pond.', `${fmtDec1(r.aging_pond)} d`]]))
  const rankTxd = (rk?.txd || []).map(r => toItem(r, r.tn_dias, [['Saldo', `${fmtTn(r.tn_saldo)} TN`], ['Aging pond.', `${fmtDec1(r.aging_pond)} d`]]))
  const rankDias = (rk?.dias || []).map(r => toItem(r, r.dias ?? 0, [['Saldo', `${fmtTn(r.tn_saldo)} TN`], ['Rango', r.rango || '—']],
    agingColor(rangoIndex(r.rango_orden, settings.data?.ranges), nRangos)))
  const rankCapas = (rk?.capas || []).map(r => toItem(r, r.capas, [['TN ingresadas', fmtTn(r.tn_in)], ['Saldo', `${fmtTn(r.tn_saldo)} TN`]], APT_COLORS.slate))

  const exportar = async () => {
    setExporting(true)
    try {
      const all = await aptApi.detail<AptGroupRow>(filters, vista, sort, desc, 20000)
      exportAptXlsx(`APT_${NOMBRE[vista].varios}`, {
        [NOMBRE[vista].varios]: all.rows.map(r => ({
          [vista === 'producto' ? 'Producto' : vista === 'glosa' ? 'Glosa' : 'Familia']: r.clave,
          ...(vista === 'producto' ? { Glosa: r.etiqueta } : { Productos: r.productos }),
          'N° NumRel': r.lotes, Capas: r.capas,
          'TN ingresadas': r.tn_in, 'TN despachadas': r.tn_out, 'Saldo TN': r.tn_saldo, '% despachado': r.pct_despachado,
          'Primer ingreso': r.primer_ingreso, 'Último ingreso': r.ultimo_ingreso, 'Última salida': r.ultima_salida,
          'Fecha saldo más antiguo': r.fecha_saldo, 'Días (saldo más antiguo)': r.dias, 'Días máx.': r.dias_max,
          'Aging ponderado (d)': r.aging_pond, 'Días despacho pond.': r.dias_despacho_pond, 'TN×Días': r.tn_dias,
          Rango: r.rango, Estado: r.estado, 'Capas con problema': r.capas_problema,
        })),
      })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo exportar')
    } finally {
      setExporting(false)
    }
  }

  const t = table.data
  const rows = t?.rows || []
  const maxSaldo = Math.max(0, ...rows.map(r => r.tn_saldo))
  const maxTxd = Math.max(0, ...rows.map(r => r.tn_dias))
  const pages = t ? Math.max(1, Math.ceil(t.total / PAGE)) : 1
  const nom = NOMBRE[vista]
  const sinDatos = t && t.total === 0

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Ver por" value={vista} options={VISTAS} onChange={cambiarVista} />
        <p className="flex items-center gap-1.5 text-xs text-slate-500">
          <Filter className="h-3.5 w-3.5" /> Clic en una barra o fila para filtrar todo el módulo por ese {nom.uno}.
        </p>
      </div>

      {table.error && !t ? <ErrorBlock message={table.error} onRetry={table.reload} /> : sinDatos ? (
        <EmptyState title="Aún no hay movimientos: cargue ENTRADA y SALIDA">No hay {nom.varios} para los filtros seleccionados.</EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard label={`${nom.varios} en la vista`} value={fmtInt(t?.total)} hint={rk ? `${fmtInt(rk.conSaldo)} con saldo en APT` : ' '} tone="navy" />
            <KpiCard label="TN ingresadas" value={fmtTn(t?.totals.tn_in)} unit="TN" hint={`${fmtTn(t?.totals.tn_out)} TN despachadas`} />
            <KpiCard label="Saldo en APT" value={fmtTn(t?.totals.tn_saldo)} unit="TN" tone="navy" />
            <KpiCard label="TN×Días" value={fmtInt(t?.totals.tn_dias)} hint={t && t.totals.tn_saldo > 0
              ? `Aging ponderado ${fmtDec1(t.totals.tn_dias / t.totals.tn_saldo)} días` : 'Sin saldo'} tone="warn" />
          </div>

          <div className={`grid gap-4 ${vista === 'glosa' ? 'md:grid-cols-2 2xl:grid-cols-4' : 'lg:grid-cols-3'}`}>
            <ChartCard title={`Top ${RANK_N} por TN almacenadas`} subtitle="Saldo actual en APT" info="Toneladas que siguen en el almacén a la fecha de corte.">
              {ranks.loading && !rk ? <LoadingBlock className="h-72" /> : ranks.error ? <ErrorBlock message={ranks.error} onRetry={ranks.reload} />
                : <RankBars items={rankTn} format={v => `${fmtTn(v)} TN`} color={APT_COLORS.navy} onSelect={select} />}
            </ChartCard>
            <ChartCard title={`Top ${RANK_N} por TN×Días`} subtitle="Volumen × tiempo inmovilizado"
              info="TN×Días = saldo TN × días del saldo. Prioriza lo que más pesa y más tiempo lleva en APT.">
              {ranks.loading && !rk ? <LoadingBlock className="h-72" /> : ranks.error ? null
                : <RankBars items={rankTxd} format={v => fmtInt(v)} color={APT_COLORS.orange} onSelect={select} />}
            </ChartCard>
            <ChartCard title={`Top ${RANK_N} de mayor permanencia`} subtitle="Días del saldo más antiguo (solo con saldo)"
              info="Días entre el ingreso de la capa más antigua que aún tiene saldo y la fecha de corte. Color según el rango de aging.">
              {ranks.loading && !rk ? <LoadingBlock className="h-72" /> : ranks.error ? null
                : <RankBars items={rankDias} format={v => `${fmtDias(v)} d`} onSelect={select} />}
            </ChartCard>
            {vista === 'glosa' && (
              <ChartCard title={`Top ${RANK_N} glosas con más registros`} subtitle="N° de capas (filas de ENTRADA)"
                info="Glosas con más ingresos registrados: indican alta rotación o fraccionamiento de los lotes.">
                {ranks.loading && !rk ? <LoadingBlock className="h-72" /> : ranks.error ? null
                  : <RankBars items={rankCapas} format={v => fmtInt(v)} onSelect={select} />}
              </ChartCard>
            )}
          </div>

          <ChartCard title={`Detalle por ${nom.uno}`}
            subtitle={t ? `${fmtInt(t.total)} ${nom.varios} · ordenado en el servidor · ${PAGE} por página` : undefined}
            actions={<ExportButton onClick={exportar} busy={exporting} disabled={!t?.total} />} bodyClassName="p-0">
            {!t ? <LoadingBlock /> : (
              <div className={`relative transition-opacity ${table.loading ? 'opacity-60' : ''}`}>
                <div className="max-h-[640px] overflow-auto">
                  <DataTable className="w-full min-w-[1100px] text-sm">
                    <thead>
                      <tr>
                        <SortTh label={vista === 'producto' ? 'Producto / glosa' : vista === 'glosa' ? 'Glosa' : 'Familia'} k="clave" sort={sort} desc={desc} onSort={onSort} align="left" />
                        <SortTh label="N° NumRel" k="lotes" sort={sort} desc={desc} onSort={onSort} title="Lotes (NumRel padre) distintos" />
                        <SortTh label="Capas" k="capas" sort={sort} desc={desc} onSort={onSort} title="Filas de ENTRADA" />
                        <SortTh label="TN ingresadas" k="kg_in" sort={sort} desc={desc} onSort={onSort} />
                        <SortTh label="Saldo TN" k="kg_saldo" sort={sort} desc={desc} onSort={onSort} className="min-w-[140px]" />
                        <SortTh label="Días saldo" k="dias" sort={sort} desc={desc} onSort={onSort} align="center" title="Días del saldo más antiguo (o de permanencia si ya salió todo)" />
                        <SortTh label="Días máx." k="dias_max" sort={sort} desc={desc} onSort={onSort} title="Máximo de días entre sus capas" />
                        <SortTh label="Aging pond." k="aging_pond" sort={sort} desc={desc} onSort={onSort} title="Σ(TN×días)/Σ TN del saldo" />
                        <SortTh label="Días desp." k="dias_despacho_pond" sort={sort} desc={desc} onSort={onSort} title="Días promedio ponderado de lo despachado" />
                        <SortTh label="TN×Días" k="tn_dias" sort={sort} desc={desc} onSort={onSort} className="min-w-[130px]" />
                        <SortTh label="Estado" k="estado" sort={sort} desc={desc} onSort={onSort} align="left" />
                        <th className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50 px-2" aria-label="Acciones" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {rows.map(r => (
                        <tr key={r.clave} onClick={() => select(r.clave)} className="cursor-pointer hover:bg-[#002855]/[0.03]">
                          <td className="max-w-[340px] px-3 py-2">
                            <p className="truncate font-semibold text-[#002855]" title={r.clave}>{r.clave}</p>
                            {vista === 'producto' && r.etiqueta && <p className="truncate text-[11px] text-slate-500" title={r.etiqueta}>{r.etiqueta}</p>}
                            {vista !== 'producto' && <p className="text-[11px] text-slate-400">{fmtInt(r.productos)} producto{r.productos === 1 ? '' : 's'}</p>}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmtInt(r.lotes)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-500">{fmtInt(r.capas)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmtTn(r.tn_in)}</td>
                          <td className="px-3 py-2 text-right">
                            <p className={`tabular-nums ${r.tn_saldo > 0.0005 ? 'font-semibold text-slate-900' : 'text-slate-400'}`}>{fmtTn(r.tn_saldo)}</p>
                            {r.tn_saldo > 0.0005 && <InlineBar value={r.tn_saldo} max={maxSaldo} />}
                          </td>
                          <td className="px-3 py-2 text-center"><DiasBadge dias={r.dias} alert={alert} /></td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtDias(r.dias_max)}</td>
                          <td className={`px-3 py-2 text-right font-semibold tabular-nums ${TONE_TEXT[diasTone(r.aging_pond, alert)]}`}>{fmtDec1(r.aging_pond)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-500">{fmtDec1(r.dias_despacho_pond)}</td>
                          <td className="px-3 py-2 text-right">
                            <p className="tabular-nums">{fmtInt(r.tn_dias)}</p>
                            {r.tn_dias > 0 && <InlineBar value={r.tn_dias} max={maxTxd} color={APT_COLORS.orange} />}
                          </td>
                          <td className="px-3 py-2"><EstadoBadge estado={r.estado} /></td>
                          <td className="px-2 py-2">
                            <Link href={hrefWith('/apt/detalle', filtroDe(vista, r.clave))} onClick={e => e.stopPropagation()}
                              aria-label={`Ver capas de ${r.clave} en Detalle APT`} title="Ver capas en Detalle APT"
                              className="inline-flex rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-[#002855]">
                              <ExternalLink className="h-3.5 w-3.5" />
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </DataTable>
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
                  <span>{t.total ? `${fmtInt(page * PAGE + 1)}–${fmtInt(Math.min((page + 1) * PAGE, t.total))} de ${fmtInt(t.total)}` : 'Sin filas'}</span>
                  <div className="flex items-center gap-1">
                    <button type="button" aria-label="Página anterior" disabled={page === 0} onClick={() => setPage(p => p - 1)}
                      className="rounded-md border border-slate-200 p-1 hover:bg-slate-50 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
                    <span className="px-2 tabular-nums">{page + 1} / {pages}</span>
                    <button type="button" aria-label="Página siguiente" disabled={page + 1 >= pages} onClick={() => setPage(p => p + 1)}
                      className="rounded-md border border-slate-200 p-1 hover:bg-slate-50 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
                  </div>
                </div>
              </div>
            )}
          </ChartCard>
        </>
      )}
    </div>
  )
}

// Posición del rango (por su "desde") dentro de los rangos configurados, para el color de antigüedad
function rangoIndex(desde: number | null, ranges?: Array<{ desde: number }>) {
  if (desde === null || !ranges?.length) return 0
  const i = [...ranges].sort((a, b) => a.desde - b.desde).findIndex(r => r.desde === desde)
  return i < 0 ? 0 : i
}
