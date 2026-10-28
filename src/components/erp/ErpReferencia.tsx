'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2, Database, XCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fmtN, fmtQty } from '@/lib/inventario/format'
import { fmtDate, fmtDateTime, fmtPct } from '@/lib/apt/format'

// Referencia del ERP (Actualizable y Stock vigentes) para Operaciones. Solo lectura: no crea ni cambia registros del
// TMS. Usa el cruce exacto (sin conversiones de unidad; las filas con cantidades ausentes no entran en las sumas). Si el
// usuario no tiene acceso o aún no hay carga del ERP, no se muestra nada que interrumpa la operación.
const supabase = createClient()

type Cortes = Partial<Record<'CONTRATOS' | 'STOCK', string | null>>
export interface ErpRefGrupo { tipo_documento: string | null; unidad: string; filas: number; validas: number; incompletas: number; documentos: number
  contratado: number | null; despachado: number | null; pendiente: number | null; avance: number | null; stock_coincidente: number | null; cobertura: number | null }
export interface ErpRefGuia { guia: string; documentos: string | null; items: number; cantidad: number; fecha_erp: string | null; fecha_erp_exacta: boolean | null
  rutas: string | null; placas: string | null; fecha_tms: string | null }
export interface ErpRefOt { success: true; sin_datos?: boolean; ot: string; documento: string | null; en_erp: boolean; cortes: Cortes; cliente: string | null; ruc: string | null
  grupos: ErpRefGrupo[]; documentos: Array<{ documento: string; tipo_documento: string | null; unidad: string; productos: number; incompleto: boolean
    contratado: number | null; despachado: number | null; pendiente: number | null; stock_coincidente: number | null; bodegas: string | null; fecha_vcto: string | null }>
  guias_total: number; guias_con_ruta: number; guias: ErpRefGuia[] }
export interface ErpRefGuiaCheck { entrada: string; guia: string | null; en_erp: boolean; ots: string | null; documentos: string | null; items: number | null
  cantidad: number | null; cliente: string | null; fecha_erp: string | null; fecha_erp_exacta: boolean | null; ot_distinta: boolean }
export interface ErpRefResumen { success: true; sin_datos?: boolean; desde: string; hasta: string; tolerancia: number; cortes: Cortes
  resumen: { total: number; ambos: number; solo_erp: number; solo_tms: number; desfase: number }
  solo_erp: Array<{ guia: string; ots: string | null; cliente: string | null; fecha_erp: string | null; fecha_erp_exacta: boolean | null }>
  solo_tms: Array<{ guia: string; ot_tms: string | null; rutas: string | null; placas: string | null; fecha_tms: string | null }>
  desfase: Array<{ guia: string; ots: string | null; rutas: string | null; fecha_erp: string | null; fecha_tms: string | null; dif_dias: number }> }

// null = sin acceso o error (no se muestra); PENDIENTE = la base aún no tiene la función (migración sin aplicar: se
// avisa en vez de ocultar); las respuestas se reutilizan durante la sesión de la pantalla
const PENDIENTE = { pendiente: true } as const
const isPendiente = (d: unknown): d is typeof PENDIENTE => d === PENDIENTE
const cache = new Map<string, Promise<unknown>>()
function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T | typeof PENDIENTE | null> {
  const key = `${fn}|${JSON.stringify(args)}`
  if (!cache.has(key)) {
    cache.set(key, Promise.resolve(supabase.rpc(fn, args)).then(({ data, error }) => {
      const out = data as { success?: boolean } | null
      if (error && (error.code === 'PGRST202' || error.code === '42883')) return PENDIENTE
      if (error || !out || out.success === false) { cache.delete(key); return null }
      return out
    }, () => { cache.delete(key); return null }))
  }
  return cache.get(key) as Promise<T | typeof PENDIENTE | null>
}
function useRpc<T>(fn: string, args: Record<string, unknown> | null) {
  const key = args ? JSON.stringify(args) : ''
  const [state, setState] = useState<{ key: string; data: T | typeof PENDIENTE | null; loading: boolean }>({ key: '', data: null, loading: false })
  useEffect(() => {
    if (!key) return
    let alive = true
    rpc<T>(fn, JSON.parse(key)).then(data => { if (alive) setState({ key, data, loading: false }) })
    return () => { alive = false }
  }, [fn, key])
  return state.key === key ? state : { key, data: null, loading: !!key }
}

const ratio = (v: number | null | undefined) => v == null ? '—' : fmtPct(Number(v) * 100)
const corte = (c?: Cortes) => c?.CONTRATOS ? `corte ERP ${fmtDateTime(c.CONTRATOS)}` : 'sin corte'

// Aviso visible cuando la función aún no está instalada en la base (p. ej. vista previa antes de aplicar la migración)
function Pendiente({ title }: { title: string }) {
  return <Shell title={title}><p className="font-semibold text-indigo-900">Referencia del ERP pendiente de activar: la base aún no tiene esta consulta
    (se activa al aplicar la migración del despliegue). Este recuadro mostrará aquí los datos del ERP.</p></Shell>
}

function Shell({ children, title, sub }: { children: React.ReactNode; title: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-3 text-xs text-slate-700">
      <p className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-bold text-indigo-900"><Database className="h-3.5 w-3.5" aria-hidden="true" />{title}
        <span className="font-normal text-indigo-800/80">· referencia del ERP, solo lectura{sub ? ` · ${sub}` : ''}</span></p>
      {children}
    </div>
  )
}

// OT (o subcontrato) en el ERP: pendiente por tipo de documento y unidad, stock coincidente y guías con su ruta en el TMS
export function ErpOtReferencia({ ot, compact = false }: { ot: string | null | undefined; compact?: boolean }) {
  const { data, loading } = useRpc<ErpRefOt>('erp_ref_ot', ot ? { p_ot: ot } : null)
  if (!ot) return null
  if (loading) return <p className="text-xs text-slate-400">Consultando el ERP…</p>
  if (!data) return null
  if (isPendiente(data)) return <Pendiente title={`OT ${ot}`} />
  if (data.sin_datos) return <p className="text-xs text-slate-500">Aún no hay carga del Actualizable del ERP.</p>
  if (!data.en_erp) return <Shell title={`OT ${data.ot}`} sub={corte(data.cortes)}><p className="font-semibold text-amber-800">La OT no está en el Actualizable vigente.</p></Shell>
  const incompletas = data.grupos.reduce((s, g) => s + g.incompletas, 0)
  return (
    <Shell title={`OT ${data.ot}${data.documento ? ` · ${data.documento}` : ''}`} sub={corte(data.cortes)}>
      {data.cliente && <p className="mb-1.5 text-slate-600">{data.cliente}{data.ruc ? ` · RUC ${data.ruc}` : ''}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead className="text-[10px] uppercase tracking-wide text-slate-500"><tr><th className="py-1 pr-2">Tipo · unidad</th><th className="py-1 pr-2 text-right">Contratado</th>
            <th className="py-1 pr-2 text-right">Despachado</th><th className="py-1 pr-2 text-right">Pendiente</th><th className="py-1 pr-2 text-right">Avance</th>
            <th className="py-1 pr-2 text-right">Stock coincidente</th><th className="py-1 text-right">Cobertura</th></tr></thead>
          <tbody>
            {data.grupos.map(g => <tr key={`${g.tipo_documento}|${g.unidad}`} className="border-t border-indigo-100">
              <td className="py-1 pr-2">{g.tipo_documento ?? '—'} · <b>{g.unidad}</b>{g.incompletas > 0 && <span className="ml-1 font-semibold text-amber-700" title="Filas con cantidades ausentes: fuera de las sumas y porcentajes">parcial</span>}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{g.validas ? fmtQty(g.contratado) : 's/d'}</td><td className="py-1 pr-2 text-right tabular-nums">{g.validas ? fmtQty(g.despachado) : 's/d'}</td>
              <td className="py-1 pr-2 text-right font-semibold tabular-nums">{g.validas ? fmtQty(g.pendiente) : 's/d'}</td><td className="py-1 pr-2 text-right tabular-nums">{ratio(g.avance)}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{g.stock_coincidente == null ? '—' : fmtQty(g.stock_coincidente)}</td><td className="py-1 text-right tabular-nums">{ratio(g.cobertura)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[11px] text-slate-500">Tipos y unidades no se suman entre sí. «—» en stock = sin coincidencia exacta (lote = documento, mismo producto y unidad).
        {incompletas > 0 && ` ${incompletas} fila(s) con cantidades ausentes fuera de las sumas.`}</p>
      <p className="mt-1.5"><b>{fmtN(data.guias_total)}</b> guía(s) del ERP · <b>{fmtN(data.guias_con_ruta)}</b> con ruta en el TMS
        {data.guias_total > data.guias_con_ruta && <span className="font-semibold text-amber-800"> · {fmtN(data.guias_total - data.guias_con_ruta)} sin ruta</span>}</p>
      {!compact && data.guias.length > 0 && <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
        {data.guias.slice(0, 15).map(g => <li key={g.guia} className="flex flex-wrap gap-x-2">
          <b>{g.guia}</b><span>{fmtDate(g.fecha_erp)}{g.fecha_erp_exacta === false && ' (aprox.)'}</span><span className="text-slate-500">{g.documentos}</span>
          <span className="text-slate-500">{fmtQty(g.cantidad)}</span>
          {g.rutas ? <span className="text-emerald-700">ruta {g.rutas}{g.fecha_tms ? ` · ${fmtDate(g.fecha_tms)}` : ''}</span> : <span className="text-amber-700">sin ruta en el TMS</span>}
        </li>)}
      </ul>}
    </Shell>
  )
}

// Hasta qué hora es la foto de stock del ERP que se consulta al programar. Sin caché: se pide cada vez que se monta,
// para que una carga nueva del Excel se vea al reabrir la ruta.
type StockCorte = { success: true; cut_at: string | null; applied_at: string | null; horas: number | null; max_horas: number; estado: 'VIGENTE' | 'DESACTUALIZADO' | 'SIN_CARGA' }
export function ErpStockCorteAviso() {
  const [data, setData] = useState<StockCorte | null>(null)
  useEffect(() => {
    let alive = true
    Promise.resolve(supabase.rpc('erp_stock_corte')).then(({ data: out, error }) => {
      if (alive && !error && (out as { success?: boolean } | null)?.success) setData(out as StockCorte)
    }, () => {})
    return () => { alive = false }
  }, [])
  if (!data) return null
  const hace = data.horas == null ? '' : data.horas < 1 ? ' (hace menos de 1 h)' : data.horas < 48 ? ` (hace ${Math.round(data.horas)} h)` : ` (hace ${Math.round(data.horas / 24 * 10) / 10} días)`
  const [tone, Icon, text] = data.estado === 'SIN_CARGA'
    ? ['border-red-200 bg-red-50 text-red-800', XCircle, 'Sin foto de stock del ERP: el stock de las OT no está disponible.'] as const
    : data.estado === 'DESACTUALIZADO'
      ? ['border-amber-200 bg-amber-50 text-amber-900', AlertTriangle, `Stock del ERP al ${data.cut_at ? fmtDateTime(data.cut_at) : '—'}${hace}: supera ${data.max_horas} h, cargue el Excel «Stock Bodega Despacho» antes de confirmar cantidades.`] as const
      : ['border-emerald-200 bg-emerald-50 text-emerald-900', CheckCircle2, `Stock del ERP al ${data.cut_at ? fmtDateTime(data.cut_at) : '—'}${hace}. Lo despachado después de esa hora no se refleja.`] as const
  return (
    <p role="status" className={`mb-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs font-semibold ${tone}`}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{text}
    </p>
  )
}

// Una línea por OT para listas (p. ej. paradas de una ruta)
export function ErpOtLinea({ ot }: { ot: string | null | undefined }) {
  const { data } = useRpc<ErpRefOt>('erp_ref_ot', ot ? { p_ot: ot } : null)
  if (!ot || !data) return null
  if (isPendiente(data)) return <span className="inline-flex items-center gap-1 text-[11px] text-indigo-800"><Database className="h-3 w-3" aria-hidden="true" />Referencia del ERP pendiente de activar</span>
  if (data.sin_datos) return null
  if (!data.en_erp) return <span className="inline-flex items-center gap-1 text-[11px] text-amber-700"><Database className="h-3 w-3" aria-hidden="true" />OT no está en el ERP</span>
  const pend = data.grupos.filter(g => g.validas && (g.pendiente ?? 0) > 0)
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 text-[11px] text-indigo-800" title={`Referencia del ERP (${corte(data.cortes)}), solo lectura`}>
      <Database className="h-3 w-3" aria-hidden="true" />
      {pend.length ? pend.map(g => <span key={`${g.tipo_documento}|${g.unidad}`}>pend. {fmtQty(g.pendiente)} {g.unidad}{g.stock_coincidente != null ? ` · stock ${fmtQty(g.stock_coincidente)}` : ''}{(g.tipo_documento ?? '').startsWith('CONTRATO') ? '' : ` (${(g.tipo_documento ?? '').toLowerCase()})`}
        {g.cobertura != null && g.cobertura < 1 && <b className="ml-1 text-amber-700" title={`Stock del ERP (${data.cortes.STOCK ? `corte ${fmtDateTime(data.cortes.STOCK)}` : 'sin corte'}) menor al pendiente`}>stock cubre {ratio(g.cobertura)}</b>}
        {g.stock_coincidente == null && <b className="ml-1 text-red-700" title="Sin stock coincidente en la foto del ERP (lote = documento, mismo producto y unidad)">sin stock</b>}</span>)
        : <span>sin pendiente en el ERP</span>}
      {data.guias_total > data.guias_con_ruta && <span className="text-amber-700">{fmtN(data.guias_total - data.guias_con_ruta)} guía(s) ERP sin ruta</span>}
    </span>
  )
}

// Guías escritas en el TMS frente al ERP: existe, OT distinta o no está
export function ErpGuiasValidacion({ guias, ot }: { guias: Array<string | null | undefined>; ot?: string | null }) {
  // Un campo puede traer varias guías (separadas por coma, punto y coma, barra o espacio), igual que en el cruce del ERP
  const list = [...new Set(guias.flatMap(g => (g ?? '').split(/[,;/\s·]+/)).map(g => g.trim()).filter(Boolean))].sort()
  const { data } = useRpc<{ success: true; sin_datos?: boolean; cortes: Cortes; guias: ErpRefGuiaCheck[] }>('erp_ref_guias', list.length ? { p_guias: list, p_ot: ot ?? null } : null)
  if (!list.length || !data) return null
  if (isPendiente(data)) return <p className="text-[11px] font-semibold text-indigo-800">Validación de guías contra el ERP pendiente de activar ({list.join(', ')}).</p>
  if (data.sin_datos) return null
  return (
    <div className="flex flex-wrap gap-1.5 text-[11px]" aria-label="Guías frente al ERP">
      {data.guias.map(g => !g.en_erp
        ? <span key={g.entrada} className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 font-semibold text-red-700 ring-1 ring-red-200" title={`No está en el Actualizable vigente (${corte(data.cortes)}). Revise si está mal digitada o aún no se emite.`}>
            <XCircle className="h-3 w-3" aria-hidden="true" />{g.entrada}: no está en el ERP</span>
        : g.ot_distinta
          ? <span key={g.entrada} className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 font-semibold text-amber-800 ring-1 ring-amber-200" title={`En el ERP pertenece a ${g.documentos}`}>
              <AlertTriangle className="h-3 w-3" aria-hidden="true" />{g.guia}: en el ERP es de la OT {g.ots}</span>
          : <span key={g.entrada} className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 font-semibold text-emerald-800 ring-1 ring-emerald-200"
              title={`${g.documentos} · ${g.items} ítem(s) · ${fmtQty(g.cantidad)} · ${g.cliente ?? ''}${g.fecha_erp_exacta === false ? ' · fecha aproximada' : ''}`}>
              <CheckCircle2 className="h-3 w-3" aria-hidden="true" />{g.guia} · ERP {fmtDate(g.fecha_erp)}</span>)}
    </div>
  )
}

// Torre de Control: guías del ERP sin ruta en el TMS, guías del TMS que el ERP no muestra y desfases de fecha
export function ErpGuiasResumenCard({ dias = 7, canOpenErp = false }: { dias?: number; canOpenErp?: boolean }) {
  const [hasta] = useState(() => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' }))
  const desde = new Date(new Date(`${hasta}T12:00:00`).getTime() - dias * 86400000).toISOString().slice(0, 10)
  const { data } = useRpc<ErpRefResumen>('erp_ref_guias_resumen', { p: { desde, hasta, limit: 8 } })
  const [open, setOpen] = useState<'solo_erp' | 'solo_tms' | 'desfase' | null>(null)
  if (!data) return null
  if (isPendiente(data)) return <Pendiente title="Guías ERP vs TMS" />
  if (data.sin_datos) return null
  const r = data.resumen
  const items = [
    ['solo_erp', 'Guías del ERP sin ruta en el TMS', r.solo_erp, 'text-amber-800'],
    ['solo_tms', 'Guías en rutas que el ERP no muestra', r.solo_tms, 'text-red-700'],
    ['desfase', `Fecha ERP y TMS con más de ${data.tolerancia} días de diferencia`, r.desfase, 'text-amber-800'],
  ] as const
  return (
    <Shell title={`Guías ERP vs TMS · ${fmtDate(data.desde)} al ${fmtDate(data.hasta)}`} sub={corte(data.cortes)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-lg bg-white px-2 py-1 ring-1 ring-indigo-100"><b className="text-emerald-700">{fmtN(r.ambos)}</b> en ERP y TMS</span>
        {items.map(([k, label, n, tone]) => <button key={k} type="button" onClick={() => setOpen(open === k ? null : k)} aria-pressed={open === k} disabled={!n}
          className={`rounded-lg bg-white px-2 py-1 text-left ring-1 ring-indigo-100 hover:bg-indigo-50 disabled:opacity-60 ${open === k ? 'ring-2 ring-indigo-400' : ''}`}><b className={tone}>{fmtN(n)}</b> {label}</button>)}
        {canOpenErp && <Link href="/apt/erp" className="ml-auto font-semibold text-indigo-800 underline">Ver en ERP: OT, guías y stock</Link>}
      </div>
      {open && <ul className="mt-2 space-y-0.5">
        {open === 'solo_erp' && data.solo_erp.map(g => <li key={g.guia}><b>{g.guia}</b> · OT {g.ots} · {g.cliente} · ERP {fmtDate(g.fecha_erp)}</li>)}
        {open === 'solo_tms' && data.solo_tms.map(g => <li key={g.guia}><b>{g.guia}</b> · OT {g.ot_tms ?? '—'} · ruta {g.rutas} · {g.placas} · {fmtDate(g.fecha_tms)}</li>)}
        {open === 'desfase' && data.desfase.map(g => <li key={g.guia}><b>{g.guia}</b> · OT {g.ots} · ruta {g.rutas} · ERP {fmtDate(g.fecha_erp)} · TMS {fmtDate(g.fecha_tms)} ({g.dif_dias > 0 ? '+' : ''}{g.dif_dias} d)</li>)}
        {(data[open] as unknown[]).length < (open === 'solo_erp' ? r.solo_erp : open === 'solo_tms' ? r.solo_tms : r.desfase) && <li className="text-slate-500">Se muestran las más recientes.</li>}
      </ul>}
    </Shell>
  )
}
