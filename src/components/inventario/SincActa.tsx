'use client'

import { useRef } from 'react'
import { Printer } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { fmtDateTime } from '@/lib/apt/format'
import { SF_BODEGA, SINC_ESTADO, SINC_MOTIVO } from '@/lib/inventario/sinceramiento'
import type { InvSinc } from '@/lib/inventario/types'
import { imprimirHoja } from './imprimir'

const n3 = (v: number) => v.toLocaleString('es-PE', { maximumFractionDigits: 3 })

const Firma = ({ rol, accion, nombre, fecha }: { rol: string; accion: string; nombre: string | null; fecha: string | null }) =>
    <div className="flex-1 text-center text-[10px]">
      <div className="h-16" />
      <div className="border-t border-slate-800 pt-1 font-bold text-slate-900">{nombre ?? ' '}</div>
      <p className="font-semibold text-[#002855]">{rol}</p>
      <p className="text-slate-500">{accion}{fecha ? ` · registrado en el sistema el ${fmtDateTime(fecha)}` : ''}</p>
    </div>

/** Acta de sinceramiento con la plantilla corporativa (A4 vertical): es el sustento del movimiento al almacén virtual SF.
 *  Sin foto: lo verificado queda escrito y firmado por el Analista de Inventario y la Jefatura de Distribución. */
export function SincActa({ s, onClose }: { s: InvSinc; onClose: () => void }) {
  const hoja = useRef<HTMLDivElement>(null)
  const kg = s.lineas.reduce((t, l) => t + l.kg, 0)
  const borrador = s.estado === 'PROPUESTA' ? 'BORRADOR · POR AUTORIZAR' : s.estado === 'RECHAZADA' || s.estado === 'ANULADA' ? `SIN EFECTO · ${SINC_ESTADO[s.estado].label.toUpperCase()}` : null
  return <Modal isOpen onClose={onClose} title={`Acta ${s.numero}`} maxWidth="max-w-4xl"
    footer={<div className="flex justify-end gap-2">
      <button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold">Cerrar</button>
      <button type="button" onClick={() => imprimirHoja(hoja.current, `Acta ${s.numero}`, 'portrait')} className="flex min-h-10 items-center gap-2 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white"><Printer className="h-4 w-4" aria-hidden /> Imprimir</button>
    </div>}>
    <div className="max-h-[70vh] overflow-auto rounded-lg bg-slate-200 p-4">
      <div ref={hoja} className="relative mx-auto max-w-[190mm] bg-white p-6 text-slate-900 shadow-lg" style={{ fontFamily: 'Calibri, Carlito, system-ui, sans-serif' }}>
        {borrador && <p className="pointer-events-none absolute inset-x-0 top-1/3 -rotate-12 text-center text-4xl font-black text-red-600/15">{borrador}</p>}
        <div className="flex items-stretch gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-jrm-sia.png" alt="JRM" className="h-14 w-auto object-contain" />
          <div className="flex-1"><p className="text-lg font-bold text-[#002855]">ACTA DE SINCERAMIENTO DE STOCK APT</p>
            <p className="text-sm font-bold text-[#d71920]">Transferencia al almacén virtual SF</p></div>
          <div className="text-right text-[10px]"><p className="text-base font-black text-[#002855]">{s.numero}</p><p><b className="text-slate-500">Estado:</b> {SINC_ESTADO[s.estado].label}</p></div>
        </div>
        <div className="mt-2 h-1 bg-[#002855]" /><div className="mb-3 h-0.5 bg-[#d71920]" />
        <table className="mb-3 w-full text-[11px]"><tbody>
          <tr><td className="w-40 py-0.5 font-bold text-slate-500">Contrato / OT</td><td className="font-bold">{s.ot}</td><td className="w-36 font-bold text-slate-500">Propuesta</td><td>{fmtDateTime(s.propuesto_at)}</td></tr>
          <tr><td className="py-0.5 font-bold text-slate-500">Cliente</td><td>{s.cliente ?? '—'}</td><td className="font-bold text-slate-500">Autorización</td><td>{s.autorizado_at ? fmtDateTime(s.autorizado_at) : '—'}</td></tr>
          <tr><td className="py-0.5 font-bold text-slate-500">Motivo</td><td>{SINC_MOTIVO[s.motivo]}</td><td className="font-bold text-slate-500">Destino</td><td>{SF_BODEGA} (virtual)</td></tr>
        </tbody></table>
        <p className="mb-2 text-[11px] leading-snug">Se deja constancia de que el stock detallado figura en el sistema pero <b>no existe físicamente</b> en el almacén. Con la autorización de la Jefatura de Distribución sale del APT (647 · 540 · ST) hacia el almacén virtual SF, sin modificar los registros del ERP, y queda pendiente de regularizar en el ERP.</p>
        <p className="text-[11px] font-bold text-[#002855]">Lo verificado</p>
        <p className="mb-3 whitespace-pre-wrap rounded border border-slate-200 p-2 text-[11px]">{s.observacion}</p>
        <table className="w-full border-collapse text-[10px]">
          <thead><tr>{['BODEGA', 'PRODUCTO', 'GLOSA', 'LOTE', 'UNIDAD', 'CANTIDAD', 'PESO (KG)'].map((h, i) =>
            <th key={h} className={`border border-slate-200 bg-[#002855] px-1.5 py-1 text-white ${i >= 5 ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
          <tbody>
            {s.lineas.map((l, i) => <tr key={i} className={`border-b border-slate-200 align-top ${i % 2 ? '' : 'bg-[#fbfcfe]'}`}>
              <td className="px-1.5 py-0.5">{l.bodega}</td><td className="px-1.5 py-0.5 font-mono">{l.producto}</td><td className="px-1.5 py-0.5">{l.glosa ?? '—'}</td>
              <td className="px-1.5 py-0.5 font-bold">{l.lote}</td><td className="px-1.5 py-0.5">{l.unidad ?? '—'}</td>
              <td className="px-1.5 py-0.5 text-right tabular-nums">{n3(l.cantidad)}</td><td className="px-1.5 py-0.5 text-right tabular-nums">{l.peso_unit === null ? '—' : n3(l.kg)}</td></tr>)}
            <tr className="border-t-2 border-[#002855] bg-[#e8eef7] font-bold text-[#002855]"><td colSpan={6} className="px-1.5 py-1">TOTAL · {s.lineas.length} lote(s)</td>
              <td className="px-1.5 text-right tabular-nums">{kg.toLocaleString('es-PE', { maximumFractionDigits: 1 })}</td></tr>
          </tbody>
        </table>
        {s.estado === 'REVERTIDA' && <p className="mt-3 rounded border border-slate-300 bg-slate-50 p-2 text-[11px]"><b>Revertida</b> el {fmtDateTime(s.revertido_at)} por {s.revertidor ?? '—'}: {s.revertido_motivo}. El stock volvió al APT.</p>}
        {(s.estado === 'RECHAZADA' || s.estado === 'ANULADA') && <p className="mt-3 rounded border border-slate-300 bg-slate-50 p-2 text-[11px]"><b>{SINC_ESTADO[s.estado].label}</b> el {fmtDateTime(s.decidido_at)} por {s.decisor ?? '—'}{s.decision_motivo ? `: ${s.decision_motivo}` : ''}. Sin efecto en el stock.</p>}
        <div className="mt-8 flex gap-10">
          <Firma rol="Analista de Inventario" accion="Verificó en almacén" nombre={s.directo ? null : s.proponente} fecha={s.directo ? null : s.propuesto_at} />
          <Firma rol="Jefatura de Distribución" accion={s.directo ? 'Transferencia directa: propuso y autorizó' : 'Autorizó'} nombre={s.autorizador} fecha={s.autorizado_at} />
        </div>
        {s.bloque && <p className="mt-3 text-[10px] text-slate-500">Forma parte del bloque <b>{s.bloque}</b> (acta consolidada).</p>}
        {s.estado === 'REGULARIZADA' && <p className="mt-3 rounded border border-emerald-300 bg-emerald-50 p-2 text-[11px]"><b>Regularizada en el ERP</b> el {fmtDateTime(s.regularizado_at)}: la carga del ERP ya refleja el ajuste.</p>}
        <p className="mt-4 text-[9px] text-slate-500">Documento generado por JRM TMS · Inventario multi‑almacén APT · {fmtDateTime(new Date().toISOString())}</p>
      </div>
    </div>
  </Modal>
}

/** Acta consolidada de un bloque: una fila por acta (OT) con su peso; las actas de cada OT siguen siendo el detalle por lote */
export function SincActaBloque({ bloque, actas, onClose }: { bloque: string; actas: InvSinc[]; onClose: () => void }) {
  const hoja = useRef<HTMLDivElement>(null)
  const kgOf = (s: InvSinc) => s.lineas.reduce((t, l) => t + l.kg, 0)
  const kg = actas.reduce((t, s) => t + kgOf(s), 0)
  const p = actas[0]
  return <Modal isOpen onClose={onClose} title={`Acta del bloque ${bloque}`} maxWidth="max-w-4xl"
    footer={<div className="flex justify-end gap-2">
      <button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold">Cerrar</button>
      <button type="button" onClick={() => imprimirHoja(hoja.current, `Acta del bloque ${bloque}`, 'portrait')} className="flex min-h-10 items-center gap-2 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white"><Printer className="h-4 w-4" aria-hidden /> Imprimir</button>
    </div>}>
    <div className="max-h-[70vh] overflow-auto rounded-lg bg-slate-200 p-4">
      <div ref={hoja} className="mx-auto max-w-[190mm] bg-white p-6 text-slate-900 shadow-lg" style={{ fontFamily: 'Calibri, Carlito, system-ui, sans-serif' }}>
        <div className="flex items-stretch gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-jrm-sia.png" alt="JRM" className="h-14 w-auto object-contain" />
          <div className="flex-1"><p className="text-lg font-bold text-[#002855]">ACTA CONSOLIDADA DE SINCERAMIENTO</p>
            <p className="text-sm font-bold text-[#d71920]">Bloque de contratos al almacén virtual SF</p></div>
          <div className="text-right text-[10px]"><p className="text-base font-black text-[#002855]">{bloque}</p><p>{actas.length} acta(s)</p></div>
        </div>
        <div className="mt-2 h-1 bg-[#002855]" /><div className="mb-3 h-0.5 bg-[#d71920]" />
        {p && <table className="mb-3 w-full text-[11px]"><tbody>
          <tr><td className="w-40 py-0.5 font-bold text-slate-500">Motivo</td><td>{SINC_MOTIVO[p.motivo]}</td><td className="w-36 font-bold text-slate-500">Registro</td><td>{fmtDateTime(p.propuesto_at)}</td></tr>
          <tr><td className="py-0.5 font-bold text-slate-500">Destino</td><td>{SF_BODEGA} (virtual)</td><td className="font-bold text-slate-500">Autorización</td><td>{p.autorizado_at ? fmtDateTime(p.autorizado_at) : '—'}</td></tr>
        </tbody></table>}
        <p className="mb-2 text-[11px] leading-snug">Se deja constancia de que el stock de los contratos detallados figura en el sistema pero <b>no existe físicamente</b> en el almacén. Sale del APT (647 · 540 · ST) hacia el almacén virtual SF, sin modificar los registros del ERP, y queda pendiente de regularizar en el ERP. El detalle por lote está en el acta de cada contrato.</p>
        {p && <><p className="text-[11px] font-bold text-[#002855]">Lo verificado</p><p className="mb-3 whitespace-pre-wrap rounded border border-slate-200 p-2 text-[11px]">{p.observacion}</p></>}
        <table className="w-full border-collapse text-[10px]">
          <thead><tr>{['ACTA', 'CONTRATO / OT', 'CLIENTE', 'LOTES', 'PESO (KG)', 'ESTADO'].map((h, i) =>
            <th key={h} className={`border border-slate-200 bg-[#002855] px-1.5 py-1 text-white ${i === 3 || i === 4 ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
          <tbody>
            {actas.map((s, i) => <tr key={s.id} className={`border-b border-slate-200 ${i % 2 ? '' : 'bg-[#fbfcfe]'}`}>
              <td className="px-1.5 py-0.5 font-bold">{s.numero}</td><td className="px-1.5 py-0.5 font-bold">{s.ot}</td><td className="px-1.5 py-0.5">{s.cliente ?? '—'}</td>
              <td className="px-1.5 py-0.5 text-right tabular-nums">{s.lineas.length}</td><td className="px-1.5 py-0.5 text-right tabular-nums">{n3(kgOf(s))}</td>
              <td className="px-1.5 py-0.5">{SINC_ESTADO[s.estado].label}</td></tr>)}
            <tr className="border-t-2 border-[#002855] bg-[#e8eef7] font-bold text-[#002855]"><td colSpan={3} className="px-1.5 py-1">TOTAL · {actas.length} contrato(s)</td>
              <td className="px-1.5 text-right tabular-nums">{actas.reduce((t, s) => t + s.lineas.length, 0)}</td>
              <td className="px-1.5 text-right tabular-nums">{kg.toLocaleString('es-PE', { maximumFractionDigits: 1 })}</td><td /></tr>
          </tbody>
        </table>
        {p && <div className="mt-8 flex gap-10">
          <Firma rol="Analista de Inventario" accion="Verificó en almacén" nombre={p.directo ? null : p.proponente} fecha={p.directo ? null : p.propuesto_at} />
          <Firma rol="Jefatura de Distribución" accion={p.directo ? 'Transferencia directa: propuso y autorizó' : 'Autorizó'} nombre={p.autorizador} fecha={p.autorizado_at} />
        </div>}
        <p className="mt-4 text-[9px] text-slate-500">Documento generado por JRM TMS · Inventario multi‑almacén APT · {fmtDateTime(new Date().toISOString())}</p>
      </div>
    </div>
  </Modal>
}
