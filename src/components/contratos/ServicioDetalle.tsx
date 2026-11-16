'use client'

import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, Database, FileText, Lock } from 'lucide-react'
import { useErpOt, type ErpRefGrupo } from '@/components/erp/ErpReferencia'
import { fmtN, fmtQty } from '@/lib/inventario/format'
import { fmtDate, fmtDateTime, fmtPct } from '@/lib/apt/format'

// Piezas de presentación del modal «Detalles del Servicio Registrado». Solo muestran datos: no cambian registros.

export function DetailSection({ n, title, icon, aside, sub, children, muted = false }: {
  n: string; title: string; icon: ReactNode; aside?: ReactNode; sub?: ReactNode; children: ReactNode; muted?: boolean
}) {
  return (
    <section className={`min-w-0 rounded-xl border border-jrm-line shadow-jrm-card ${muted ? 'bg-slate-50/60' : 'bg-white'}`}>
      <header className="border-b border-jrm-line px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-bold text-jrm-navy">
            <span aria-hidden className="text-jrm-navy/70 [&>svg]:h-4 [&>svg]:w-4">{icon}</span>{n} · {title}
          </h3>
          {aside}
        </div>
        {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}

const TILE_TONES = {
  navy: 'border-jrm-line bg-white', success: 'border-emerald-200 bg-emerald-50/60', warning: 'border-amber-200 bg-amber-50/60',
  danger: 'border-rose-200 bg-rose-50/60', neutral: 'border-jrm-line bg-slate-50',
} as const
export type TileTone = keyof typeof TILE_TONES

export function StatTile({ icon, label, value, sub, tone = 'navy', strong = false, title }: {
  icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode; tone?: TileTone; strong?: boolean; title?: string
}) {
  return (
    <div title={title} className={`min-w-0 rounded-xl border px-3 py-3 shadow-jrm-card ${TILE_TONES[tone]}`}>
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
        <span aria-hidden className="shrink-0 text-jrm-navy/70 [&>svg]:h-4 [&>svg]:w-4">{icon}</span>{label}
      </p>
      <div className={`mt-1 break-words font-bold leading-tight text-slate-900 ${strong ? 'text-xl text-jrm-navy' : 'text-base'}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  )
}

export function InfoRow({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[1.25rem_7rem_1fr] items-start gap-2 py-1.5">
      <span aria-hidden className="mt-0.5 text-slate-400 [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
      <span className="text-xs text-slate-500">{label}</span>
      <span className="min-w-0 break-words text-sm font-semibold text-slate-900">{children}</span>
    </div>
  )
}

const pct = (v: number | null | undefined) => v == null ? '—' : fmtPct(Number(v) * 100)

function Indicador({ n, label, tone }: { n: number; label: ReactNode; tone: 'navy' | 'success' | 'warning' }) {
  const c = { navy: 'border-blue-100 bg-blue-50/60 text-jrm-navy', success: 'border-emerald-200 bg-emerald-50/60 text-emerald-700', warning: 'border-amber-200 bg-amber-50/60 text-amber-700' }[tone]
  return <div className={`rounded-lg border px-2 py-2 text-center ${c}`}><p className="text-xl font-bold tabular-nums">{fmtN(n)}</p><p className="text-[11px] font-medium text-slate-600">{label}</p></div>
}

/** 02 · Guías y trazabilidad: guías del servicio (children) y guías de la OT en el ERP con su ruta en el TMS. */
export function GuiasTrazabilidad({ ot, onGuia, children }: { ot: string | null | undefined; onGuia: (guia: string) => void; children: ReactNode }) {
  const { data, pendiente, loading } = useErpOt(ot)
  const sinRuta = data?.en_erp ? data.guias_total - data.guias_con_ruta : 0
  return (
    <DetailSection n="02" title="Guías y trazabilidad" icon={<FileText />}
      aside={sinRuta > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-200"><AlertTriangle className="h-3 w-3" aria-hidden />{fmtN(sinRuta)} sin ruta</span>}>
      <div className="space-y-3">
        {children}
        {!ot ? null : loading ? <p className="text-xs text-slate-400">Consultando el ERP…</p>
          : pendiente ? <p className="text-xs font-semibold text-indigo-800">Referencia del ERP pendiente de activar (se activa al aplicar la migración del despliegue).</p>
          : !data ? null
          : data.sin_datos ? <p className="text-xs text-slate-500">Aún no hay carga del Actualizable del ERP.</p>
          : !data.en_erp ? <p className="text-xs font-semibold text-amber-800">La OT no está en el Actualizable vigente del ERP.</p>
          : <>
            <div className="grid grid-cols-3 gap-2">
              <Indicador n={data.guias_total} label="Guías ERP" tone="navy" />
              <Indicador n={data.guias_con_ruta} label={<span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-emerald-600" aria-hidden />Con ruta TMS</span>} tone="success" />
              <Indicador n={sinRuta} label={<span className="inline-flex items-center gap-1"><AlertTriangle className="h-3 w-3 text-amber-600" aria-hidden />Sin ruta TMS</span>} tone={sinRuta ? 'warning' : 'success'} />
            </div>
            {data.guias.length > 0 && <div className="max-h-72 overflow-auto rounded-lg border border-jrm-line">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                  <tr><th className="px-3 py-2 font-semibold">Guía de remisión</th><th className="px-3 py-2 font-semibold">Fecha ERP</th><th className="px-3 py-2 font-semibold">Trazabilidad (TMS)</th></tr>
                </thead>
                <tbody>
                  {data.guias.map(g => <tr key={g.guia} className="border-t border-slate-100">
                    <td className="px-3 py-1.5">
                      <button type="button" onClick={() => onGuia(g.guia)} title="Ver los SKUs de la guía" className="font-semibold text-blue-700 hover:underline">{g.guia}</button>
                      <span className="block text-[11px] text-slate-500">{[g.documentos, fmtQty(g.cantidad)].filter(Boolean).join(' · ')}</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 tabular-nums text-slate-700">{fmtDate(g.fecha_erp)}{g.fecha_erp_exacta === false && <span className="text-slate-400"> (aprox.)</span>}</td>
                    <td className="px-3 py-1.5">{g.rutas
                      ? <span title={g.fecha_tms ? `TMS ${fmtDate(g.fecha_tms)}${g.placas ? ` · ${g.placas}` : ''}` : g.placas ?? undefined} className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-200"><CheckCircle2 className="h-3 w-3" aria-hidden />Ruta {g.rutas}</span>
                      : <span title="Diferencia de trazabilidad: la guía está en el ERP pero no en una ruta del TMS" className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-200"><AlertTriangle className="h-3 w-3" aria-hidden />Sin ruta en TMS</span>}</td>
                  </tr>)}
                </tbody>
              </table>
            </div>}
            {data.guias.length < data.guias_total && <p className="text-[11px] text-slate-500">Se muestran {fmtN(data.guias.length)} de {fmtN(data.guias_total)} guías.</p>}
          </>}
      </div>
    </DetailSection>
  )
}

const tipo = (g: ErpRefGrupo) => g.tipo_documento ? g.tipo_documento.charAt(0) + g.tipo_documento.slice(1).toLocaleLowerCase('es-PE') : '—'
const cantidad = (g: ErpRefGrupo, v: number | null) => g.validas ? fmtQty(v) : 's/d'

/** 03 · Situación contractual ERP: referencia de solo lectura. Cada tipo·unidad va aparte; GLB y UND nunca se suman. */
export function SituacionContractualErp({ ot }: { ot: string | null | undefined }) {
  const { data, pendiente, loading } = useErpOt(ot)
  const ok = data && !data.sin_datos && data.en_erp ? data : null
  const conAvance = ok ? ok.grupos.filter(g => g.validas && (g.avance ?? 0) > 0) : []
  const incompletas = ok ? ok.grupos.reduce((s, g) => s + g.incompletas, 0) : 0
  return (
    <DetailSection n="03" title="Situación contractual ERP" icon={<Database />} muted
      aside={<span className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-jrm-navy ring-1 ring-blue-200"><Lock className="h-3 w-3" aria-hidden />Solo lectura</span>}
      sub={data && !data.sin_datos && <>Corte ERP: <b className="text-slate-700">{data.cortes.CONTRATOS ? fmtDateTime(data.cortes.CONTRATOS) : 'sin corte'}</b>
        {ok && (ok.documento || ok.cliente) && <span className="block">{[ok.documento, ok.cliente, ok.ruc && `RUC ${ok.ruc}`].filter(Boolean).join(' · ')}</span>}</>}>
      {!ot ? <p className="text-xs text-slate-500">El servicio no tiene OT.</p>
        : loading ? <p className="text-xs text-slate-400">Consultando el ERP…</p>
        : pendiente ? <p className="text-xs font-semibold text-indigo-800">Referencia del ERP pendiente de activar (se activa al aplicar la migración del despliegue).</p>
        : !data ? <p className="text-xs text-slate-500">Sin acceso a la referencia del ERP.</p>
        : data.sin_datos ? <p className="text-xs text-slate-500">Aún no hay carga del Actualizable del ERP.</p>
        : !ok ? <p className="text-xs font-semibold text-amber-800">La OT no está en el Actualizable vigente.</p>
        : <div className="space-y-3">
          {conAvance.map(g => {
            const p = Math.min(100, Math.max(0, Number(g.avance) * 100))
            return (
              <div key={`${g.tipo_documento}|${g.unidad}`} className="rounded-lg border border-jrm-line bg-white p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-bold text-slate-800">{tipo(g)} · {g.unidad}
                    {g.incompletas > 0 && <span className="ml-1 text-xs font-semibold text-amber-700" title="Filas con cantidades ausentes: fuera de las sumas y porcentajes">parcial</span>}</p>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${p >= 100 ? 'bg-emerald-50 text-emerald-800 ring-emerald-200' : 'bg-blue-50 text-jrm-navy ring-blue-200'}`}>{pct(g.avance)} avance</span>
                </div>
                <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <div><dt className="text-slate-500">Contratado</dt><dd className="text-sm font-bold tabular-nums text-slate-900">{cantidad(g, g.contratado)}</dd></div>
                  <div><dt className="text-slate-500">Pendiente</dt><dd className="text-sm font-bold tabular-nums text-slate-900">{cantidad(g, g.pendiente)}</dd></div>
                  <div><dt className="text-slate-500">Stock coincidente</dt><dd className="text-sm font-bold tabular-nums text-slate-900">{g.stock_coincidente == null ? '—' : fmtQty(g.stock_coincidente)}</dd></div>
                </dl>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100} aria-label={`Avance ${g.tipo_documento ?? ''} ${g.unidad}`}>
                  <div className="h-full rounded-full bg-sky-600" style={{ width: `${p}%` }} />
                </div>
              </div>
            )
          })}
          {ok.grupos.length > 0 && <details open={conAvance.length === 0} className="group rounded-lg border border-blue-100 bg-white">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-semibold text-jrm-navy hover:bg-blue-50/60 [&::-webkit-details-marker]:hidden">
              <ChevronDown className="h-4 w-4 -rotate-90 transition-transform group-open:rotate-0" aria-hidden />Ver detalle contractual ({fmtN(ok.grupos.length)} registros)
            </summary>
            <div className="overflow-x-auto border-t border-blue-100">
              <table className="w-full text-left text-[11px]">
                <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500"><tr><th className="px-1.5 py-1.5">Tipo · unidad</th><th className="px-1.5 py-1.5 text-right">Contratado</th>
                  <th className="px-1.5 py-1.5 text-right">Despachado</th><th className="px-1.5 py-1.5 text-right">Pendiente</th><th className="px-1.5 py-1.5 text-right">Avance</th>
                  <th className="px-1.5 py-1.5 text-right">Stock</th><th className="px-1.5 py-1.5 text-right">Cobertura</th></tr></thead>
                <tbody>
                  {ok.grupos.map(g => <tr key={`${g.tipo_documento}|${g.unidad}`} className="border-t border-slate-100">
                    <td className="whitespace-nowrap px-1.5 py-1.5">{tipo(g)} · <b>{g.unidad}</b>{g.incompletas > 0 && <span className="ml-1 font-semibold text-amber-700" title="Filas con cantidades ausentes: fuera de las sumas y porcentajes">parcial</span>}</td>
                    <td className="px-1.5 py-1.5 text-right tabular-nums">{cantidad(g, g.contratado)}</td><td className="px-1.5 py-1.5 text-right tabular-nums">{cantidad(g, g.despachado)}</td>
                    <td className="px-1.5 py-1.5 text-right font-semibold tabular-nums">{cantidad(g, g.pendiente)}</td><td className="px-1.5 py-1.5 text-right tabular-nums">{pct(g.avance)}</td>
                    <td className="px-1.5 py-1.5 text-right tabular-nums">{g.stock_coincidente == null ? '—' : fmtQty(g.stock_coincidente)}</td><td className="px-1.5 py-1.5 text-right tabular-nums">{pct(g.cobertura)}</td>
                  </tr>)}
                </tbody>
              </table>
              <p className="px-3 py-2 text-[11px] text-slate-500">Tipos y unidades no se suman entre sí. «—» en stock = sin coincidencia exacta (lote = documento, mismo producto y unidad).
                {incompletas > 0 && ` ${incompletas} fila(s) con cantidades ausentes fuera de las sumas.`}</p>
            </div>
          </details>}
        </div>}
    </DetailSection>
  )
}
