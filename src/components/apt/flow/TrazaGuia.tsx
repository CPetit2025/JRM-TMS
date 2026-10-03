'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { ArrowRight, Factory, FileText, Package, Warehouse } from 'lucide-react'
import { fmtDate, fmtDias, fmtInt, fmtPct, fmtTn } from '@/lib/apt/format'
import { exportAptXlsx } from '@/lib/apt/export'
import { ALMACEN_BG, ALMACEN_COLOR, FLOW_COLOR, ORIGEN_COLOR } from '@/lib/apt/flowColors'
import { ALMACEN_LABEL, ORIGEN_LABEL, type FlowAlmacen, type FlowOrigen, type FlowTraceGuia } from '@/lib/apt/flowTypes'
import { KpiCard } from '@/components/apt/ui'
import { ExportButton } from '@/components/apt/TfcShared'
import { short } from '@/components/apt/dashCharts'
import { AlmacenBadge, HATCH_BG, OrigenBadge, SectionTitle, TmsCard, TraceLink, isInicial } from './TrazaParts'

// Ficha de una guía: de dónde vino cada línea (producción o stock previo), por qué almacenes pasó y cuántos días tardó

type Linea = FlowTraceGuia['lineas'][number]
const LIMIT = 40

// Peso medio de unos días ponderados por TN (solo las líneas con dato)
function pond(rows: Linea[], key: 'dias_total' | 'dias_previo' | 'dias_final') {
  let kg = 0, s = 0
  rows.forEach(r => { const d = r[key]; if (d !== null && d !== undefined && r.tn > 0) { kg += r.tn; s += r.tn * d } })
  return kg > 0 ? s / kg : null
}

function Step({ icon, title, date, color, bg, hatch, children }: {
  icon: ReactNode; title: ReactNode; date?: string | null; color: string; bg: string; hatch?: boolean; children?: ReactNode
}) {
  return (
    <div className="min-w-[120px] rounded-lg border px-2.5 py-1.5" style={{ borderColor: `${color}55`, background: hatch ? HATCH_BG : bg }}>
      <p className="flex items-center gap-1 text-[10px] font-black uppercase tracking-wider" style={{ color }}>{icon}{title}</p>
      <p className="text-xs font-semibold tabular-nums text-slate-800">{date === undefined ? '' : date ? fmtDate(date) : 'Sin fecha'}</p>
      {children}
    </div>
  )
}

function Gap({ dias, label }: { dias: number | null; label?: string }) {
  return (
    <div className="flex shrink-0 flex-col items-center px-1 text-slate-400" title={label}>
      <span className={`text-[10px] font-bold tabular-nums ${dias === null ? 'text-slate-300' : dias > 7 ? 'text-red-600' : dias > 1 ? 'text-amber-600' : 'text-emerald-600'}`}>
        {dias === null ? '¿?' : `${fmtDias(dias)} d`}
      </span>
      <ArrowRight className="h-3.5 w-3.5" />
    </div>
  )
}

const alm = (a: FlowAlmacen) => ({ color: ALMACEN_COLOR[a] || '#64748b', bg: ALMACEN_BG[a] || '#f8fafc' })

export function Journey({ l }: { l: Linea }) {
  const ini = isInicial(l.origen)
  const f = alm(l.almacen)
  const viaDistinta = l.via && l.via !== l.almacen_origen && l.via !== l.almacen ? l.via : null
  const mismoAlmacen = l.almacen === l.almacen_origen
  const cambioLote = l.lote_origen && l.lote_origen !== l.lote
  return (
    <div className="flex items-stretch gap-0.5 overflow-x-auto pb-1">
      {ini ? (
        <Step icon={<Package className="h-3 w-3" />} title={`Stock previo ${l.almacen_origen}`} date={null} color="#475569" bg="#f8fafc" hatch>
          <p className="text-[10px] text-slate-500">Antes del periodo cargado</p>
        </Step>
      ) : (
        <Step icon={<Factory className="h-3 w-3" />} title={l.origen === 'PRODUCCION' ? 'Producción' : ORIGEN_LABEL[l.origen]} date={l.fecha_origen}
          color={l.origen === 'PRODUCCION' ? FLOW_COLOR.PRODUCCION : ORIGEN_COLOR[l.origen]} bg="#f0fdf4">
          <p className="text-[10px] text-slate-500">en {ALMACEN_LABEL[l.almacen_origen] || l.almacen_origen}</p>
        </Step>
      )}
      {cambioLote && (
        <div className="flex shrink-0 items-center px-1 text-[10px] text-slate-500" title="El lote cambió en el camino (asignación o reasignación)">
          <span className="rounded border border-amber-200 bg-amber-50 px-1 py-0.5">lote <TraceLink q={l.lote_origen} className="text-[10px]" /></span>
        </div>
      )}
      {viaDistinta && (
        <>
          <Gap dias={null} label="Pasó por este almacén" />
          <Step icon={<Warehouse className="h-3 w-3" />} title={`vía ${viaDistinta}`} color={alm(viaDistinta).color} bg={alm(viaDistinta).bg} />
        </>
      )}
      {!mismoAlmacen || l.fecha_llegada ? (
        <>
          <Gap dias={l.dias_previo} label="Días desde el origen hasta la llegada al último almacén" />
          <Step icon={<Warehouse className="h-3 w-3" />} title={l.almacen === 'ST' ? 'ST VENTAS' : l.almacen} date={l.fecha_llegada} color={f.color} bg={f.bg}>
            <p className="text-[10px] text-slate-500">llegada</p>
          </Step>
        </>
      ) : null}
      <Gap dias={l.dias_final} label="Días en el último almacén hasta la guía" />
      <Step icon={<FileText className="h-3 w-3" />} title="Guía" date={l.fecha_salida} color={FLOW_COLOR.CLIENTE} bg="#eff6ff">
        <p className="text-[10px] text-slate-500">total {l.dias_total === null ? '¿?' : `${fmtDias(l.dias_total)} d`}</p>
      </Step>
    </div>
  )
}

export function TrazaGuia({ d }: { d: FlowTraceGuia }) {
  const [all, setAll] = useState(false)
  const g = d.guia
  const lineas = d.lineas
  const porOrigen = useMemo(() => {
    const m = new Map<FlowOrigen, number>()
    lineas.forEach(l => m.set(l.origen, (m.get(l.origen) || 0) + l.tn))
    return [...m.entries()].map(([origen, tn]) => ({ origen, tn })).sort((a, b) => b.tn - a.tn)
  }, [lineas])
  const totLineas = porOrigen.reduce((s, r) => s + r.tn, 0)
  const dTotal = pond(lineas, 'dias_total'), dPrevio = pond(lineas, 'dias_previo'), dFinal = pond(lineas, 'dias_final')
  const iniTn = porOrigen.filter(r => isInicial(r.origen)).reduce((s, r) => s + r.tn, 0)
  const shown = all ? lineas : lineas.slice(0, LIMIT)

  const doExport = () => exportAptXlsx(`APT_traza_guia_${g.documento}`, {
    Lineas: lineas.map(l => ({
      Lote: l.lote, Producto: l.producto, Glosa: l.glosa, Origen: ORIGEN_LABEL[l.origen] || l.origen, 'Lote origen': l.lote_origen,
      'Almacén origen': l.almacen_origen, 'Fecha origen': fmtDate(l.fecha_origen), Vía: l.via, 'Almacén final': l.almacen,
      'Fecha llegada': fmtDate(l.fecha_llegada), 'Fecha guía': fmtDate(l.fecha_salida), TN: l.tn,
      'Días total': l.dias_total, 'Días previo': l.dias_previo, 'Días final': l.dias_final,
    })),
  })

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm lg:col-span-2">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Guía de remisión</p>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h2 className="font-mono text-2xl font-black text-[#002855]">{g.documento}</h2>
            <span className="text-sm font-semibold text-slate-600">{fmtDate(g.fecha)}</span>
          </div>
          <p className="mt-1 text-sm text-slate-700">{g.cliente || 'Cliente no identificado'}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-lg bg-[#002855] px-2.5 py-1 font-black tabular-nums text-white">{fmtTn(g.tn)} TN</span>
            <span className="text-slate-500">{fmtInt(g.filas)} filas · lotes:</span>
            {g.lotes.map(l => <TraceLink key={l} q={l} className="text-xs" />)}
          </div>
        </section>
        <TmsCard tms={d.tms} />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Producción → guía" value={fmtDias(dTotal)} unit="días" tone="navy" hint="Días ponderados por TN (solo lo trazado a producción)" />
        <KpiCard label="Hasta el último almacén" value={fmtDias(dPrevio)} unit="días" hint="Producción → llegada a ST (o al almacén desde donde se guió)" />
        <KpiCard label="En el último almacén" value={fmtDias(dFinal)} unit="días" tone={dFinal !== null && dFinal > 1 ? 'warn' : 'ok'} hint="Llegada → guía. Ideal en ST: mismo día" />
        <KpiCard label="Stock previo" value={fmtTn(iniTn)} unit="TN" hint="Existía antes del primer día cargado; su antigüedad real es desconocida" />
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <SectionTitle hint="TN de la guía por origen raíz">Origen de lo despachado</SectionTitle>
        <div className="mt-3 flex h-3 w-full overflow-hidden rounded-full bg-slate-100">
          {porOrigen.map(r => (
            <div key={r.origen} title={`${ORIGEN_LABEL[r.origen]}: ${fmtTn(r.tn)} TN`}
              style={{ width: `${totLineas ? (r.tn / totLineas) * 100 : 0}%`, background: isInicial(r.origen) ? HATCH_BG : ORIGEN_COLOR[r.origen] }} />
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {porOrigen.map(r => (
            <span key={r.origen} className="inline-flex items-center gap-1.5 text-xs">
              <OrigenBadge origen={r.origen} />
              <span className="tabular-nums text-slate-600"><b>{fmtTn(r.tn)}</b> TN · {fmtPct(totLineas ? (r.tn / totLineas) * 100 : null)}</span>
            </span>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <div>
            <h3 className="text-sm font-bold text-slate-800">Recorrido por línea</h3>
            <p className="text-xs text-slate-500">Origen → almacén de paso → almacén final → guía, con los días entre cada etapa</p>
          </div>
          <ExportButton onClick={doExport} disabled={!lineas.length} />
        </header>
        <ul className="divide-y divide-slate-100">
          {shown.map((l, i) => (
            <li key={i} className="grid gap-2 px-4 py-3 lg:grid-cols-[minmax(220px,1fr)_auto] lg:items-center">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <TraceLink q={l.lote} className="text-xs" />
                  <OrigenBadge origen={l.origen} />
                  <AlmacenBadge almacen={l.almacen} short />
                  <span className="ml-auto text-xs font-bold tabular-nums text-slate-800 lg:ml-0">{fmtTn(l.tn)} TN</span>
                </div>
                <p className="mt-0.5 truncate text-[11px] text-slate-500" title={l.glosa || ''}>
                  <span className="font-mono text-slate-600">{l.producto}</span> · {short(l.glosa, 70)}
                </p>
              </div>
              <Journey l={l} />
            </li>
          ))}
        </ul>
        {lineas.length > LIMIT && (
          <div className="border-t border-slate-100 p-2 text-center">
            <button type="button" onClick={() => setAll(a => !a)} className="text-xs font-bold text-[#002855] hover:underline">
              {all ? 'Mostrar menos' : `Ver las ${fmtInt(lineas.length)} líneas`}
            </button>
          </div>
        )}
        {!lineas.length && <p className="p-6 text-center text-sm text-slate-500">La guía no tiene líneas trazadas.</p>}
      </section>
    </div>
  )
}
