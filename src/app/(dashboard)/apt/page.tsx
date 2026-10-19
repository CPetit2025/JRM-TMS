'use client'

import { useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Boxes, Factory, PackageCheck, Truck, Wrench } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartCard, EmptyState, ErrorBlock, KpiCard, LoadingBlock } from '@/components/apt/ui'
import { KindBadge, PeriodBar, Table, td, tdNum, th } from '@/components/inventario/parts'
import { useInvQuery } from '@/components/inventario/useInvQuery'
import { VerificationPanel } from '@/components/inventario/VerificationPanel'
import { ALMACEN_COLOR, ALMACEN_LABEL, setAmbito, useAmbito } from '@/components/inventario/ambito'
import { invApi } from '@/lib/inventario/api'
import { fmtN, fmtPeso, fmtQty } from '@/lib/inventario/format'
import { fmtDate } from '@/lib/apt/format'

const tick = { fontSize: 11, fill: '#64748b' }
const axisKg = (v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)} t` : String(Math.round(v)))

export default function InventarioResumenPage() {
  return useAmbito() === 'apt' ? <AptResumen /> : <PanoramaTodas />
}

const AGE = ['0-30', '31-60', '61-90', '>90', 'sin fecha'] as const
const AGE_LABEL: Record<(typeof AGE)[number], string> = { '0-30': '0–30 d', '31-60': '31–60 d', '61-90': '61–90 d', '>90': '> 90 d', 'sin fecha': 'Sin fecha' }
const AGE_COLOR: Record<(typeof AGE)[number], string> = { '0-30': '#10b981', '31-60': '#facc15', '61-90': '#f97316', '>90': '#dc2626', 'sin fecha': '#94a3b8' }

// Resumen del APT en sus tres almacenes (647 · 540 · ST): saldo, antigüedad, movimiento de 30 días y OT con más stock
function AptResumen() {
  const q = useInvQuery('apt_resumen', () => invApi.aptResumen())
  const ver = useInvQuery('verify', () => invApi.verify())
  const d = q.data
  if (q.loading) return <LoadingBlock label="Cargando el resumen del APT…" className="h-96" />
  if (q.error) return <ErrorBlock message={q.error} onRetry={q.reload} />
  if (!d || !d.corte) {
    return <EmptyState title="Aún no hay movimientos cargados">Suba los reportes de Entradas y Salidas del ERP en <Link href="/apt/datos" className="font-semibold text-[#002855] underline">Datos y verificación</Link>.</EmptyState>
  }
  const sum = (k: 'stock_kg' | 'kg_libre' | 'kg_comprometido' | 'ingresado_kg_30' | 'despachado_kg_30') => d.almacenes.reduce((t, a) => t + a[k], 0)
  const stock = sum('stock_kg')
  const dias = stock ? d.almacenes.reduce((t, a) => t + (a.dias_pond ?? 0) * a.stock_kg, 0) / stock : null
  const viejo = d.almacenes.reduce((t, a) => t + a.antiguedad['>90'], 0)
  const aging = d.almacenes.map(a => ({ name: ALMACEN_LABEL[a.almacen], ...a.antiguedad }))
  return (
    <div className="space-y-4">
      {ver.data && <VerificationPanel v={ver.data} />}
      {d.cache && !d.cache.al_dia && <p className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"><AlertTriangle className="h-4 w-4" /> Cifras del último recálculo: hay cargas pendientes de recalcular.</p>}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiCard label="Stock en el APT" value={fmtPeso(stock)} tone="navy" icon={<Boxes className="h-4 w-4" />} hint={`647 · 540 · ST al ${fmtDate(d.corte)}`} />
        <KpiCard label="Comprometido (con OT)" value={fmtPeso(sum('kg_comprometido'))} tone="warn" hint={`Libre: ${fmtPeso(sum('kg_libre'))}`} />
        <KpiCard label="Días en el APT (ponderado)" value={dias === null ? '—' : `${fmtN(dias)} d`} hint={`${fmtPeso(viejo)} con más de 90 días`} tone={viejo > 0 ? 'warn' : 'ok'} />
        <KpiCard label="Últimos 30 días" value={fmtPeso(sum('despachado_kg_30'))} icon={<Truck className="h-4 w-4" />} hint={`despachado · ingresó ${fmtPeso(sum('ingresado_kg_30'))}`} />
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {d.almacenes.map(a => <section key={a.almacen} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <header className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><span className="h-2.5 w-2.5 rounded-full" style={{ background: ALMACEN_COLOR[a.almacen] }} />{ALMACEN_LABEL[a.almacen]}</h3>
            <Link href={`/apt/stock?almacen=${a.almacen}`} className="text-xs font-semibold text-[#002855] underline">Ver stock</Link>
          </header>
          <p className="mt-2 text-2xl font-black tabular-nums text-[#002855]">{fmtPeso(a.stock_kg)}</p>
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <dt className="text-slate-500">Productos·lote</dt><dd className="text-right font-semibold tabular-nums">{fmtN(a.claves)}</dd>
            <dt className="text-slate-500">OT con stock</dt><dd className="text-right font-semibold tabular-nums">{fmtN(a.ots)}</dd>
            <dt className="text-slate-500">Días (ponderado)</dt><dd className="text-right font-semibold tabular-nums">{a.dias_pond === null ? '—' : `${fmtN(a.dias_pond)} d`}</dd>
            <dt className="text-slate-500">Ingresó 30 d</dt><dd className="text-right font-semibold tabular-nums">{fmtPeso(a.ingresado_kg_30)}</dd>
            <dt className="text-slate-500">Despachó 30 d</dt><dd className="text-right font-semibold tabular-nums">{fmtPeso(a.despachado_kg_30)}{a.guias_30 ? ` · ${fmtN(a.guias_30)} guías` : ''}</dd>
          </dl>
        </section>)}
      </div>
      <ChartCard title="Antigüedad del stock por almacén" subtitle="kg con saldo según días desde su ingreso al almacén">
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={aging} layout="vertical" margin={{ left: 8, right: 16 }}>
            <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" tick={tick} tickFormatter={axisKg} />
            <YAxis type="category" dataKey="name" tick={tick} width={170} />
            <Tooltip formatter={(v, n) => [fmtPeso(Number(v)), String(n)]} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {AGE.map((k, i) => <Bar key={k} dataKey={k} name={AGE_LABEL[k]} stackId="a" fill={AGE_COLOR[k]} radius={i === AGE.length - 1 ? [0, 4, 4, 0] : undefined} />)}
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
      <ChartCard title="OT con más stock en el APT" subtitle="Abra una OT para ver sus IDs, guías y lotes"
        actions={<Link href="/apt/contratos" className="text-xs font-semibold text-[#002855] underline">Todas las OT</Link>}>
        <Table empty={!d.top_ot.length} head={<tr><th className={th}>OT</th><th className={th}>Cliente</th><th className={`${th} text-right`}>Stock</th><th className={`${th} text-right`}>647</th><th className={`${th} text-right`}>540</th><th className={`${th} text-right`}>ST</th><th className={`${th} text-right`}>Avance</th><th className={`${th} text-right`}>Días</th><th className={th}>Entrega</th></tr>}>
          {d.top_ot.map(c => <tr key={c.ot} className="hover:bg-slate-50">
            <td className={td}><Link href={`/apt/contratos?ot=${encodeURIComponent(c.ot)}`} className="font-bold text-[#002855] underline">{c.ot}</Link></td>
            <td className={td}><p className="max-w-60 truncate" title={c.cliente ?? ''}>{c.cliente ?? '—'}</p></td>
            <td className={`${tdNum} font-semibold`}>{fmtPeso(c.stock_kg)}</td><td className={tdNum}>{c.stock_647_kg ? fmtPeso(c.stock_647_kg) : '—'}</td>
            <td className={tdNum}>{c.stock_540_kg ? fmtPeso(c.stock_540_kg) : '—'}</td><td className={tdNum}>{c.stock_st_kg ? fmtPeso(c.stock_st_kg) : '—'}</td>
            <td className={tdNum}>{c.avance_pct === null ? '—' : `${fmtN(c.avance_pct)} %`}</td><td className={tdNum}>{c.dias_stock === null ? '—' : `${fmtN(c.dias_stock)} d`}</td>
            <td className={td}>{fmtDate(c.fecha_entrega)}</td>
          </tr>)}
        </Table>
      </ChartCard>
      <p className="text-xs text-slate-500">Para producción, pernería, MRO y las demás bodegas use <button type="button" onClick={() => setAmbito('todas')} className="font-semibold text-[#002855] underline">Todas las bodegas</button>.</p>
    </div>
  )
}

// Panorama del inventario multi-almacén: dónde está el stock, qué se movió en el período y qué revisar
function PanoramaTodas() {
  const [period, setPeriod] = useState<{ desde: string; hasta: string }>({ desde: '', hasta: '' })
  const q = useInvQuery(`ov|${period.desde}|${period.hasta}`, () => invApi.overview(period.desde, period.hasta))
  const ver = useInvQuery('verify', () => invApi.verify())
  const d = q.data
  if (q.loading) return <LoadingBlock label="Calculando el panorama…" className="h-96" />
  if (q.error) return <ErrorBlock message={q.error} onRetry={q.reload} />
  if (!d || !d.state.data_max) {
    return <EmptyState title="Aún no hay movimientos cargados">Suba los reportes de Entradas y Salidas del ERP en <Link href="/apt/datos" className="font-semibold text-[#002855] underline">Cargas y catálogos</Link>.</EmptyState>
  }
  const kg = d.bodegas.reduce((t, b) => t + b.kg, 0)
  const libre = d.bodegas.reduce((t, b) => t + b.kg_libre, 0)
  const mov = (side: 'E' | 'S', clases: string[]) => d.movimientos.filter(m => m.side === side && clases.includes(m.clase)).reduce((t, m) => t + m.kg, 0)
  const bodegasChart = d.bodegas.filter(b => b.kg > 0).map(b => ({ name: b.bodega, libre: b.kg_libre, comprometido: b.kg_comprometido }))
  const cal = d.calidad
  return (
    <div className="space-y-4">
      <PeriodBar desde={period.desde || d.state.desde || ''} hasta={period.hasta || d.state.hasta || ''} onChange={(a, b) => setPeriod({ desde: a, hasta: b })}>
        <p className="text-xs text-slate-500">Stock al corte {fmtDate(d.state.data_max)} · movimientos del período seleccionado</p>
      </PeriodBar>
      {ver.data && <VerificationPanel v={ver.data} />}
      {d.state.dirty && <p className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"><AlertTriangle className="h-4 w-4" /> Hay cargas o cambios de catálogo sin recalcular: el stock y la estadía pueden estar desactualizados. Use «Recalcular».</p>}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiCard label="Stock con peso" value={fmtPeso(kg)} tone="navy" icon={<Boxes className="h-4 w-4" />} hint={`${fmtN(d.bodegas.reduce((t, b) => t + b.claves, 0))} productos·lote en ${d.bodegas.length} bodegas`} />
        <KpiCard label="Libre (sin contrato)" value={fmtPeso(libre)} tone="ok" hint="Disponible para asignar a una OT" />
        <KpiCard label="Comprometido (con OT)" value={fmtPeso(kg - libre)} tone="warn" hint="Asignado a un contrato o subcontrato" />
        <KpiCard label="Saldo inicial inferido" value={fmtN(cal.claves_inferidas)} unit="claves" tone={cal.claves_inferidas ? 'warn' : 'ok'} hint={d.state.snapshot_cutoff ? `Foto de stock al ${fmtDate(d.state.snapshot_cutoff)}` : 'Sin foto de stock: cargue una para conciliar'} />
      </div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiCard label="Producción" value={fmtPeso(mov('E', ['PRODUCCION']))} icon={<Factory className="h-4 w-4" />} hint="Partes de producción del período" />
        <KpiCard label="Compras y servicios" value={fmtPeso(mov('E', ['COMPRA', 'SERVICIO_TERCERO']))} icon={<PackageCheck className="h-4 w-4" />} hint="Ingresos de proveedores y terceros" />
        <KpiCard label="Despachos a clientes" value={fmtPeso(mov('S', ['DESPACHO']))} icon={<Truck className="h-4 w-4" />} hint="Guías de despacho de ventas" />
        <KpiCard label="Consumo interno" value={fmtPeso(mov('S', ['CONSUMO']))} icon={<Wrench className="h-4 w-4" />} hint="Vales de consumo (producción, MRO, activos)" />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ChartCard title="Stock por bodega" subtitle="kg con peso conocido · libre vs comprometido a una OT">
          {bodegasChart.length ? <ResponsiveContainer width="100%" height={Math.max(220, bodegasChart.length * 32)}>
            <BarChart data={bodegasChart} layout="vertical" margin={{ left: 8, right: 16 }}>
              <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" tick={tick} tickFormatter={axisKg} />
              <YAxis type="category" dataKey="name" tick={tick} width={150} />
              <Tooltip formatter={(v, n) => [fmtPeso(Number(v)), String(n)]} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="libre" name="Libre" stackId="a" fill="#0d9488" />
              <Bar dataKey="comprometido" name="Comprometido" stackId="a" fill="#002855" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer> : <p className="text-sm text-slate-400">Sin stock con peso.</p>}
        </ChartCard>
        <ChartCard title="Movimientos por día" subtitle="kg · ingresos (arriba) y salidas del período">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={d.serie} margin={{ left: 0, right: 8 }}>
              <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="fecha" tick={tick} tickFormatter={v => fmtDate(String(v)).slice(0, 5)} minTickGap={16} />
              <YAxis tick={tick} tickFormatter={axisKg} width={48} />
              <Tooltip labelFormatter={v => fmtDate(String(v))} formatter={(v, n) => [fmtPeso(Number(v)), String(n)]} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="produccion" name="Producción" stackId="in" fill="#ea580c" />
              <Bar dataKey="compras" name="Compras y servicios" stackId="in" fill="#7c3aed" />
              <Bar dataKey="despachos" name="Despachos" stackId="out" fill="#0d9488" />
              <Bar dataKey="consumos" name="Consumos" stackId="out" fill="#94a3b8" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
      <ChartCard title="Bodegas" subtitle="Saldo al corte · edad del material más antiguo desde su origen">
        <Table head={<tr><th className={th}>Bodega</th><th className={th}>Tipo</th><th className={`${th} text-right`}>Productos·lote</th><th className={`${th} text-right`}>Stock</th><th className={`${th} text-right`}>Libre</th><th className={`${th} text-right`}>Sin peso</th><th className={`${th} text-right`}>Saldo inferido</th><th className={`${th} text-right`}>Edad máx.</th><th className={th} /></tr>}>
          {d.bodegas.map(b => <tr key={b.bodega} className="hover:bg-slate-50">
            <td className={`${td} font-semibold text-slate-800`}>{b.bodega}</td><td className={td}><KindBadge kind={b.kind} /></td>
            <td className={tdNum}>{fmtN(b.claves)}</td><td className={tdNum}>{fmtPeso(b.kg)}</td><td className={tdNum}>{fmtPeso(b.kg_libre)}</td>
            <td className={tdNum}>{fmtN(b.claves_sin_peso)}</td><td className={tdNum}>{b.claves_inferidas ? <span className="text-amber-700">{fmtN(b.claves_inferidas)}</span> : '0'}</td>
            <td className={tdNum}>{b.edad_max === null ? '—' : `${fmtN(b.edad_max)} d`}</td>
            <td className={td}><Link href={`/apt/stock?bodega=${encodeURIComponent(b.bodega)}`} className="font-semibold text-[#002855] underline">Ver stock</Link></td>
          </tr>)}
        </Table>
      </ChartCard>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ChartCard title="Préstamos de herramientas pendientes" subtitle={`${fmtN(d.herramientas.pendientes)} líneas · ${fmtQty(d.herramientas.unidades_pendientes)} unidades por devolver`}
          info="Salidas de herramientas (SALIDA HERRAMIENTAS) menos las devoluciones que apuntan a esa salida (NumRel).">
          <Table empty={!d.herramientas.detalle.length} head={<tr><th className={th}>Salida</th><th className={th}>Fecha</th><th className={th}>Cliente / obra</th><th className={th}>Herramienta</th><th className={`${th} text-right`}>Pendiente</th></tr>}>
            {d.herramientas.detalle.slice(0, 15).map(h => <tr key={`${h.numero}|${h.producto}`}>
              <td className={td}>{h.numero}</td><td className={td}>{fmtDate(h.fecha)}</td><td className={td}>{h.cliente ?? '—'}</td>
              <td className={td}>{h.glosa ?? h.producto}</td><td className={tdNum}>{fmtQty(h.pendiente)} / {fmtQty(h.salida)}</td>
            </tr>)}
          </Table>
        </ChartCard>
        <ChartCard title="Material en servicio de terceros" subtitle={`${fmtN(d.terceros.guias)} guías · ${fmtN(d.terceros.sin_retorno)} sin retorno · enviado ${fmtPeso(d.terceros.kg_enviado)} · retornado ${fmtPeso(d.terceros.kg_retornado)}`}
          info="Guías de salida a servicio de terceros (GS SERV TERCEROS) y los ingresos que las referencian (PE SERV TERCEROS con RefNumero).">
          <Table empty={!d.terceros.detalle.length} head={<tr><th className={th}>Guía</th><th className={th}>Fecha</th><th className={th}>Proveedor</th><th className={th}>Lotes</th><th className={`${th} text-right`}>Enviado</th><th className={`${th} text-right`}>Retornado</th></tr>}>
            {d.terceros.detalle.slice(0, 15).map(t => <tr key={t.numero}>
              <td className={td}><Link href={`/apt/trazabilidad?q=${encodeURIComponent(t.numero)}`} className="text-[#002855] underline">{t.numero}</Link></td>
              <td className={td}>{fmtDate(t.fecha)}</td><td className={td}>{t.proveedor ?? '—'}</td><td className={td}>{t.lotes ?? '—'}</td>
              <td className={tdNum}>{fmtPeso(t.kg)}</td><td className={tdNum}>{t.kg_retorno ? fmtPeso(t.kg_retorno) : <span className="text-amber-700">Pendiente</span>}</td>
            </tr>)}
          </Table>
        </ChartCard>
      </div>
    </div>
  )
}
