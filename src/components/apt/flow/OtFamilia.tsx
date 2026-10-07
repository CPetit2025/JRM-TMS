'use client'
import { DataTable } from '@/components/ui/data-table'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { AlertTriangle, BookOpenCheck, GitBranch, Link2, Network } from 'lucide-react'
import { fmtDate, fmtDias, fmtInt, fmtTn } from '@/lib/apt/format'
import { exportAptXlsx } from '@/lib/apt/export'
import { ALMACEN_COLOR, FLOW_ALMACENES } from '@/lib/apt/flowColors'
import {
  OT_ROL_LABEL, OT_VARIANTE_LABEL, OT_VARIANTE_SHORT, type OtFamilia, type OtMiembro, type OtVariante,
} from '@/lib/apt/flowTypes'
import { KpiCard } from '@/components/apt/ui'
import { ExportButton } from '@/components/apt/TfcShared'
import { short } from '@/components/apt/dashCharts'
import { SectionTitle, TraceLink } from './TrazaParts'

// Familia de una OT: todas sus vertientes (madre, subcontratos -S, errores -E, garantías -G, retornos D), los lotes con
// posible error de digitación y los lotes de otra raíz vinculados (adelantos, insumos, reasignaciones).

export const VARIANTE_STYLE: Record<OtVariante, string> = {
  MADRE: 'border-[#002855]/30 bg-[#002855]/5 text-[#002855]',
  SUBCONTRATO: 'border-sky-200 bg-sky-50 text-sky-700',
  ERROR: 'border-rose-200 bg-rose-50 text-rose-700',
  GARANTIA: 'border-violet-200 bg-violet-50 text-violet-700',
  DEVOLUCION: 'border-amber-200 bg-amber-50 text-amber-700',
  OTRO: 'border-slate-200 bg-slate-50 text-slate-600',
  SOSPECHOSO: 'border-orange-300 bg-orange-50 text-orange-700',
}

export function VarianteBadge({ v }: { v: OtVariante | null | undefined }) {
  if (!v) return null
  return <span className={`inline-flex whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-bold ${VARIANTE_STYLE[v]}`}>{OT_VARIANTE_SHORT[v]}</span>
}

export const kardexHref = (k: Record<string, unknown>, nivel = 'lote') =>
  `/apt/flujo/kardex?k=${encodeURIComponent(JSON.stringify(k))}&n=${nivel}`

function SaldoAlmacenes({ m }: { m: OtMiembro }) {
  const parts = FLOW_ALMACENES.filter(a => (m.saldo_almacen?.[a] || 0) >= 0.005)
  if (!parts.length) return <span className="text-slate-300">—</span>
  return (
    <span className="flex flex-wrap justify-end gap-1">
      {parts.map(a => (
        <span key={a} className="whitespace-nowrap rounded px-1 text-[10px] font-bold tabular-nums" style={{ color: ALMACEN_COLOR[a], background: `${ALMACEN_COLOR[a]}14` }}>
          {a} {fmtTn(m.saldo_almacen[a])}
        </span>
      ))}
    </span>
  )
}

// Franja compacta (Kardex y cabecera de un lote): totales de la familia y chips por vertiente
export function OtFamiliaStrip({ d, selected, onToggle, incluirSosp, onSosp, current, footer }: {
  d: OtFamilia
  selected?: OtVariante[]
  onToggle?: (v: OtVariante) => void
  incluirSosp?: boolean
  onSosp?: (v: boolean) => void
  current?: string
  footer?: ReactNode
}) {
  const r = d.resumen
  return (
    <section className="rounded-xl border border-[#002855]/20 bg-gradient-to-r from-[#002855]/[0.04] to-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex items-center gap-1.5 text-sm font-black text-[#002855]"><Network className="h-4 w-4" /> Familia OT {d.ot}</span>
        {r.cliente && <span className="max-w-md truncate text-xs text-slate-500" title={r.cliente}>{short(r.cliente, 60)}</span>}
        <span className="ml-auto flex flex-wrap gap-x-4 gap-y-1 text-[11px] tabular-nums text-slate-600">
          <span><b className="text-slate-800">{fmtInt(r.lotes)}</b> lotes</span>
          <span>Producción <b className="text-emerald-700">{fmtTn(r.produccion_tn)}</b> TN</span>
          {r.asignado_tn > 0.0005 && <span>Adelantos <b className="text-amber-700">{fmtTn(r.asignado_tn)}</b> TN</span>}
          <span>Despachado <b className="text-blue-700">{fmtTn(r.despacho_tn)}</b> TN · {fmtInt(r.guias)} guías</span>
          <span>Saldo <b className="text-[#002855]">{fmtTn(r.saldo_tn)}</b> TN</span>
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {d.grupos.filter(g => g.variante !== 'SOSPECHOSO').map(g => {
          const on = !selected?.length || selected.includes(g.variante)
          const Tag = onToggle ? 'button' : 'span'
          return (
            <Tag key={g.variante} type={onToggle ? 'button' : undefined} onClick={onToggle ? () => onToggle(g.variante) : undefined}
              title={onToggle ? 'Clic para filtrar solo esta vertiente (otro clic la quita)' : undefined}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold transition ${VARIANTE_STYLE[g.variante]} ${on ? '' : 'opacity-40'} ${onToggle ? 'hover:shadow-sm' : ''} ${selected?.includes(g.variante) ? 'ring-2 ring-[#002855]/30 ring-offset-1' : ''}`}>
              {OT_VARIANTE_LABEL[g.variante]}
              <span className="rounded-full bg-white/80 px-1.5 text-[10px] tabular-nums">{g.lotes}</span>
              <span className="font-semibold tabular-nums opacity-80">{fmtTn(g.saldo_tn)} TN saldo</span>
            </Tag>
          )
        })}
        {current && <span className="text-[11px] text-slate-500">· viendo <b className="font-mono">{current}</b></span>}
        {d.sospechosos.length > 0 && (
          onSosp ? (
            <label className="ml-auto inline-flex cursor-pointer items-center gap-2 rounded-full border border-orange-300 bg-orange-50 px-3 py-1 text-[11px] font-bold text-orange-700">
              <input type="checkbox" checked={!!incluirSosp} onChange={e => onSosp(e.target.checked)} className="h-3.5 w-3.5 accent-orange-600" />
              <AlertTriangle className="h-3.5 w-3.5" /> Incluir {d.sospechosos.length} lote{d.sospechosos.length > 1 ? 's' : ''} con posible error de digitación
              <span className="font-mono font-semibold">({d.sospechosos.map(s => s.lote).join(', ')})</span>
            </label>
          ) : (
            <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-orange-300 bg-orange-50 px-3 py-1 text-[11px] font-bold text-orange-700">
              <AlertTriangle className="h-3.5 w-3.5" /> {d.sospechosos.length} posible{d.sospechosos.length > 1 ? 's' : ''} error{d.sospechosos.length > 1 ? 'es' : ''} de digitación
            </span>
          )
        )}
      </div>
      {footer}
    </section>
  )
}

// Ficha completa (Trazabilidad al buscar una OT)
export function OtFamiliaFicha({ d }: { d: OtFamilia }) {
  const r = d.resumen
  const [verTodos, setVerTodos] = useState(false)
  const miembros = d.miembros.filter(m => m.variante !== 'SOSPECHOSO')
  const sosp = d.miembros.filter(m => m.variante === 'SOSPECHOSO')
  const vinc = verTodos ? d.vinculados : d.vinculados.slice(0, 12)

  const exportar = () => exportAptXlsx(`Familia_OT_${d.ot}`, {
    Lotes: d.miembros.map(m => ({
      Lote: m.lote, Vertiente: OT_VARIANTE_LABEL[m.variante], 'Parecido a': m.parecido_a, Cliente: m.cliente,
      'Producción TN': m.produccion_tn, 'Adelantos asignados TN': m.asignado_tn, 'Otros ingresos TN': m.otros_ingresos_tn,
      'Despachado TN': m.despacho_tn, Guías: m.guias, 'Consumo TN': m.consumo_tn, 'Pasado a otro lote TN': m.cedido_tn,
      'Saldo TN': m.saldo_tn, 'Saldo 647': m.saldo_almacen['647'], 'Saldo 540': m.saldo_almacen['540'], 'Saldo ST': m.saldo_almacen.ST,
      'Primera producción': m.primera_produccion, 'Última guía': m.ultima_guia, Movimientos: m.movimientos,
    })),
    Vinculados: d.vinculados.map(v => ({
      Lote: v.lote, Relación: v.roles.map(x => OT_ROL_LABEL[x]).join(' · '), 'TN': v.tn, 'Adelanto TN': v.adelanto_tn,
      'Insumo TN': v.insumo_tn, 'Reasignado TN': v.reasignado_tn, 'Lote de la OT': v.hacia, Descripción: v.glosa, Desde: v.desde, Hasta: v.hasta,
    })),
  })

  return (
    <div className="space-y-4">
      <OtFamiliaStrip d={d} footer={
        <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-200/70 pt-3">
          <Link href={kardexHref({ ot: d.ot })} className="inline-flex items-center gap-1.5 rounded-lg bg-[#002855] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#0b3d7a]">
            <BookOpenCheck className="h-3.5 w-3.5" /> Kardex de toda la familia
          </Link>
          {d.sospechosos.length > 0 && (
            <Link href={kardexHref({ ot: d.ot, incluir_sospechosos: true })} className="inline-flex items-center gap-1.5 rounded-lg border border-orange-300 bg-white px-3 py-1.5 text-xs font-bold text-orange-700 hover:bg-orange-50">
              Kardex incluyendo los de posible digitación
            </Link>
          )}
          <span className="ml-auto"><ExportButton onClick={exportar} /></span>
        </div>
      } />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Producción" value={fmtTn(r.produccion_tn)} unit="TN" tone="ok" hint={r.primera_produccion ? `Desde ${fmtDate(r.primera_produccion)}` : 'Sin ingresos de producción en el periodo'} />
        <KpiCard label="Adelantos asignados" value={fmtTn(r.asignado_tn)} unit="TN" hint="Material de otros lotes pasado a la OT por traspaso" />
        <KpiCard label="Despachado" value={fmtTn(r.despacho_tn)} unit="TN" tone="navy" hint={`${fmtInt(r.guias)} guías · última ${fmtDate(r.ultima_guia)}`} />
        <KpiCard label="Saldo APT" value={fmtTn(r.saldo_tn)} unit="TN" tone={r.saldo_tn > 0.0005 ? 'warn' : 'ok'} hint="647 + 540 + ST" />
        <KpiCard label="Producción → guía" value={fmtDias(r.dias_total)} unit="días" hint="Promedio ponderado por kg" />
        <KpiCard label="Por revisar" value={fmtInt(r.sospechosos)} tone={r.sospechosos ? 'crit' : 'ok'}
          hint={r.sospechosos ? `${fmtTn(r.sospechoso_tn)} TN en lotes con posible error de digitación` : 'Sin lotes mal digitados detectados'} />
      </div>

      {sosp.length > 0 && (
        <section className="rounded-xl border border-orange-300 bg-orange-50/70 p-4">
          <SectionTitle><span className="flex items-center gap-1.5 text-orange-800"><AlertTriangle className="h-4 w-4" /> Posibles errores de digitación</span></SectionTitle>
          <p className="mt-1 text-xs text-orange-900/80">Lotes cuya OT difiere en un dígito de la {d.ot}, con el mismo sufijo que un lote de esta familia y sin producción ni guías propias.
            No se suman a la familia; corríjalos en el ERP o inclúyalos en el kardex para revisarlos.</p>
          <ul className="mt-2 space-y-1">
            {sosp.map(m => (
              <li key={m.lote} className="flex flex-wrap items-center gap-2 text-xs">
                <TraceLink q={m.lote} /> <span className="text-slate-500">parece</span> <TraceLink q={m.parecido_a} />
                <span className="text-slate-500">· {fmtInt(m.movimientos)} mov. del {fmtDate(m.desde)} al {fmtDate(m.hasta)}</span>
                <span className="font-semibold tabular-nums text-orange-800">saldo {fmtTn(m.saldo_tn)} TN</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <header className="flex items-center gap-1.5 border-b border-slate-100 px-4 py-3 text-sm font-bold text-slate-800">
          <GitBranch className="h-4 w-4 text-[#002855]" /> Lotes de la OT <span className="text-xs font-normal text-slate-400">({miembros.length})</span>
        </header>
        <div className="overflow-x-auto">
          <DataTable className="w-full min-w-[1100px] text-xs">
            <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Lote</th>
                <th className="px-3 py-2 text-left">Vertiente</th>
                <th className="px-3 py-2 text-right">Producción</th>
                <th className="px-3 py-2 text-right">Adelantos</th>
                <th className="px-3 py-2 text-right">Despachado</th>
                <th className="px-3 py-2 text-right">Guías</th>
                <th className="px-3 py-2 text-right">Otras salidas</th>
                <th className="px-3 py-2 text-right">Saldo TN</th>
                <th className="px-3 py-2 text-right">Saldo por almacén</th>
                <th className="px-3 py-2 text-left">Producción / última guía</th>
                <th className="px-3 py-2 text-right">Kardex</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {miembros.map(m => (
                <tr key={m.lote} className="hover:bg-slate-50">
                  <td className="whitespace-nowrap px-3 py-1.5"><TraceLink q={m.lote} /></td>
                  <td className="px-3 py-1.5"><VarianteBadge v={m.variante} /></td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-emerald-700">{fmtTn(m.produccion_tn)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-amber-700">{m.asignado_tn > 0.0005 ? fmtTn(m.asignado_tn) : '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-blue-700">{fmtTn(m.despacho_tn)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtInt(m.guias)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-500"
                    title={`Consumo ${fmtTn(m.consumo_tn)} · a otro lote ${fmtTn(m.cedido_tn)} · a otros almacenes ${fmtTn(m.otro_almacen_tn)}`}>
                    {m.consumo_tn + m.cedido_tn + m.otro_almacen_tn > 0.0005 ? fmtTn(m.consumo_tn + m.cedido_tn + m.otro_almacen_tn) : '—'}
                  </td>
                  <td className={`px-3 py-1.5 text-right font-black tabular-nums ${m.saldo_tn > 0.0005 ? 'text-[#002855]' : 'text-slate-300'}`}>{fmtTn(m.saldo_tn)}</td>
                  <td className="px-3 py-1.5 text-right"><SaldoAlmacenes m={m} /></td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">{fmtDate(m.primera_produccion)} → {fmtDate(m.ultima_guia)}</td>
                  <td className="px-3 py-1.5 text-right">
                    <Link href={kardexHref({ lote_exacto: m.lote }, 'lote_producto')} className="font-semibold text-[#002855] hover:underline">Ver</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </div>
      </section>

      {d.vinculados.length > 0 && (
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <header className="border-b border-slate-100 px-4 py-3">
            <p className="flex items-center gap-1.5 text-sm font-bold text-slate-800"><Link2 className="h-4 w-4 text-amber-600" /> Lotes vinculados de otra numeración <span className="text-xs font-normal text-slate-400">({d.vinculados.length})</span></p>
            <p className="text-[11px] text-slate-500">Adelantos que se asignaron a la OT, insumos que consumió, material que pasó a otro lote o movimientos que el ERP marca con el contrato de la OT. No se suman a la familia.</p>
          </header>
          <div className="overflow-x-auto">
            <DataTable className="w-full min-w-[900px] text-xs">
              <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">Lote</th>
                  <th className="px-3 py-2 text-left">Relación</th>
                  <th className="px-3 py-2 text-left">Lote de la OT</th>
                  <th className="px-3 py-2 text-left">Descripción</th>
                  <th className="px-3 py-2 text-right">TN</th>
                  <th className="px-3 py-2 text-left">Fechas</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {vinc.map(v => (
                  <tr key={v.lote} className="hover:bg-slate-50">
                    <td className="whitespace-nowrap px-3 py-1.5"><TraceLink q={v.lote} /></td>
                    <td className="px-3 py-1.5">
                      <span className="flex flex-wrap gap-1">
                        {v.roles.filter(x => x !== 'REFERENCIA' || v.roles.length === 1).map(x => (
                          <span key={x} title={OT_ROL_LABEL[x]} className="whitespace-nowrap rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">
                            {x === 'ADELANTO' ? 'Adelanto' : x === 'INSUMO' ? 'Insumo' : x === 'REASIGNADO' ? 'Pasó a otro lote' : 'Referencia ERP'}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5">{v.hacia ? <TraceLink q={v.hacia} /> : '—'}</td>
                    <td className="max-w-[360px] truncate px-3 py-1.5 text-slate-600" title={v.glosa || ''}>{v.glosa || '—'}</td>
                    <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{fmtTn(v.tn)}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">{fmtDate(v.desde)}{v.hasta && v.hasta !== v.desde ? ` → ${fmtDate(v.hasta)}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
          {d.vinculados.length > 12 && (
            <button type="button" onClick={() => setVerTodos(x => !x)} className="w-full border-t border-slate-100 py-2 text-xs font-semibold text-[#002855] hover:bg-slate-50">
              {verTodos ? 'Ver menos' : `Ver los ${d.vinculados.length}`}
            </button>
          )}
        </section>
      )}
    </div>
  )
}
