'use client'
import { DataTable } from '@/components/ui/data-table'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useParams, useSearchParams } from 'next/navigation'
import {
  Area, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import {
  AlertTriangle, ArrowLeft, CheckCircle2, Download, ExternalLink, FileSearch, FileText, Info, X,
} from 'lucide-react'
import { aptApi } from '@/lib/apt/api'
import { exportAptXlsx } from '@/lib/apt/export'
import {
  APT_COLORS, CLASE_SALIDA_LABEL, fmtDate, fmtDias, fmtInt, fmtKg, fmtPct, fmtTn, TIPO_LABEL,
} from '@/lib/apt/format'
import type { AptLoteFicha } from '@/lib/apt/types'
import {
  ChartCard, DiasBadge, EmptyState, ErrorBlock, EstadoBadge, InlineBar, KpiCard, LoadingBlock, TipoBadge,
} from '@/components/apt/ui'

// Ficha del NumRel / lote: resumen, evolución, productos, capas FIFO, salidas y asignación capa → salida.
// Cada fila permite ver el movimiento original (archivo y n° de fila de la hoja cargada).

type Origen = { titulo: string; archivo: string; fila: number; hoja: 'ENTRADA' | 'SALIDA'; raw: Record<string, unknown> }
type LoadState = { key: string; data: AptLoteFicha | null; error: string | null }

const CLASE_TONE: Record<string, string> = {
  ASIGNADA: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  EXCEDE_INGRESO: 'bg-amber-50 text-amber-700 border-amber-200',
  OTRO_PRODUCTO_DEL_LOTE: 'bg-sky-50 text-sky-700 border-sky-200',
  LOTE_SIN_INGRESO: 'bg-orange-50 text-orange-700 border-orange-200',
  SIN_NUMREL: 'bg-slate-50 text-slate-600 border-slate-200',
}

const dayMs = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`).getTime()
const msDate = (t: number) => new Date(t).toISOString().slice(0, 10)
const r3 = (v: number) => Math.round(v * 1000) / 1000

export default function AptLotePage() {
  const params = useParams<{ lote: string }>()
  const searchParams = useSearchParams()
  const lote = useMemo(() => {
    const raw = Array.isArray(params.lote) ? params.lote[0] : params.lote || ''
    try { return decodeURIComponent(raw) } catch { return raw }
  }, [params.lote])
  const f = searchParams.get('f')
  const backHref = f ? `/apt?f=${encodeURIComponent(f)}` : '/apt'

  const [nonce, setNonce] = useState(0)
  const [alert, setAlert] = useState(60)
  const [state, setState] = useState<LoadState>({ key: '', data: null, error: null })
  const [producto, setProducto] = useState<string | null>(null)
  const [origen, setOrigen] = useState<Origen | null>(null)
  const reqKey = `${lote}|${nonce}`
  const loading = state.key !== reqKey

  useEffect(() => {
    aptApi.settings().then(s => setAlert(s.settings.alert_days || 60)).catch(() => undefined)
  }, [])

  useEffect(() => {
    let alive = true
    aptApi.lote(lote)
      .then(d => { if (alive) setState({ key: reqKey, data: d, error: null }) })
      .catch((e: Error) => { if (alive) setState({ key: reqKey, data: null, error: e.message }) })
    return () => { alive = false }
  }, [lote, reqKey])

  const data = state.key === reqKey ? state.data : null

  const back = (
    <Link href={backHref} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 shadow-sm hover:border-[#002855] hover:text-[#002855]">
      <ArrowLeft className="h-3.5 w-3.5" /> Volver al dashboard APT
    </Link>
  )

  if (loading) return <div className="space-y-4">{back}<div className="rounded-xl border border-slate-200 bg-white shadow-sm"><LoadingBlock label={`Cargando lote ${lote}…`} /></div></div>
  if (state.error || !data) {
    return <div className="space-y-4">{back}<ErrorBlock message={state.error || 'No se pudo cargar el lote'} onRetry={() => setNonce(n => n + 1)} /></div>
  }
  if (!data.capas.length && !data.salidas.length) {
    return (
      <div className="space-y-4">
        {back}
        <EmptyState title={`No hay movimientos para el lote ${data.lote}`}>
          Revise que el NumRel esté escrito igual que en las hojas ENTRADA / SALIDA (p. ej. 16034, 16034-S004).
        </EmptyState>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {back}
      <LoteView data={data} alert={alert} producto={producto} setProducto={setProducto} onOrigen={setOrigen} />
      {origen && <OrigenModal origen={origen} onClose={() => setOrigen(null)} />}
    </div>
  )
}

function LoteView({ data, alert, producto, setProducto, onOrigen }: {
  data: AptLoteFicha; alert: number; producto: string | null; setProducto: (p: string | null) => void; onOrigen: (o: Origen) => void
}) {
  const r = data.resumen
  const capasById = useMemo(() => new Map(data.capas.map(c => [c.id, c])), [data.capas])
  const salidasById = useMemo(() => new Map(data.salidas.map(s => [s.id, s])), [data.salidas])

  // Evolución: ingresos acumulados (capas) vs salidas asignadas acumuladas (FIFO) y saldo resultante
  const evolucion = useMemo(() => {
    const ev = new Map<string, { in: number; out: number }>()
    const add = (d: string, k: 'in' | 'out', kg: number) => {
      const key = d.slice(0, 10)
      const e = ev.get(key) || { in: 0, out: 0 }
      e[k] += Number(kg) || 0
      ev.set(key, e)
    }
    data.capas.forEach(c => add(c.fecha_ingreso, 'in', c.kg_in))
    data.asignaciones.forEach(a => add(a.fecha_salida, 'out', a.kg))
    const dates = [...ev.keys()].sort()
    if (data.cutoff && dates.length && data.cutoff > dates[dates.length - 1]) dates.push(data.cutoff.slice(0, 10))
    const acc = { in: 0, out: 0 }
    const out: Array<{ t: number; fecha: string; ingreso: number; salida: number; in_acum: number; out_acum: number; saldo: number }> = []
    for (const d of dates) {
      const e = ev.get(d) || { in: 0, out: 0 }
      acc.in += e.in
      acc.out += e.out
      out.push({ t: dayMs(d), fecha: d, ingreso: r3(e.in / 1000), salida: r3(e.out / 1000), in_acum: r3(acc.in / 1000), out_acum: r3(acc.out / 1000), saldo: r3((acc.in - acc.out) / 1000) })
    }
    return out
  }, [data.capas, data.asignaciones, data.cutoff])

  const capas = producto ? data.capas.filter(c => c.producto === producto) : data.capas
  const salidas = producto ? data.salidas.filter(s => s.producto === producto) : data.salidas
  const asignaciones = useMemo(() => {
    const all = data.asignaciones.map(a => ({ ...a, c: capasById.get(a.capa), s: salidasById.get(a.salida) }))
    return producto ? all.filter(a => a.c?.producto === producto) : all
  }, [data.asignaciones, capasById, salidasById, producto])

  const sum = <T,>(rows: T[], fn: (x: T) => number) => rows.reduce((acc, x) => acc + (Number(fn(x)) || 0), 0)
  const cuadre = {
    capasOut: sum(capas, c => c.kg_out),
    asignado: sum(asignaciones, a => a.kg),
    salidasAsig: sum(salidas, s => s.kg_asignado),
    sinEntrada: sum(salidas, s => s.kg_sin_entrada),
    salidasKg: sum(salidas, s => s.kg),
  }
  const cuadraOk = Math.abs(cuadre.capasOut - cuadre.asignado) < 1 && Math.abs(cuadre.salidasAsig - cuadre.asignado) < 1

  const primeraSalida = r?.primera_salida ?? (data.salidas[0]?.fecha || null)
  const ultimaSalida = r?.ultima_salida ?? (data.salidas[data.salidas.length - 1]?.fecha || null)
  const maxSaldo = Math.max(0, ...data.productos.map(p => p.tn_saldo || 0))

  const exportar = () => {
    const resumen: Array<Record<string, unknown>> = [
      ['NumRel / lote', data.lote], ['Tipo', TIPO_LABEL[data.tipo] || data.tipo], ['Estado', r?.estado ?? 'Sin ingresos en el periodo'],
      ['OT en el TMS', data.contrato ? `${data.contrato.code} (${data.contrato.status})` : 'Sin OT registrada'],
      ['Fecha de corte', data.cutoff], ['TN ingresada', r?.tn_in], ['TN despachada', r?.tn_out], ['TN pendiente (saldo)', r?.tn_saldo],
      ['% despachado', r?.pct_despachado], ['Primera entrada', r?.primer_ingreso], ['Última entrada', r?.ultimo_ingreso],
      ['Primera salida', primeraSalida], ['Última salida', ultimaSalida], ['Días APT (saldo más antiguo)', r?.dias],
      ['Aging ponderado (días)', r?.aging_pond], ['TN×Días', r?.tn_dias], ['Días prom. de despacho', r?.dias_despacho_pond],
      ['N° productos', r?.productos], ['N° OP', r?.ops], ['N° IPT', r?.ipts], ['N° capas', r?.capas],
      ['KG de salidas sin entrada identificada', r3(sum(data.salidas, s => s.kg_sin_entrada))],
    ].map(([k, v]) => ({ Concepto: k, Valor: v ?? null }))
    exportAptXlsx(`APT_lote_${data.lote}`, {
      Resumen: resumen,
      Productos: data.productos.map(p => ({
        Producto: p.clave, Glosa: p.etiqueta, Capas: p.capas, 'TN ingresada': p.tn_in, 'TN despachada': p.tn_out, 'Saldo TN': p.tn_saldo,
        'Primer ingreso': p.primer_ingreso, 'Última salida': p.ultima_salida, 'Días saldo': p.dias, 'Aging ponderado': p.aging_pond,
        'Días prom. despacho': p.dias_despacho_pond, 'TN×Días': p.tn_dias, Rango: p.rango, Estado: p.estado,
      })),
      Capas: data.capas.map(c => ({
        'ID capa': c.id, 'Fecha ingreso': c.fecha_ingreso, Producto: c.producto, Glosa: c.glosa, 'NumRel OP': c.numrel_op, IPT: c.ipt,
        Documento: c.documento, FechaEntrega: c.fecha_entrega, Cantidad: c.cantidad, Unidad: c.unidad, 'KG ingresado': c.kg_in,
        'KG despachado': c.kg_out, 'Saldo KG': c.kg_saldo, Días: c.dias, 'TN×Días': c.tn_dias, Rango: c.rango, Estado: c.estado,
        'Última salida': c.ultima_salida, Archivo: c.archivo, 'Fila ENTRADA': c.row_no,
      })),
      Salidas: data.salidas.map(s => ({
        'ID salida': s.id, Fecha: s.fecha, Guía: s.guia, Cliente: s.cliente, DocRel: s.docrel, NumRel: s.numrel, Producto: s.producto,
        Glosa: s.glosa, Cantidad: s.cantidad, Unidad: s.unidad, KG: s.kg, 'KG asignado': s.kg_asignado, 'KG sin entrada': s.kg_sin_entrada,
        Clase: s.clase ? CLASE_SALIDA_LABEL[s.clase] || s.clase : null, Archivo: s.archivo, 'Fila SALIDA': s.row_no,
      })),
      Asignaciones: data.asignaciones.map(a => {
        const c = capasById.get(a.capa), s = salidasById.get(a.salida)
        return {
          'ID capa': a.capa, 'ID salida': a.salida, Producto: c?.producto ?? null, 'Fecha ingreso': a.fecha_ingreso, 'Fecha salida': a.fecha_salida,
          Guía: s?.guia ?? null, Cliente: s?.cliente ?? null, 'KG asignado': a.kg, Días: a.dias,
        }
      }),
    })
  }

  return (
    <>
      {/* Encabezado */}
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">NumRel padre / lote</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h2 className="text-2xl font-black tracking-tight text-[#002855]">{data.lote}</h2>
            <TipoBadge tipo={data.tipo} />
            {r && <EstadoBadge estado={r.estado} />}
          </div>
          {r?.etiqueta && <p className="mt-1 max-w-3xl truncate text-sm text-slate-600" title={r.etiqueta}>{r.etiqueta}</p>}
          <p className="mt-1 text-xs text-slate-500">
            Cliente: <b className="text-slate-700">{r?.cliente || 'Sin cliente identificado'}</b> · OT madre {data.lote.split('-')[0]}
            {r?.ultimo_despacho ? <> · Último despacho {fmtDate(r.ultimo_despacho)}</> : null} · Corte {fmtDate(data.cutoff)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {data.contrato ? (
            <Link href={`/contratos/${data.contrato.id}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#002855]/20 bg-[#002855]/5 px-3 py-2 text-xs font-bold text-[#002855] hover:bg-[#002855]/10">
              <ExternalLink className="h-3.5 w-3.5" /> Ver OT en Contratos ({data.contrato.code} · {data.contrato.status})
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-500">
              <Info className="h-3.5 w-3.5" /> Sin OT registrada en el TMS
            </span>
          )}
          <button type="button" onClick={exportar}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-sm hover:border-[#002855] hover:text-[#002855]">
            <Download className="h-3.5 w-3.5" /> Exportar Excel
          </button>
        </div>
      </div>

      {!data.capas.length && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-bold">Salida sin entrada identificada en el periodo (stock anterior a la primera carga)</p>
            <p className="mt-0.5 text-xs">
              Este lote tiene {fmtInt(data.salidas.length)} salida(s) por {fmtTn(sum(data.salidas, s => s.kg) / 1000)} TN, pero ningún ingreso a APT en las hojas
              ENTRADA cargadas. No suma al saldo ni a la permanencia; se muestra para trazabilidad.
            </p>
          </div>
        </div>
      )}

      {/* KPIs */}
      {r && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <KpiCard label="TN ingresada" value={fmtTn(r.tn_in)} unit="TN" tone="navy" hint={`${fmtInt(r.capas)} capas de ingreso`} />
          <KpiCard label="TN pendiente (saldo)" value={fmtTn(r.tn_saldo)} unit="TN" tone={r.tn_saldo > 0 ? 'warn' : 'ok'} hint={`Despachado ${fmtTn(r.tn_out)} TN`} />
          <KpiCard label="% despachado" value={fmtPct(r.pct_despachado)} tone={(r.pct_despachado ?? 0) >= 98 ? 'ok' : 'default'}
            hint={<InlineBar value={r.pct_despachado ?? 0} max={100} color={APT_COLORS.out} />} />
          <KpiCard label="Días APT" value={fmtDias(r.dias)} unit="días" tone={r.dias !== null && r.dias > alert ? 'crit' : r.dias !== null && r.dias > 15 ? 'warn' : 'ok'}
            hint={r.fecha_saldo ? `Saldo más antiguo desde ${fmtDate(r.fecha_saldo)}` : 'Lote cerrado: permanencia total'} />
          <KpiCard label="Aging ponderado" value={fmtDias(r.aging_pond)} unit="días" hint="Σ(TN×días) / Σ TN del saldo" />
          <KpiCard label="TN×Días" value={fmtTn(r.tn_dias)} tone={r.tn_dias > 0 ? 'crit' : 'default'} hint="Saldo TN × días del saldo" />
          <KpiCard label="Entradas" value={fmtDate(r.primer_ingreso)} hint={`Última: ${fmtDate(r.ultimo_ingreso)}`} />
          <KpiCard label="Salidas (FIFO)" value={fmtDate(primeraSalida)} hint={`Última: ${fmtDate(ultimaSalida)}`} />
          <KpiCard label="Días prom. despacho" value={fmtDias(r.dias_despacho_pond)} unit="días" hint="Ponderado por KG despachado" />
          <KpiCard label="Productos" value={fmtInt(r.productos)} />
          <KpiCard label="Órdenes de producción" value={fmtInt(r.ops)} />
          <KpiCard label="IPT" value={fmtInt(r.ipts)} />
        </div>
      )}

      {/* Evolución y productos */}
      {data.capas.length > 0 && (
        <div className="grid gap-4 xl:grid-cols-5">
          <ChartCard className="xl:col-span-3" title="Evolución del lote en APT"
            subtitle="Ingresos acumulados vs salidas asignadas por FIFO y saldo resultante (TN)"
            info="Ingresos: suma de capas de ENTRADA por fecha. Salidas: KG de despacho asignados a esas capas por FIFO. Las salidas sin entrada identificada no se incluyen.">
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={evolucion} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="aptLoteIn" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={APT_COLORS.in} stopOpacity={0.18} />
                      <stop offset="100%" stopColor={APT_COLORS.in} stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="aptLoteOut" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={APT_COLORS.out} stopOpacity={0.2} />
                      <stop offset="100%" stopColor={APT_COLORS.out} stopOpacity={0.03} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={t => fmtDate(msDate(Number(t))).slice(0, 5)}
                    axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#64748b' }} minTickGap={24} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#64748b' }} width={48} tickFormatter={v => fmtTn(Number(v)).replace(/,00$/, '')} />
                  <Tooltip content={<EvolTooltip />} />
                  <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                  <Area type="stepAfter" dataKey="in_acum" name="Ingresos acumulados" stroke={APT_COLORS.in} strokeWidth={1.5} fill="url(#aptLoteIn)" animationDuration={600} />
                  <Area type="stepAfter" dataKey="out_acum" name="Salidas asignadas acumuladas" stroke={APT_COLORS.out} strokeWidth={1.5} fill="url(#aptLoteOut)" animationDuration={600} />
                  <Line type="stepAfter" dataKey="saldo" name="Saldo en APT" stroke={APT_COLORS.stock} strokeWidth={2.5} dot={false} animationDuration={600} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </ChartCard>

          <ChartCard className="xl:col-span-2" title="Saldo por producto" bodyClassName="p-0"
            subtitle={producto ? <>Filtrando tablas por <b className="font-mono">{producto}</b> · <button type="button" className="font-semibold text-[#cf152d] hover:underline" onClick={() => setProducto(null)}>quitar</button></> : 'Clic en un producto para filtrar las tablas de abajo'}>
            <div className="max-h-72 overflow-auto">
              <DataTable className="w-full border-separate border-spacing-0 text-xs">
                <thead>
                  <tr>{['Producto', 'Saldo TN', 'Días', 'TN×Días', 'Estado'].map((h, i) => (
                    <th key={h} className={`sticky top-0 z-10 border-b border-slate-200 bg-slate-50 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500 ${i === 0 ? 'text-left' : i === 4 ? 'text-left' : 'text-right'}`}>{h}</th>
                  ))}</tr>
                </thead>
                <tbody>
                  {data.productos.map(p => {
                    const sel = producto === p.clave
                    return (
                      <tr key={p.clave} onClick={() => setProducto(sel ? null : p.clave)}
                        className={`cursor-pointer ${sel ? 'bg-[#002855]/5' : 'hover:bg-slate-50'}`}>
                        <td className="max-w-[220px] border-b border-slate-100 px-3 py-2">
                          <p className={`font-mono text-[11px] font-semibold ${sel ? 'text-[#cf152d]' : 'text-[#002855]'}`}>{p.clave}</p>
                          <p className="truncate text-[11px] text-slate-500" title={p.etiqueta || ''}>{p.etiqueta || '—'}</p>
                        </td>
                        <td className="min-w-[90px] border-b border-slate-100 px-3 py-2 text-right tabular-nums">
                          <span className="font-semibold text-slate-800">{fmtTn(p.tn_saldo)}</span>
                          {p.tn_saldo > 0 && <div className="mt-1"><InlineBar value={p.tn_saldo} max={maxSaldo} /></div>}
                          <p className="text-[10px] text-slate-400">de {fmtTn(p.tn_in)}</p>
                        </td>
                        <td className="border-b border-slate-100 px-3 py-2 text-right"><DiasBadge dias={p.dias} alert={alert} /></td>
                        <td className="border-b border-slate-100 px-3 py-2 text-right tabular-nums">{fmtTn(p.tn_dias)}</td>
                        <td className="border-b border-slate-100 px-3 py-2"><EstadoBadge estado={p.estado} /></td>
                      </tr>
                    )
                  })}
                </tbody>
              </DataTable>
            </div>
          </ChartCard>
        </div>
      )}

      {/* Capas FIFO */}
      {data.capas.length > 0 && (
        <ChartCard title={`Capas FIFO (ingresos) · ${fmtInt(capas.length)}`} bodyClassName="p-0"
          subtitle="Cada fila de ENTRADA es una capa; las salidas consumen primero la más antigua del mismo producto">
          <Table
            rows={capas}
            rowKey={c => c.id}
            cols={[
              { h: 'Fecha ingreso', c: c => fmtDate(c.fecha_ingreso) },
              { h: 'Producto', c: c => <span className="font-mono text-[11px]">{c.producto}</span> },
              { h: 'Glosa', c: c => <span className="block max-w-[240px] truncate" title={c.glosa || ''}>{c.glosa || '—'}</span> },
              { h: 'OP', c: c => c.numrel_op || '—' },
              { h: 'IPT', c: c => c.ipt || '—' },
              { h: 'Documento', c: c => c.documento || '—' },
              { h: 'KG ingresado', r: true, c: c => fmtKg(c.kg_in), t: rows => fmtKg(sum(rows, c => c.kg_in)) },
              { h: 'KG despachado', r: true, c: c => fmtKg(c.kg_out), t: rows => fmtKg(sum(rows, c => c.kg_out)) },
              { h: 'Saldo KG', r: true, c: c => <span className={c.kg_saldo > 0.5 ? 'font-bold text-[#002855]' : 'text-slate-400'}>{fmtKg(c.kg_saldo)}</span>, t: rows => fmtKg(sum(rows, c => c.kg_saldo)) },
              { h: 'Días', r: true, c: c => <DiasBadge dias={c.dias} alert={alert} /> },
              { h: 'Rango', c: c => c.rango || '—' },
              { h: 'Estado', c: c => <EstadoBadge estado={c.estado} /> },
              { h: '', c: c => <OrigenBtn onClick={() => onOrigen({ titulo: `Capa ${c.id} · ${c.producto}`, archivo: c.archivo, fila: c.row_no, hoja: 'ENTRADA', raw: c.raw })} /> },
            ]}
          />
        </ChartCard>
      )}

      {/* Salidas */}
      <ChartCard title={`Salidas del lote · ${fmtInt(salidas.length)}`} bodyClassName="p-0"
        subtitle="Todos los despachos con este NumRel y cuánto de cada uno se asignó a capas de ingreso">
        {salidas.length ? (
          <Table
            rows={salidas}
            rowKey={s => s.id}
            rowClass={s => (s.kg_sin_entrada > 0.5 ? 'bg-amber-50/40' : '')}
            cols={[
              { h: 'Fecha', c: s => fmtDate(s.fecha) },
              { h: 'Guía', c: s => s.guia || '—' },
              { h: 'Cliente', c: s => <span className="block max-w-[200px] truncate" title={s.cliente || ''}>{s.cliente || '—'}</span> },
              { h: 'DocRel', c: s => s.docrel || '—' },
              { h: 'Producto', c: s => <span className="font-mono text-[11px]">{s.producto}</span> },
              { h: 'Glosa', c: s => <span className="block max-w-[220px] truncate" title={s.glosa || ''}>{s.glosa || '—'}</span> },
              { h: 'KG', r: true, c: s => fmtKg(s.kg), t: rows => fmtKg(sum(rows, s => s.kg)) },
              { h: 'KG asignado', r: true, c: s => fmtKg(s.kg_asignado), t: rows => fmtKg(sum(rows, s => s.kg_asignado)) },
              { h: 'KG sin entrada', r: true, c: s => <span className={s.kg_sin_entrada > 0.5 ? 'font-bold text-amber-700' : 'text-slate-400'}>{fmtKg(s.kg_sin_entrada)}</span>, t: rows => fmtKg(sum(rows, s => s.kg_sin_entrada)) },
              {
                h: 'Clase', c: s => s.clase
                  ? <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${CLASE_TONE[s.clase] || CLASE_TONE.SIN_NUMREL}`}>{CLASE_SALIDA_LABEL[s.clase] || s.clase}</span>
                  : '—',
              },
              { h: '', c: s => <OrigenBtn onClick={() => onOrigen({ titulo: `Salida ${s.guia || s.id} · ${s.producto}`, archivo: s.archivo, fila: s.row_no, hoja: 'SALIDA', raw: s.raw })} /> },
            ]}
          />
        ) : (
          <p className="p-6 text-center text-sm text-slate-500">Sin salidas registradas para este lote{producto ? ' y producto' : ''}.</p>
        )}
      </ChartCard>

      {/* Asignación FIFO */}
      {data.capas.length > 0 && (
        <ChartCard title={`Asignación FIFO · ${fmtInt(asignaciones.length)}`} bodyClassName="p-0"
          subtitle="Qué capa de ingreso consumió cada salida y cuántos días permaneció ese material"
          actions={
            <span className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-semibold ${cuadraOk ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}
              title={`Σ asignado ${fmtKg(cuadre.asignado)} KG · Σ despachado de capas ${fmtKg(cuadre.capasOut)} KG · Σ asignado en salidas ${fmtKg(cuadre.salidasAsig)} KG`}>
              {cuadraOk ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
              {cuadraOk ? 'Cuadra' : 'Revisar'}: {fmtKg(cuadre.asignado)} KG asignados
            </span>
          }>
          <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-slate-100 px-4 py-2 text-[11px] text-slate-500">
            <span>KG despachado según capas: <b className="tabular-nums text-slate-700">{fmtKg(cuadre.capasOut)}</b></span>
            <span>KG asignado (esta tabla): <b className="tabular-nums text-slate-700">{fmtKg(cuadre.asignado)}</b></span>
            <span>KG asignado según salidas: <b className="tabular-nums text-slate-700">{fmtKg(cuadre.salidasAsig)}</b></span>
            <span>KG de salidas sin entrada: <b className="tabular-nums text-amber-700">{fmtKg(cuadre.sinEntrada)}</b> de {fmtKg(cuadre.salidasKg)}</span>
          </div>
          {asignaciones.length ? (
            <Table
              rows={asignaciones}
              rowKey={a => `${a.capa}-${a.salida}`}
              cols={[
                { h: 'Capa', c: a => <span className="tabular-nums text-slate-500">#{a.capa}</span> },
                { h: 'Producto', c: a => <span className="font-mono text-[11px]">{a.c?.producto || '—'}</span> },
                { h: 'Fecha ingreso', c: a => fmtDate(a.fecha_ingreso) },
                { h: 'Salida (guía)', c: a => a.s?.guia || `#${a.salida}` },
                { h: 'Fecha salida', c: a => fmtDate(a.fecha_salida) },
                { h: 'Cliente', c: a => <span className="block max-w-[200px] truncate" title={a.s?.cliente || ''}>{a.s?.cliente || '—'}</span> },
                { h: 'KG', r: true, c: a => fmtKg(a.kg), t: rows => fmtKg(sum(rows, a => a.kg)) },
                { h: 'Días en APT', r: true, c: a => <DiasBadge dias={a.dias} alert={alert} /> },
              ]}
            />
          ) : (
            <p className="p-6 text-center text-sm text-slate-500">Todavía no hay salidas asignadas a estas capas: todo el ingreso sigue en APT.</p>
          )}
        </ChartCard>
      )}
    </>
  )
}

// Tabla compacta con encabezado sticky y fila de totales opcional
function Table<T>({ rows, cols, rowKey, rowClass }: {
  rows: T[]; rowKey: (r: T) => string | number; rowClass?: (r: T) => string
  cols: Array<{ h: string; c: (r: T) => ReactNode; r?: boolean; t?: (rows: T[]) => ReactNode }>
}) {
  const hasTotals = cols.some(c => c.t)
  return (
    <div className="max-h-[480px] overflow-auto">
      <DataTable className="w-full border-separate border-spacing-0 text-xs">
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th key={`${c.h}-${i}`} scope="col"
                className={`sticky top-0 z-10 whitespace-nowrap border-b border-slate-200 bg-slate-50 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500 ${c.r ? 'text-right' : 'text-left'}`}>
                {c.h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={rowKey(r)} className={`hover:bg-slate-50 ${rowClass?.(r) || ''}`}>
              {cols.map((c, i) => (
                <td key={`${c.h}-${i}`} className={`whitespace-nowrap border-b border-slate-100 px-3 py-1.5 text-slate-700 ${c.r ? 'text-right tabular-nums' : ''}`}>{c.c(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
        {hasTotals && (
          <tfoot>
            <tr>
              {cols.map((c, i) => (
                <td key={`${c.h}-${i}`}
                  className={`sticky bottom-0 whitespace-nowrap border-t border-slate-200 bg-slate-50 px-3 py-2 font-bold text-slate-800 ${c.r ? 'text-right tabular-nums' : ''}`}>
                  {i === 0 ? 'Total' : c.t ? c.t(rows) : ''}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </DataTable>
    </div>
  )
}

function OrigenBtn({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label="Ver movimiento original"
      className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-600 hover:border-[#002855] hover:text-[#002855]">
      <FileSearch className="h-3 w-3" /> Ver origen
    </button>
  )
}

function OrigenModal({ origen, onClose }: { origen: Origen; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const fmt = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v))
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose} role="presentation">
      <div role="dialog" aria-modal="true" aria-label="Movimiento original" onClick={e => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl bg-white shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-slate-800">{origen.titulo}</h3>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
              <FileText className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{origen.archivo}</span> · hoja {origen.hoja} · fila {fmtInt(origen.fila)}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <X className="h-4 w-4" />
          </button>
        </header>
        <dl className="divide-y divide-slate-100 overflow-y-auto px-5 py-2 text-xs">
          {Object.entries(origen.raw || {}).map(([k, v]) => (
            <div key={k} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 py-1.5">
              <dt className="font-semibold text-slate-500">{k}</dt>
              <dd className="break-words text-slate-800">{fmt(v)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}

function EvolTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: Record<string, number | string> }> }) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  const row = (label: string, v: number | string, color: string, bold = false) => (
    <div className="flex items-center justify-between gap-4">
      <span className="flex items-center gap-1.5 text-slate-500"><span className="h-2 w-2 rounded-full" style={{ background: color }} />{label}</span>
      <span className={`tabular-nums ${bold ? 'font-bold text-slate-900' : 'text-slate-700'}`}>{fmtTn(Number(v))} TN</span>
    </div>
  )
  return (
    <div className="min-w-[220px] rounded-lg border border-slate-200 bg-white p-3 text-xs shadow-lg">
      <p className="mb-1.5 font-bold text-slate-800">{fmtDate(String(p.fecha))}</p>
      {Number(p.ingreso) > 0 && <p className="mb-1 text-[11px] text-blue-600">+ {fmtTn(Number(p.ingreso))} TN ingresadas este día</p>}
      {Number(p.salida) > 0 && <p className="mb-1 text-[11px] text-teal-600">− {fmtTn(Number(p.salida))} TN despachadas este día</p>}
      <div className="space-y-0.5">
        {row('Ingresos acumulados', p.in_acum, APT_COLORS.in)}
        {row('Salidas acumuladas', p.out_acum, APT_COLORS.out)}
        {row('Saldo en APT', p.saldo, APT_COLORS.stock, true)}
      </div>
    </div>
  )
}
