'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartCard, ErrorBlock, KpiCard, LoadingBlock } from '@/components/apt/ui'
import { DiasPill, KindBadge, PeriodBar, Table, td, tdNum, th } from '@/components/inventario/parts'
import { useInvQuery } from '@/components/inventario/useInvQuery'
import { AlmacenTag, ProductoCell, aptAlmacen, useAmbito } from '@/components/inventario/ambito'
import { invApi } from '@/lib/inventario/api'
import { CLASE_LABEL, fmtDias, fmtN, fmtPeso, fmtQty } from '@/lib/inventario/format'
import type { InvDwell } from '@/lib/inventario/types'
import { fmtDate } from '@/lib/apt/format'

const tick = { fontSize: 11, fill: '#64748b' }
const OUT_RANGES = ['Mismo día', '1–3 d', '4–7 d', '8–15 d', '16–30 d', '> 30 d', 'Saldo inicial']
const OUT_COLORS = ['#10b981', '#34d399', '#a3e635', '#facc15', '#f97316', '#dc2626', '#94a3b8']
const STOCK_RANGES = ['0–7 d', '8–15 d', '16–30 d', '31–60 d', '61–90 d', '> 90 d', 'Saldo inicial']
const STOCK_COLORS = ['#10b981', '#a3e635', '#facc15', '#f97316', '#dc2626', '#7f1d1d', '#94a3b8']

function pivot(rows: Array<{ bodega: string; rango: string; consumos?: number; claves?: number }>, ranges: string[]) {
  const by = new Map<string, Record<string, number | string>>()
  for (const r of rows) {
    const o = by.get(r.bodega) ?? { bodega: r.bodega }
    o[r.rango] = (r.consumos ?? r.claves ?? 0)
    by.set(r.bodega, o)
  }
  return [...by.values()].map(o => { ranges.forEach(k => { if (!(k in o)) o[k] = 0 }); return o })
}

// Estadía: cuántos días pasa el material en cada bodega (FIFO) y desde su origen hasta que sale
export default function InventarioEstadiaPage() {
  const [period, setPeriod] = useState({ desde: '', hasta: '' })
  const [bodega, setBodega] = useState('')
  const apt = useAmbito() === 'apt'
  const sel = bodega && (!apt || aptAlmacen(bodega)) ? bodega : ''
  const q = useInvQuery(`dwell|${period.desde}|${period.hasta}|${sel}|${apt}`, () => invApi.dwell({ desde: period.desde || undefined, hasta: period.hasta || undefined, bodegas: sel ? [sel] : [], ...(apt ? { ambito: 'apt' as const } : {}) }))
  const d: InvDwell | null = q.data
  const salidas = useMemo(() => (d ? pivot(d.distribucion, OUT_RANGES) : []), [d])
  const stock = useMemo(() => (d ? pivot(d.antiguedad_stock, STOCK_RANGES) : []), [d])
  const total = d?.por_bodega.reduce((t, b) => t + b.consumos, 0) ?? 0
  const weighted = (k: 'prom_dias' | 'prom_origen') => {
    if (!d) return null
    const rows = d.por_bodega.filter(b => b[k] !== null)
    const n = rows.reduce((t, b) => t + b.consumos, 0)
    return n ? rows.reduce((t, b) => t + (b[k] ?? 0) * b.consumos, 0) / n : null
  }
  return (
    <div className="space-y-4">
      <PeriodBar desde={period.desde || d?.desde || ''} hasta={period.hasta || d?.hasta || ''} onChange={(a, b) => setPeriod({ desde: a, hasta: b })}>
        <label className="text-xs font-semibold text-slate-600">Bodega
          <select value={sel} onChange={e => setBodega(e.target.value)} className="mt-1 block min-h-10 max-w-64 rounded-lg border border-slate-300 px-2 text-sm">
            <option value="">Todas</option>{d?.por_bodega.map(b => <option key={b.bodega} value={b.bodega}>{b.bodega}</option>)}
            {sel && !d?.por_bodega.some(b => b.bodega === sel) && <option value={sel}>{sel}</option>}
          </select>
        </label>
        <p className="max-w-xl text-xs text-slate-500">Salidas del período (despachos, consumos y traspasos). Cada salida se cruza con los ingresos más antiguos de la misma bodega, producto y lote.</p>
      </PeriodBar>
      {q.loading ? <LoadingBlock label="Calculando la estadía…" /> : q.error ? <ErrorBlock message={q.error} onRetry={q.reload} /> : d && <>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <KpiCard label="Salidas analizadas" value={fmtN(total)} tone="navy" hint={`${fmtDate(d.desde)} – ${fmtDate(d.hasta)}`} />
          <KpiCard label="Estadía promedio en bodega" value={fmtDias(weighted('prom_dias'))} hint="Promedio por línea de salida, días desde que ingresó a esa bodega" />
          <KpiCard label="Desde el origen" value={fmtDias(weighted('prom_origen'))} hint="Desde la producción, compra o servicio de origen (siguiendo los traspasos)" />
          <KpiCard label="Modelo desde" value={d.model_from ? fmtDate(d.model_from) : 'Inicio de datos'} hint={d.model_from ? 'Día siguiente a la foto de stock' : 'Sin foto de stock: lo anterior es saldo inferido'} />
        </div>
        <ChartCard title="Estadía por bodega" subtitle="Días en la bodega de cada salida del período" info="p50: la mitad de las salidas estuvo menos que esto · p90: el 90 %. «Saldo inicial»: salió de un saldo anterior a los datos, sin fecha de ingreso conocida.">
          <Table empty={!d.por_bodega.length} head={<tr><th className={th}>Bodega</th><th className={th}>Tipo</th><th className={`${th} text-right`}>Salidas</th><th className={`${th} text-right`}>Peso</th><th className={th}>Promedio</th><th className={th}>Prom. por kg</th><th className={th}>p50</th><th className={th}>p90</th><th className={th}>Máx.</th><th className={`${th} text-right`}>Saldo inicial</th><th className={th}>Desde origen</th></tr>}>
            {d.por_bodega.map(b => <tr key={b.bodega} className="hover:bg-slate-50">
              <td className={`${td} font-semibold text-slate-800`}><button type="button" onClick={() => setBodega(b.bodega)} className="text-left underline decoration-dotted">{b.bodega}</button></td>
              <td className={td}>{apt ? <AlmacenTag almacen={aptAlmacen(b.bodega)} /> : <KindBadge kind={b.kind} />}</td><td className={tdNum}>{fmtN(b.consumos)}</td><td className={tdNum}>{fmtPeso(b.kg)}</td>
              <td className={td}><DiasPill dias={b.prom_dias} /></td><td className={td}><DiasPill dias={b.prom_dias_kg} /></td>
              <td className={td}><DiasPill dias={b.p50} /></td><td className={td}><DiasPill dias={b.p90} /></td><td className={td}><DiasPill dias={b.max} /></td>
              <td className={tdNum}>{b.pct_sin_fecha === null ? '—' : `${fmtN(b.pct_sin_fecha)} %`}</td><td className={td}><DiasPill dias={b.prom_origen} /></td>
            </tr>)}
          </Table>
        </ChartCard>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <ChartCard title="Salidas por días en bodega" subtitle="Número de líneas de salida por rango">
            <ResponsiveContainer width="100%" height={Math.max(240, salidas.length * 30)}>
              <BarChart data={salidas} layout="vertical" margin={{ left: 8, right: 16 }}>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" horizontal={false} /><XAxis type="number" tick={tick} />
                <YAxis type="category" dataKey="bodega" tick={tick} width={150} /><Tooltip /><Legend wrapperStyle={{ fontSize: 11 }} />
                {OUT_RANGES.map((r, i) => <Bar key={r} dataKey={r} stackId="a" fill={OUT_COLORS[i]} />)}
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title="Antigüedad del stock actual" subtitle="Productos·lote con saldo, por días desde su ingreso a la bodega">
            <ResponsiveContainer width="100%" height={Math.max(240, stock.length * 30)}>
              <BarChart data={stock} layout="vertical" margin={{ left: 8, right: 16 }}>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" horizontal={false} /><XAxis type="number" tick={tick} />
                <YAxis type="category" dataKey="bodega" tick={tick} width={150} /><Tooltip /><Legend wrapperStyle={{ fontSize: 11 }} />
                {STOCK_RANGES.map((r, i) => <Bar key={r} dataKey={r} stackId="a" fill={STOCK_COLORS[i]} />)}
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
        <ChartCard title="Tiempo por etapa del flujo" subtitle="Origen → última bodega → destino · solo salidas con origen conocido" info="Por ejemplo: producción en 647 → ST-VENTAS → despacho al cliente. «En bodega» es el tiempo en la última bodega; «desde origen», el total desde la producción o compra.">
          <Table empty={!d.etapas.length} head={<tr><th className={th}>Origen</th><th className={th}>Bodega de origen</th><th className={th}>Última bodega</th><th className={th}>Destino</th><th className={`${th} text-right`}>Salidas</th><th className={`${th} text-right`}>Peso</th><th className={th}>En bodega</th><th className={th}>Desde origen</th></tr>}>
            {d.etapas.map((e, i) => <tr key={i} className="hover:bg-slate-50">
              <td className={td}>{e.origen ? CLASE_LABEL[e.origen] ?? e.origen : '—'}</td><td className={td}>{e.origen_bodega ?? '—'}</td><td className={td}>{e.bodega}</td>
              <td className={td}>{CLASE_LABEL[e.destino] ?? e.destino}</td><td className={tdNum}>{fmtN(e.consumos)}</td><td className={tdNum}>{fmtPeso(e.kg)}</td>
              <td className={td}><DiasPill dias={e.prom_bodega} /></td><td className={td}><DiasPill dias={e.prom_origen} /></td>
            </tr>)}
          </Table>
        </ChartCard>
        <ChartCard title="Stock más antiguo" subtitle="Productos·lote con más días en su bodega (prioridad para liberar)">
          <Table empty={!d.mas_antiguos.length} head={<tr><th className={th}>Bodega</th><th className={th}>Producto</th><th className={th}>Lote</th><th className={`${th} text-right`}>Cantidad</th><th className={`${th} text-right`}>Peso</th><th className={th}>Ingreso</th><th className={th}>Días</th></tr>}>
            {d.mas_antiguos.map((o, i) => <tr key={i} className="hover:bg-slate-50">
              <td className={td}>{o.bodega}</td><td className={td}><ProductoCell producto={o.producto} glosa={o.glosa} /></td>
              <td className={td}>{o.lote ? <Link href={`/apt/trazabilidad?q=${encodeURIComponent(o.lote)}`} className="text-[#002855] underline">{o.lote}</Link> : '—'}</td>
              <td className={tdNum}>{fmtQty(o.qty)}</td><td className={tdNum}>{fmtPeso(o.kg)}</td><td className={td}>{fmtDate(o.fecha_ingreso)}</td><td className={td}><DiasPill dias={o.dias} /></td>
            </tr>)}
          </Table>
        </ChartCard>
      </>}
    </div>
  )
}
