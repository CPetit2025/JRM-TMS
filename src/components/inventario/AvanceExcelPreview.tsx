'use client'

import { Fragment, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { BODEGAS, tn } from '@/lib/inventario/avance-contrato'
import { GRUPOS_XLS, cantidades, cantidadesTotal, descargarAvanceExcel, fecha, toneladasTotal, type HojaAvance } from '@/lib/inventario/avance-contrato-excel'

const MAX = 80 // filas de la vista previa; el archivo lleva todas
const q = (v: number) => (v ? v.toLocaleString('es-PE', { maximumFractionDigits: 3 }) : '—')
const t = (v: number | null, bold = false) => (v === null ? <span className="font-bold text-amber-700">s/p</span> : v ? v.toLocaleString('es-PE', { minimumFractionDigits: bold ? 2 : 3, maximumFractionDigits: bold ? 2 : 3 }) : '—')
const GFILL = ['bg-[#e8eef7]', 'bg-[#e6f4ee]', 'bg-[#f1f5f9]', 'bg-[#fdf2e2]', 'bg-[#fdf2e2]', 'bg-[#fdf2e2]', 'bg-[#fef3c7]']
const EST = { COMPLETO: 'bg-[#d1fae5] text-[#065f46]', PARCIAL: 'bg-[#fef3c7] text-[#92400e]', PENDIENTE: 'bg-[#fee2e2] text-[#991b1b]' }

/** Vista previa fiel del Excel (hoja horizontal con encabezado corporativo) antes de descargarlo */
export function AvanceExcelPreview({ hoja, open, onClose }: { hoja: HojaAvance; open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<'items' | 'lotes'>('items'), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const { meta, general: G, total: T } = hoja
  const descargar = async () => {
    setBusy(true); setError('')
    try { await descargarAvanceExcel(hoja) } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo generar el Excel') } finally { setBusy(false) }
  }
  const nf2 = (v: number) => v.toLocaleString('es-PE', { maximumFractionDigits: 2 })
  const cabecera = (titulo: string) => <>
    <div className="flex items-stretch gap-4">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo-jrm-sia.png" alt="JRM" className="h-16 w-auto object-contain" />
      <div className="flex-1"><p className="text-xl font-bold text-[#002855]">{titulo}</p><p className="text-sm font-bold text-[#d71920]">OT {meta.ot}{meta.cliente ? ` · ${meta.cliente}` : ''}</p></div>
      <div className="space-y-0.5 text-right text-[10px] text-slate-900">
        <p><b className="text-slate-500">Corte ERP:</b> {fecha(meta.corte)}</p><p><b className="text-slate-500">Generado:</b> {fecha(meta.generado)}</p>
        <p className="max-w-72"><b className="text-slate-500">Filtros:</b> {meta.filtros.join(' · ') || 'Ninguno'}</p></div>
    </div>
    <div className="mt-2 h-1 bg-[#002855]" /><div className="h-0.5 bg-[#d71920]" />
  </>
  const filas = hoja.filas.slice(0, MAX)
  return <Modal isOpen={open} onClose={onClose} title="Vista previa del Excel" maxWidth="max-w-[min(96vw,1500px)]"
    footer={<div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-slate-500">Horizontal · A3 ajustado al ancho · 2 hojas · {hoja.filas.length > MAX ? `vista previa de ${MAX} de ${hoja.filas.length} filas; el archivo incluye todas` : `${hoja.filas.length} filas`}</p>
      <div className="flex gap-2">{error && <p role="alert" className="self-center text-xs text-red-700">{error}</p>}
        <button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold">Cerrar</button>
        <button type="button" disabled={busy} onClick={() => void descargar()} className="flex min-h-10 items-center gap-2 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white disabled:opacity-60">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />} Descargar Excel</button></div>
    </div>}>
    <div className="mb-3 inline-flex overflow-hidden rounded-lg border border-slate-300" role="tablist" aria-label="Hojas del Excel">
      {([['items', 'Avance por ítem'], ['lotes', 'Cumplimiento por lote']] as const).map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
        className={`min-h-9 px-3 text-xs font-semibold ${tab === k ? 'bg-[#002855] text-white' : 'bg-white text-slate-700'}`}>{l}</button>)}
    </div>
    <div className="max-h-[70vh] overflow-auto rounded-lg bg-slate-200 p-4">
      <div className="mx-auto w-max min-w-full rounded bg-white p-5 shadow-lg" style={{ fontFamily: 'Calibri, Carlito, system-ui, sans-serif' }}>
        {tab === 'items' ? <>
          {cabecera('AVANCE DEL CONTRATO POR ÍTEM')}
          <div className="my-3 grid grid-cols-5 gap-2">
            {[['CONTRATADO', `${nf2(G.tContratado)} TN`, `${G.n} ítems${G.sinPeso ? ` · ${G.sinPeso} sin peso` : ''}`, 'border-t-[#002855] text-[#002855]'],
              ['DESPACHADO', `${nf2(G.tDespachado)} TN`, `${G.tContratado ? Math.round((G.tDespachado / G.tContratado) * 100) : 0} % del contrato`, 'border-t-[#002855] text-[#002855]'],
              ['SALDO POR DESPACHAR', `${nf2(G.tSaldo)} TN`, 'del contrato completo', 'border-t-[#b91c1c] text-[#b91c1c]'],
              ['EN APT (LISTO)', `${nf2(G.tApt[0] + G.tApt[1] + G.tApt[2])} TN`, BODEGAS.map((b, i) => `${b}: ${nf2(G.tApt[i])}`).join(' · '), 'border-t-[#d97706] text-[#d97706]'],
              ['POR PRODUCIR', `${nf2(G.tPorProducir)} TN`, `${G.tContratado ? Math.round((G.tPorProducir / G.tContratado) * 100) : 0} % del contrato`, 'border-t-[#475569] text-[#475569]']].map(([l, v, h, c]) =>
              <div key={l} className={`border border-t-4 border-slate-200 bg-[#f8fafc] px-2 py-1 ${c}`}><p className="text-[9px] font-bold text-slate-500">{l}</p><p className="text-base font-bold">{v}</p><p className="text-[9px] text-slate-500">{h}</p></div>)}
          </div>
          <table className="border-collapse text-[10px] text-slate-900">
            <thead>
              <tr>{['LOTE', 'ÍTEM', 'ID', 'GLOSA', 'UNIDAD'].map(h => <th key={h} rowSpan={2} className="border border-slate-200 bg-[#002855] px-1.5 py-1 text-white">{h}</th>)}
                {GRUPOS_XLS.map((g, i) => <th key={g} colSpan={2} className={`border border-slate-200 px-1.5 py-1 ${GFILL[i]}`}>{g.toUpperCase()}</th>)}
                {['AVANCE', 'ESTADO', 'PESO UNIT. (KG)', 'FUENTE PESO'].map(h => <th key={h} rowSpan={2} className="border border-slate-200 bg-[#002855] px-1.5 py-1 text-white">{h}</th>)}</tr>
              <tr className="border-b-2 border-[#002855]">{GRUPOS_XLS.map((g, i) => <Fragment key={g}><th className={`border border-slate-200 px-1.5 text-slate-500 ${GFILL[i]}`}>CANT.</th><th className={`border border-slate-200 px-1.5 text-slate-500 ${GFILL[i]}`}>TN</th></Fragment>)}</tr>
            </thead>
            <tbody>
              {filas.map((f, idx) => f.tipo === 'lote'
                ? <tr key={`l-${f.lote}`} className="border-y border-[#b6c4da] bg-[#e8eef7] font-bold text-[#002855]"><td className="px-1.5 py-1">{f.lote}</td><td colSpan={4} className="px-1.5">{f.n} ítems</td>
                    {cantidadesTotal(f.t).map((v, i) => <Fragment key={i}><td className="px-1.5 text-right">{f.t.mixta ? '—' : q(v)}</td><td className="px-1.5 text-right">{t(toneladasTotal(f.t)[i], true)}</td></Fragment>)}
                    <td className="px-1.5 text-right">{f.t.tContratado ? `${Math.round((f.t.tDespachado / f.t.tContratado) * 100)}%` : ''}</td><td colSpan={3} /></tr>
                : <tr key={f.f.item} className={`border-b border-slate-200 align-top ${idx % 2 ? '' : 'bg-[#fbfcfe]'}`}>
                    <td className="px-1.5 py-0.5">{f.f.lote}</td><td className="px-1.5 font-bold text-[#002855]">{f.f.item}</td><td className="px-1.5 text-slate-500">{f.f.producto}</td><td className="max-w-72 px-1.5">{f.f.glosa}</td><td className={`px-1.5 text-center ${f.f.unidad && f.f.unidad.toUpperCase() !== 'UND' ? 'font-bold text-amber-700' : ''}`}>{f.f.unidad}</td>
                    {cantidades(f.f).map((v, i) => <Fragment key={i}><td className="px-1.5 text-right">{q(v)}</td>
                      <td className="px-1.5 text-right text-slate-500">{v ? t(f.f.peso ? tn(v, f.f.peso) : null) : '—'}</td></Fragment>)}
                    <td className="px-1.5"><div className="flex items-center gap-1"><span className="h-2 w-10 bg-slate-100"><i className="block h-full bg-[#a9bedd]" style={{ width: `${f.f.avance * 100}%` }} /></span>{Math.round(f.f.avance * 100)}%</div></td>
                    <td className={`px-1.5 text-center text-[9px] font-bold ${EST[f.f.estado]}`}>{f.f.estado}</td>
                    <td className="px-1.5 text-right text-slate-500">{f.f.peso ? f.f.peso.toLocaleString('es-PE', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) : '—'}</td>
                    <td className={`px-1.5 text-[9px] ${f.f.pesoFuente ? 'text-slate-500' : 'text-amber-700'}`}>{f.f.pesoFuente ?? 'Sin peso'}</td></tr>)}
              {hoja.filas.length > MAX && <tr><td colSpan={23} className="py-2 text-center italic text-slate-500">… {hoja.filas.length - MAX} filas más en el archivo</td></tr>}
              <tr className="bg-[#002855] font-bold text-white"><td colSpan={5} className="px-1.5 py-1">TOTAL · {T.n} ítems{meta.filtros.length ? ' (filtrados)' : ''}</td>
                {cantidadesTotal(T).map((v, i) => <Fragment key={i}><td className="px-1.5 text-right">{T.mixta ? '—' : q(v)}</td><td className="px-1.5 text-right">{t(toneladasTotal(T)[i], true)}</td></Fragment>)}
                <td className="px-1.5 text-right">{T.tContratado ? `${Math.round((T.tDespachado / T.tContratado) * 100)}%` : ''}</td><td colSpan={3} /></tr>
            </tbody>
          </table>
        </> : <>
          {cabecera('CUMPLIMIENTO POR LOTE')}
          <table className="mt-3 border-collapse text-[11px] text-slate-900">
            <thead><tr>{['LOTE', 'ÍTEMS', 'SIN PESO', 'MEDIDA', 'CONTRATO', 'DESPACHADO', 'EN APT (LISTO)', 'POR PRODUCIR', 'CUMPLIMIENTO'].map(h => <th key={h} className="bg-[#002855] px-3 py-1.5 text-white">{h}</th>)}</tr></thead>
            <tbody>{hoja.lotes.map((l, i) => { const f = (v: number | null) => (v === null ? '—' : l.enTn ? v.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v.toLocaleString('es-PE'))
              return <tr key={l.lote} className={`border-b border-slate-200 ${i % 2 ? 'bg-[#f8fafc]' : ''}`}>
                <td className="px-3 py-1 font-bold text-[#002855]">{l.lote}</td><td className="px-3 text-right">{l.n}</td><td className="px-3 text-right">{l.sinPeso || '—'}</td><td className="px-3 text-center">{l.medida ?? 'Mixta'}</td>
                <td className="px-3 text-right">{f(l.contrato)}</td><td className="px-3 text-right">{f(l.despachado)}</td><td className="px-3 text-right">{f(l.apt)}</td><td className="px-3 text-right">{f(l.porProducir)}</td>
                <td className="w-56 px-3"><div className="flex items-center gap-2"><span className="h-3 flex-1 bg-slate-100"><i className="block h-full bg-[#a9bedd]" style={{ width: `${(l.pct ?? 0) * 100}%` }} /></span><b>{l.pct === null ? '—' : `${(l.pct * 100).toFixed(1)}%`}</b></div></td></tr> })}</tbody>
          </table>
        </>}
      </div>
    </div>
  </Modal>
}
