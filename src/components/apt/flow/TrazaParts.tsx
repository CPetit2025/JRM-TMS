'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { Truck } from 'lucide-react'
import { fmtDate, fmtDateTime } from '@/lib/apt/format'
import { ALMACEN_BG, ALMACEN_COLOR, ORIGEN_COLOR } from '@/lib/apt/flowColors'
import { ALMACEN_LABEL, ORIGEN_LABEL, type FlowAlmacen, type FlowOrigen, type FlowTms } from '@/lib/apt/flowTypes'
import { traceHref } from '@/lib/apt/useFlowFilters'

// Piezas comunes de Trazabilidad y Adelantos: insignias de almacén/origen, enlaces a la ficha y tarjeta del TMS

// Rayado para el stock previo (sin fecha): su antigüedad real es desconocida
export const HATCH_BG = 'repeating-linear-gradient(135deg, #f1f5f9 0 4px, #e2e8f0 4px 8px)'

export const isInicial = (o: string | null | undefined) => !!o && o.startsWith('INICIAL')

export function AlmacenBadge({ almacen, short = false }: { almacen: FlowAlmacen | string | null | undefined; short?: boolean }) {
  if (!almacen) return <span className="text-slate-400">—</span>
  const a = almacen as FlowAlmacen
  const color = ALMACEN_COLOR[a]
  if (!color) return <span className="text-[11px] font-semibold text-slate-600">{almacen}</span>
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[10px] font-bold"
      style={{ borderColor: `${color}55`, background: ALMACEN_BG[a], color }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {short ? (a === 'ST' ? 'ST' : a) : ALMACEN_LABEL[a]}
    </span>
  )
}

export function OrigenBadge({ origen }: { origen: FlowOrigen | string }) {
  const o = origen as FlowOrigen
  const ini = isInicial(o)
  const color = ORIGEN_COLOR[o] || '#94a3b8'
  return (
    <span title={ini ? 'Stock previo: existía antes del primer día cargado; su antigüedad real es desconocida' : undefined}
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-700"
      style={ini ? { background: HATCH_BG } : { background: `${color}14`, borderColor: `${color}55`, color }}>
      {ORIGEN_LABEL[o] || origen}{ini && <span className="font-normal text-slate-500">· sin fecha</span>}
    </span>
  )
}

export function TraceLink({ q, children, className = '' }: { q: string | null | undefined; children?: ReactNode; className?: string }) {
  if (!q) return <span className="text-slate-400">—</span>
  return (
    <Link href={traceHref(q)} title={`Ver trazabilidad de ${q}`}
      className={`font-mono font-semibold text-[#002855] underline decoration-slate-300 underline-offset-2 hover:decoration-[#002855] ${className}`}>
      {children ?? q}
    </Link>
  )
}

const ESTADO_TMS: Record<string, string> = {
  ENTREGADO: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  RENDIDO: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  LIQUIDADO: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  RETORNO_COMPLETADO: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  EN_RUTA: 'bg-sky-50 text-sky-700 border-sky-200',
  EN_TRANSITO: 'bg-sky-50 text-sky-700 border-sky-200',
  CANCELADO: 'bg-red-50 text-red-700 border-red-200',
  ANULADO: 'bg-red-50 text-red-700 border-red-200',
}
export function TmsEstado({ tms }: { tms: FlowTms | null | undefined }) {
  if (!tms) return <span className="inline-flex whitespace-nowrap rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-500">No registrada en TMS</span>
  const e = (tms.estado || 'REGISTRADA').toUpperCase()
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-bold ${ESTADO_TMS[e] || 'border-blue-200 bg-blue-50 text-blue-700'}`}>
      {tms.estado ? tms.estado.replace(/_/g, ' ') : 'Registrada'}
    </span>
  )
}

export function TmsCard({ tms }: { tms: FlowTms | null | undefined }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500"><Truck className="h-4 w-4" /> Despacho en el TMS</h3>
        <TmsEstado tms={tms} />
      </div>
      {!tms ? (
        <p className="mt-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3 text-xs text-slate-500">
          Guía no registrada aún en el Asistente Documentario del TMS.
        </p>
      ) : (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          {([
            ['Despacho', tms.numero || '—'], ['Programado', fmtDate(tms.programado)], ['Placa', tms.placa || '—'], ['Conductor', tms.conductor || '—'],
            ['Salida', fmtDateTime(tms.salida)], ['Llegada', fmtDateTime(tms.llegada)],
          ] as Array<[string, string]>).map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{k}</dt>
              <dd className="truncate font-semibold text-slate-800" title={v}>{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}

export function SectionTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="text-[11px] font-black uppercase tracking-wider text-slate-500">{children}</h3>
      {hint && <p className="text-[11px] text-slate-400">{hint}</p>}
    </div>
  )
}
