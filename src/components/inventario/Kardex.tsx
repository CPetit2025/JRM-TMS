'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Download } from 'lucide-react'
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartCard, ErrorBlock, KpiCard, LoadingBlock } from '@/components/apt/ui'
import { Table, td, tdNum, th } from '@/components/inventario/parts'
import { AlmacenTag, ProductoCell } from '@/components/inventario/ambito'
import { useInvQuery } from '@/components/inventario/useInvQuery'
import { invApi } from '@/lib/inventario/api'
import { CLASE_LABEL, fmtN, fmtPeso, fmtQty } from '@/lib/inventario/format'
import type { InvContratoProducto } from '@/lib/inventario/types'
import { fmtDate } from '@/lib/apt/format'
import { exportAptXlsx } from '@/lib/apt/export'

const tick = { fontSize: 11, fill: '#64748b' }
const axisKg = (v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)} t` : String(Math.round(v)))
const PAGE = 200

// Kardex de una OT en el APT: lo que ingresó, lo que salió y el saldo acumulado (total en kg o de un ID en su unidad)
export function Kardex({ ot, productos, producto, onProducto }: {
  ot: string; productos: InvContratoProducto[]; producto: string; onProducto: (p: string) => void
}) {
  const r = useInvQuery(`kardex|${ot}|${producto}`, () => invApi.kardex(ot, producto || undefined))
  const [shown, setShown] = useState(PAGE)
  const d = r.data
  const sel = productos.find(p => p.producto === producto)
  const exportar = () => d && exportAptXlsx(`kardex-ot-${d.ot}${producto ? `-${producto}` : ''}`, { Kardex: d.movimientos.map(m => ({
    Fecha: m.fecha, Tipo: m.tipo, Documento: m.numero, Almacén: m.almacen, Bodega: m.bodega, ID: m.producto, Glosa: m.glosa ?? '', Lote: m.lote ?? '',
    'Cliente / proveedor': m.tercero ?? '', Unidad: m.unidad ?? '', Entrada: m.entrada ?? '', Salida: m.salida ?? '', 'Kg entrada': m.kg_entrada ?? '',
    'Kg salida': m.kg_salida ?? '', 'Traspaso interno': m.interno ? 'Sí' : '', ...(producto ? { 'Saldo (cantidad)': m.saldo_qty } : {}), 'Saldo kg': m.saldo_kg,
  })) })
  return (
    <ChartCard title="Kardex de la OT" subtitle="Ingresos, salidas y saldo acumulado en el APT · el traspaso 647 → ST de la misma OT es interno y no cambia el saldo"
      actions={<div className="flex flex-wrap items-center gap-2">
        <select aria-label="ID" value={producto} onChange={e => { setShown(PAGE); onProducto(e.target.value) }} className="min-h-9 max-w-72 rounded-lg border border-slate-300 px-2 text-xs">
          <option value="">Todos los IDs (saldo en kg)</option>
          {productos.map(p => <option key={p.producto} value={p.producto}>{p.producto} · {p.glosa ?? ''}</option>)}
        </select>
        <button type="button" onClick={exportar} disabled={!d?.movimientos.length} className="flex min-h-9 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-[#002855] disabled:opacity-50"><Download className="h-4 w-4" /> Excel</button>
      </div>}>
      {r.loading ? <LoadingBlock label="Cargando el kardex…" className="h-48" /> : r.error ? <ErrorBlock message={r.error} onRetry={r.reload} /> : d && <div className="space-y-4">
        {sel && <p className="text-xs text-slate-600"><span className="font-mono">{sel.producto}</span> · {sel.glosa} · stock FIFO actual {fmtQty(sel.stock)} {sel.unidad ?? ''}</p>}
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <KpiCard label="Ingresó" tone="navy" value={producto && d.totales.ingreso_qty !== null ? `${fmtQty(d.totales.ingreso_qty)} ${sel?.unidad ?? ''}` : fmtPeso(d.totales.ingreso_kg)}
            hint={producto ? fmtPeso(d.totales.ingreso_kg) : 'Producción, compras y asignaciones a la OT'} />
          <KpiCard label="Salió" value={producto && d.totales.salida_qty !== null ? `${fmtQty(d.totales.salida_qty)} ${sel?.unidad ?? ''}` : fmtPeso(d.totales.salida_kg)}
            hint={producto ? fmtPeso(d.totales.salida_kg) : 'Despachos y otras salidas del APT'} />
          <KpiCard label="Saldo" tone="warn" value={producto && d.totales.ingreso_qty !== null ? `${fmtQty((d.totales.ingreso_qty ?? 0) - (d.totales.salida_qty ?? 0))} ${sel?.unidad ?? ''}` : fmtPeso(d.totales.ingreso_kg - d.totales.salida_kg)}
            hint="Ingresó − salió según los movimientos cargados" />
          <KpiCard label="Movimientos" value={fmtN(d.lineas)} hint={`${fmtN(d.totales.internos)} traspasos internos 647 → ST · corte ${fmtDate(d.corte)}`} />
        </div>
        {d.serie.length > 1 && <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={d.serie} margin={{ left: 0, right: 8 }}>
            <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="fecha" tick={tick} tickFormatter={v => fmtDate(String(v)).slice(0, 5)} minTickGap={16} />
            <YAxis tick={tick} tickFormatter={axisKg} width={48} />
            <Tooltip labelFormatter={v => fmtDate(String(v))} formatter={(v, n) => [fmtPeso(Number(v)), String(n)]} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="ingreso_kg" name="Ingresó" fill="#ea580c" radius={[3, 3, 0, 0]} />
            <Bar dataKey="salida_kg" name="Salió" fill="#0d9488" radius={[3, 3, 0, 0]} />
            <Line dataKey="saldo_kg" name="Saldo" stroke="#002855" strokeWidth={2} dot={false} type="stepAfter" />
          </ComposedChart>
        </ResponsiveContainer>}
        <Table empty={!d.movimientos.length} head={<tr><th className={th}>Fecha</th><th className={th}>Documento</th><th className={th}>Almacén</th>{!producto && <th className={th}>ID / glosa</th>}
          <th className={th}>Lote</th><th className={th}>Cliente / proveedor</th><th className={`${th} text-right`}>Entrada</th><th className={`${th} text-right`}>Salida</th><th className={`${th} text-right`}>Saldo</th></tr>}>
          {d.movimientos.slice(0, shown).map((m, i) => <tr key={i} className={m.interno ? 'bg-slate-50 text-slate-400' : 'hover:bg-slate-50'}>
            <td className={td}>{fmtDate(m.fecha)}</td>
            <td className={td}><Link href={`/apt/trazabilidad?q=${encodeURIComponent(m.numero)}`} className="font-semibold text-[#002855] underline">{m.numero}</Link>
              <p className="text-[10px] text-slate-500">{CLASE_LABEL[m.clase] ?? m.clase}{m.interno ? ' · interno' : ''}</p></td>
            <td className={td}><AlmacenTag almacen={m.almacen} /></td>
            {!producto && <td className={td}><button type="button" onClick={() => { setShown(PAGE); onProducto(m.producto) }} className="text-left"><ProductoCell producto={m.producto} glosa={m.glosa} /></button></td>}
            <td className={td}>{m.lote ?? '—'}</td>
            <td className={td}><p className="max-w-48 truncate" title={m.tercero ?? ''}>{m.tercero ?? '—'}</p></td>
            <td className={tdNum}>{m.entrada !== null ? <>{fmtQty(m.entrada)}<p className="text-[10px] text-slate-500">{fmtPeso(m.kg_entrada)}</p></> : ''}</td>
            <td className={tdNum}>{m.salida !== null ? <>{fmtQty(m.salida)}<p className="text-[10px] text-slate-500">{fmtPeso(m.kg_salida)}</p></> : ''}</td>
            <td className={`${tdNum} font-semibold`}>{producto ? `${fmtQty(m.saldo_qty)} ${m.unidad ?? ''}` : fmtPeso(m.saldo_kg)}</td>
          </tr>)}
        </Table>
        {(d.movimientos.length > shown || d.truncado) && <div className="flex items-center justify-end gap-3 text-xs text-slate-500">
          {d.truncado && <span>Se muestran los 3.000 movimientos más recientes; el Excel incluye los mismos.</span>}
          {d.movimientos.length > shown && <button type="button" onClick={() => setShown(s => s + PAGE)} className="min-h-9 rounded-lg border border-slate-300 px-3 font-semibold text-[#002855]">Ver {fmtN(Math.min(PAGE, d.movimientos.length - shown))} más</button>}
        </div>}
      </div>}
    </ChartCard>
  )
}
