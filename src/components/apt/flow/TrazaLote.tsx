'use client'

import { useMemo, useState } from 'react'
import {
  Archive, ArrowDownToLine, ArrowRight, ArrowUpFromLine, Building2, Factory, Truck, Undo2, Wrench,
} from 'lucide-react'
import { fmtDate, fmtDateTime, fmtDias, fmtInt, fmtTn } from '@/lib/apt/format'
import { exportAptXlsx } from '@/lib/apt/export'
import { ALMACEN_BG, ALMACEN_COLOR, FLOW_ALMACENES } from '@/lib/apt/flowColors'
import { ALMACEN_LABEL, ALMACEN_ROL, type FlowAlmacen, type FlowTraceLote } from '@/lib/apt/flowTypes'
import { KpiCard } from '@/components/apt/ui'
import { ExportButton } from '@/components/apt/TfcShared'
import { short } from '@/components/apt/dashCharts'
import { AlmacenBadge, HATCH_BG, SectionTitle, TmsEstado, TraceLink } from './TrazaParts'

// Ficha de un lote: KPIs, saldo por almacén, línea de tiempo de todos sus movimientos y guías con su estado en el TMS

type Evento = FlowTraceLote['eventos'][number]
const LIMIT = 80

const esSalida = (e: Evento) => e.hacia !== undefined
function EventoIcon({ e }: { e: Evento }) {
  const c = 'h-3.5 w-3.5'
  switch (e.tipo) {
    case 'PRODUCCION': return <Factory className={c} />
    case 'DESPACHO': return <Truck className={c} />
    case 'CONSUMO': return <Wrench className={c} />
    case 'INICIAL': return <Archive className={c} />
    case 'DEVOLUCION': return <Undo2 className={c} />
    case 'OTRO_ALMACEN': return <Building2 className={c} />
    default: return esSalida(e) ? <ArrowUpFromLine className={c} /> : <ArrowDownToLine className={c} />
  }
}

function TimelineItem({ e }: { e: Evento }) {
  const color = ALMACEN_COLOR[e.almacen] || '#64748b'
  const salida = esSalida(e)
  const ini = e.tipo === 'INICIAL'
  const otro = salida ? e.hacia : e.desde
  return (
    <li className="relative pl-10">
      <span className="absolute left-0 top-1 flex h-7 w-7 items-center justify-center rounded-full border-2 bg-white shadow-sm"
        style={{ borderColor: color, color, background: ini ? HATCH_BG : '#fff' }}>
        <EventoIcon e={e} />
      </span>
      <div className="rounded-lg border px-3 py-2" style={{ borderColor: `${color}33`, background: `${ALMACEN_BG[e.almacen] || '#f8fafc'}66` }}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-xs font-bold text-slate-800">{e.evento}</span>
          <AlmacenBadge almacen={e.almacen} short />
          {otro && (
            <span className="inline-flex items-center gap-1 text-[10px] text-slate-500">
              {salida ? <>hacia <ArrowRight className="h-3 w-3" /></> : 'desde'} <AlmacenBadge almacen={otro} short />
            </span>
          )}
          <span className={`ml-auto text-xs font-black tabular-nums ${salida ? 'text-slate-600' : 'text-emerald-700'}`}>{salida ? '−' : '+'}{fmtTn(e.tn)} TN</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
          {e.documento && <span>{e.tipo === 'DESPACHO' ? <>Guía <TraceLink q={e.documento} className="text-[11px]" /></> : <>Doc. {e.documento}</>}</span>}
          {e.lote_origen && <span className="rounded border border-amber-200 bg-amber-50 px-1">viene del lote <TraceLink q={e.lote_origen} className="text-[11px]" /></span>}
          {e.lote_destino && <span className="rounded border border-amber-200 bg-amber-50 px-1">pasa al lote <TraceLink q={e.lote_destino} className="text-[11px]" /></span>}
          {e.cliente && <span className="truncate" title={e.cliente}>{short(e.cliente, 50)}</span>}
          {e.filas > 1 && <span>{fmtInt(e.filas)} filas</span>}
        </div>
      </div>
    </li>
  )
}

export function TrazaLote({ d }: { d: FlowTraceLote }) {
  const [alm, setAlm] = useState<FlowAlmacen | null>(null)
  const [all, setAll] = useState(false)
  const L = d.lote

  const eventos = useMemo(() => (alm ? d.eventos.filter(e => e.almacen === alm) : d.eventos), [d.eventos, alm])
  const porFecha = useMemo(() => {
    const out: Array<{ fecha: string | null; items: Evento[] }> = []
    ;(all ? eventos : eventos.slice(0, LIMIT)).forEach(e => {
      const last = out[out.length - 1]
      if (last && last.fecha === e.fecha) last.items.push(e)
      else out.push({ fecha: e.fecha, items: [e] })
    })
    return out
  }, [eventos, all])
  const cuenta = useMemo(() => {
    const m: Partial<Record<FlowAlmacen, number>> = {}
    d.eventos.forEach(e => { m[e.almacen] = (m[e.almacen] || 0) + 1 })
    return m
  }, [d.eventos])
  const saldoMap = useMemo(() => new Map(d.saldo.map(s => [s.almacen, s])), [d.saldo])

  const doExport = () => exportAptXlsx(`APT_traza_lote_${L.lote}`, {
    Eventos: d.eventos.map(e => ({
      Fecha: fmtDate(e.fecha), Evento: e.evento, Tipo: e.tipo, Almacén: e.almacen, Desde: e.desde ?? '', Hacia: e.hacia ?? '',
      'Lote origen': e.lote_origen ?? '', 'Lote destino': e.lote_destino ?? '', Documento: e.documento, Cliente: e.cliente ?? '', TN: esSalida(e) ? -e.tn : e.tn, Filas: e.filas,
    })),
    Guias: d.guias.map(g => {
      const t = d.tms[g.documento.toUpperCase()]
      return { Guía: g.documento, Fecha: fmtDate(g.fecha), Cliente: g.cliente, TN: g.tn, 'Despacho TMS': t?.numero ?? '', Estado: t?.estado ?? 'No registrada', Placa: t?.placa ?? '', Conductor: t?.conductor ?? '' }
    }),
  })

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Lote</p>
            <h2 className="font-mono text-2xl font-black text-[#002855]">{L.lote}</h2>
            <p className="mt-0.5 text-sm text-slate-700">{L.cliente || 'Cliente no identificado'}</p>
          </div>
          <ExportButton onClick={doExport} />
        </div>
      </section>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <KpiCard label="Producción" value={fmtTn(L.produccion_tn)} unit="TN" tone="navy" hint="Ingresos de producción del lote (647)" />
        <KpiCard label="Primera producción" value={fmtDate(L.primera_produccion)} hint={L.primera_produccion ? undefined : 'Sin producción en el periodo: stock previo o cambio de lote'} />
        <KpiCard label="Primer traspaso a ST" value={fmtDate(L.primer_traspaso_st)} hint="Cuando empezó a prepararse para guiar" />
        <KpiCard label="Despachado" value={fmtTn(L.despacho_tn)} unit="TN" tone="ok" hint={`${fmtInt(d.guias.length)} guías`} />
        <KpiCard label="Última guía" value={fmtDate(L.ultima_guia)} />
        <KpiCard label="Saldo" value={fmtTn(L.saldo_tn)} unit="TN" tone={L.saldo_tn > 0 ? 'warn' : 'ok'} hint="Lo que aún queda en algún almacén" />
        <KpiCard label="Días producción → guía" value={fmtDias(L.dias_total)} unit="días" hint="Ponderado por TN, solo lo trazado a producción" />
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <SectionTitle hint="Clic en un almacén para filtrar la línea de tiempo">Dónde está hoy</SectionTitle>
        <div className="mt-3 flex flex-wrap gap-2">
          {FLOW_ALMACENES.map(a => {
            const s = saldoMap.get(a)
            const active = alm === a
            return (
              <button key={a} type="button" onClick={() => setAlm(active ? null : a)} title={ALMACEN_ROL[a]}
                className={`min-w-[150px] rounded-xl border px-3 py-2 text-left transition-all hover:shadow-md ${s ? '' : 'opacity-60'}`}
                style={{ borderColor: `${ALMACEN_COLOR[a]}55`, background: ALMACEN_BG[a], ...(active ? { boxShadow: `0 0 0 2px ${ALMACEN_COLOR[a]}` } : {}) }}>
                <p className="text-[10px] font-black uppercase tracking-wider" style={{ color: ALMACEN_COLOR[a] }}>{ALMACEN_LABEL[a]}</p>
                <p className="text-lg font-black tabular-nums text-slate-900">{fmtTn(s?.tn ?? 0)} <span className="text-xs font-semibold text-slate-400">TN</span></p>
                <p className="text-[10px] text-slate-500">
                  {s ? <>capa más antigua: {fmtDias(s.dias)} d</> : 'sin saldo'} · {fmtInt(cuenta[a] || 0)} movimientos
                </p>
              </button>
            )
          })}
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-5">
        <section className="rounded-xl border border-slate-200 bg-white shadow-sm xl:col-span-3">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
            <div>
              <h3 className="text-sm font-bold text-slate-800">Línea de tiempo</h3>
              <p className="text-xs text-slate-500">
                {alm ? <>Solo {ALMACEN_LABEL[alm]} · <button type="button" onClick={() => setAlm(null)} className="font-semibold text-[#002855] hover:underline">ver todos</button></>
                  : 'Ingresos (+) y salidas (−) del lote en cada almacén, en orden'}
              </p>
            </div>
            <span className="text-[11px] tabular-nums text-slate-500">{fmtInt(eventos.length)} movimientos</span>
          </header>
          <div className="p-4">
            {porFecha.length ? (
              <ol className="relative space-y-4 before:absolute before:bottom-2 before:left-[13px] before:top-2 before:w-0.5 before:bg-slate-200">
                {porFecha.map((g, gi) => (
                  <li key={gi}>
                    <p className="relative mb-2 pl-10 text-[11px] font-black uppercase tracking-wider text-slate-500">{g.fecha ? fmtDate(g.fecha) : 'Stock previo (sin fecha)'}</p>
                    <ol className="space-y-2">{g.items.map((e, i) => <TimelineItem key={i} e={e} />)}</ol>
                  </li>
                ))}
              </ol>
            ) : <p className="py-8 text-center text-sm text-slate-500">Sin movimientos.</p>}
            {eventos.length > LIMIT && (
              <div className="mt-3 text-center">
                <button type="button" onClick={() => setAll(a => !a)} className="text-xs font-bold text-[#002855] hover:underline">
                  {all ? 'Mostrar menos' : `Ver los ${fmtInt(eventos.length)} movimientos`}
                </button>
              </div>
            )}
          </div>
        </section>

        <section className="self-start rounded-xl border border-slate-200 bg-white shadow-sm xl:col-span-2">
          <header className="border-b border-slate-100 px-4 py-3">
            <h3 className="text-sm font-bold text-slate-800">Guías del lote</h3>
            <p className="text-xs text-slate-500">Estado del despacho en el TMS</p>
          </header>
          {d.guias.length ? (
            <div className="max-h-[640px] overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left font-bold">Guía</th>
                    <th className="px-3 py-2 text-right font-bold">Fecha</th>
                    <th className="px-3 py-2 text-right font-bold">TN</th>
                    <th className="px-3 py-2 text-left font-bold">TMS</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {d.guias.map(g => {
                    const t = d.tms[g.documento.toUpperCase()]
                    return (
                      <tr key={g.documento} className="hover:bg-slate-50">
                        <td className="px-3 py-2">
                          <TraceLink q={g.documento} className="text-xs" />
                          {g.cliente && g.cliente !== L.cliente && <span className="block max-w-[180px] truncate text-[10px] text-slate-400" title={g.cliente}>{g.cliente}</span>}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-600">{fmtDate(g.fecha)}</td>
                        <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-800">{fmtTn(g.tn)}</td>
                        <td className="px-3 py-2">
                          <TmsEstado tms={t} />
                          {t && <span className="mt-0.5 block text-[10px] text-slate-500">{[t.numero, t.placa, t.conductor].filter(Boolean).join(' · ')}{t.llegada ? ` · llegó ${fmtDateTime(t.llegada)}` : ''}</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : <p className="p-6 text-center text-sm text-slate-500">El lote aún no tiene guías.</p>}
        </section>
      </div>
    </div>
  )
}
