'use client'

import { useEffect, useState } from 'react'
import { AlertOctagon, AlertTriangle, CalendarRange, CheckCircle2, Info } from 'lucide-react'
import { aptApi } from '@/lib/apt/api'
import { fmtDate, fmtInt } from '@/lib/apt/format'
import type { AptUploadKind } from '@/lib/apt/api'
import { APT_KINDS, APT_KIND_LABEL } from '@/lib/apt/parseWorkbook'
import type { AptCoverage, AptCoverageSheet } from '@/lib/apt/types'

// Cobertura de fechas de las cargas: rangos cargados por hoja (ENTRADA, SALIDA, traspasos, consumos, devoluciones),
// huecos y alertas de secuencia

// Un color por tipo de hoja, igual en la vista previa de la carga, la cobertura y el historial
export const KIND_STYLE: Record<AptUploadKind, { text: string; bar: string; dot: string }> = {
  ENTRADA: { text: 'text-blue-700', bar: 'bg-blue-500', dot: 'bg-blue-500' },
  SALIDA: { text: 'text-teal-700', bar: 'bg-teal-500', dot: 'bg-teal-500' },
  TRASPASO_SAL: { text: 'text-amber-700', bar: 'bg-amber-500', dot: 'bg-amber-500' },
  TRASPASO_ENT: { text: 'text-indigo-700', bar: 'bg-indigo-500', dot: 'bg-indigo-500' },
  CONSUMO: { text: 'text-purple-700', bar: 'bg-purple-500', dot: 'bg-purple-500' },
  DEVOLUCION: { text: 'text-emerald-700', bar: 'bg-emerald-500', dot: 'bg-emerald-500' },
}

// Tipos presentes en la cobertura, en el orden del flujo
const kindsOf = (c: AptCoverage) => APT_KINDS.filter(k => c.hojas[k])
const labelOf = (c: AptCoverage, k: AptUploadKind) => c.hojas[k]?.etiqueta || APT_KIND_LABEL[k]

const NIVEL = {
  error: { cls: 'border-red-200 bg-red-50 text-red-800', Icon: AlertOctagon },
  aviso: { cls: 'border-amber-200 bg-amber-50 text-amber-800', Icon: AlertTriangle },
  info: { cls: 'border-slate-200 bg-slate-50 text-slate-600', Icon: Info },
} as const

export function CoverageAlerts({ coverage, preview = false }: { coverage: AptCoverage; preview?: boolean }) {
  const hojas = kindsOf(coverage).filter(k => coverage.hojas[k]?.preview)
  return (
    <div className="space-y-2">
      {preview && hojas.length > 0 && (
        <div className="rounded-lg border border-[#002855]/20 bg-[#002855]/5 px-3 py-2.5 text-xs text-[#002855]">
          <p className="flex items-center gap-1.5 font-bold"><CalendarRange className="h-3.5 w-3.5" /> Cómo queda consolidado</p>
          {hojas.map(k => {
            const h = coverage.hojas[k] as AptCoverageSheet
            const p = h.preview!
            return (
              <p key={k} className="mt-1 tabular-nums">
                <b className={KIND_STYLE[k].text}>{labelOf(coverage, k)}</b>: este archivo trae del {fmtDate(p.desde)} al {fmtDate(p.hasta)}
                {p.filas_a_reemplazar > 0 ? ` y reemplaza ${fmtInt(p.filas_a_reemplazar)} fila(s) ya cargadas de esas fechas` : ' (fechas nuevas, no reemplaza nada)'}.
                {' '}Lo cargado quedará del {fmtDate(h.desde)} al {fmtDate(h.hasta)}{h.huecos.length ? `, con ${h.huecos.length} hueco(s)` : ' sin huecos'}.
              </p>
            )
          })}
        </div>
      )}
      {coverage.alertas.length === 0 ? (
        !preview && (
          <p className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            <CheckCircle2 className="h-4 w-4" /> Secuencia de fechas completa en todas las hojas cargadas.
          </p>
        )
      ) : coverage.alertas.map((a, i) => {
        const { cls, Icon } = NIVEL[a.nivel]
        return (
          <p key={i} className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${cls}`}>
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {a.mensaje}
          </p>
        )
      })}
    </div>
  )
}

// Barra de tiempo: tramos cargados (color) y huecos (rojo) entre la primera y la última fecha cargada
function Timeline({ k, label, h, min, max }: { k: AptUploadKind; label: string; h: AptCoverageSheet; min: number; max: number }) {
  const span = Math.max(1, max - min + 1)
  const pos = (d: string) => ((Date.parse(d) / 86400000 - min) / span) * 100
  const width = (a: string, b: string) => Math.max(0.6, ((Date.parse(b) - Date.parse(a)) / 86400000 + 1) / span * 100)
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className={`flex items-center gap-1.5 font-black uppercase tracking-wider ${KIND_STYLE[k].text}`}>
          <span className={`h-2 w-2 rounded-full ${KIND_STYLE[k].dot}`} />{label}
        </span>
        <span className="tabular-nums text-slate-500">{h.desde ? `${fmtDate(h.desde)} – ${fmtDate(h.hasta)}` : 'Sin cargas'}</span>
      </div>
      <div className="relative h-4 w-full overflow-hidden rounded-full bg-slate-100">
        {h.rangos.map(r => (
          <div key={r.desde} title={`Cargado: ${fmtDate(r.desde)} – ${fmtDate(r.hasta)}`}
            className={`absolute top-0 h-full ${KIND_STYLE[k].bar}`}
            style={{ left: `${pos(r.desde)}%`, width: `${width(r.desde, r.hasta)}%` }} />
        ))}
        {h.huecos.map(g => (
          <div key={g.desde} title={`Sin cargar: ${fmtDate(g.desde)} – ${fmtDate(g.hasta)} (${g.dias} días)`}
            className="absolute top-0 h-full bg-red-500"
            style={{ left: `${pos(g.desde)}%`, width: `${width(g.desde, g.hasta)}%` }} />
        ))}
      </div>
    </div>
  )
}

export function CoveragePanel() {
  const [data, setData] = useState<AptCoverage | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const load = () => aptApi.coverage().then(d => { setData(d); setError(null) }).catch(e => setError(e instanceof Error ? e.message : 'No disponible'))
    load()
    window.addEventListener('apt:updated', load)
    return () => window.removeEventListener('apt:updated', load)
  }, [])
  if (error) return null
  const kinds = data ? kindsOf(data) : []
  const dates = data ? kinds.flatMap(k => [data.hojas[k]?.desde, data.hojas[k]?.hasta]).filter((d): d is string => !!d) : []
  const min = dates.length ? Math.min(...dates.map(d => Date.parse(d) / 86400000)) : 0
  const max = dates.length ? Math.max(...dates.map(d => Date.parse(d) / 86400000)) : 0
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div>
          <h3 className="text-sm font-bold text-slate-800">Secuencia de fechas cargadas</h3>
          <p className="mt-0.5 text-xs text-slate-500">Las cargas se suman: cada una reemplaza solo sus fechas. En rojo, fechas que faltan cargar.</p>
        </div>
        {data && (
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${data.secuencia_ok ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
            {data.secuencia_ok ? 'Secuencia completa' : 'Secuencia incompleta'}
          </span>
        )}
      </header>
      <div className="space-y-4 p-4">
        {!data ? <p className="text-xs text-slate-400">Cargando…</p> : (
          <>
            {dates.length > 0 && (
              <div className="space-y-3">
                {kinds.map(k => (
                  <Timeline key={k} k={k} label={labelOf(data, k)} h={data.hojas[k] as AptCoverageSheet} min={min} max={max} />
                ))}
              </div>
            )}
            <CoverageAlerts coverage={data} />
          </>
        )}
      </div>
    </section>
  )
}
