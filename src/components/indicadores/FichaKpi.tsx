'use client'

import { useCallback, useEffect, useState } from 'react'
import { Download, Loader2, PencilLine } from 'lucide-react'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { DataTable } from '@/components/ui/data-table'
import * as api from '@/lib/indicadores/api'
import type { Accion, Detalle, FilaDetalle, KpiResultado } from '@/lib/indicadores/api'
import { dimsTxt, equipoTxt, estadoNota,fechaTxt, metaTxt, MOTIVOS, motivoTxt, num, valorTxt } from '@/lib/indicadores/format'
import { EstadoBadge, Tendencia } from './KpiCard'

const ORIGEN: Record<string, string> = { AUTO: 'bg-slate-100 text-slate-700', CORREGIDO: 'bg-blue-50 text-blue-800', EXCLUIDO: 'bg-amber-50 text-amber-800' }
const CORR: Record<string, string> = { PROPUESTA: 'Propuesta', APROBADA: 'Aprobada', RECHAZADA: 'Rechazada' }

/** Resultado de un registro: en KPI de porcentaje es cumple/no cumple; en los demás, num/den. */
function resultadoFila(f: Pick<FilaDetalle, 'num' | 'den' | 'con_dato'>, unidad: string) {
  if (!f.con_dato) return 'Sin dato'
  if (unidad === '%' && f.den === 1) return f.num === 1 ? 'Cumple' : 'No cumple'
  return f.den == null || f.den === 1 ? num(f.num) : `${num(f.num)} / ${num(f.den)}`
}

function Proponer({ kpi, fila, onClose, onDone }: { kpi: KpiResultado; fila: FilaDetalle; onClose: () => void; onDone: () => void }) {
  const porcentaje = kpi.unidad === '%'
  const [accion, setAccion] = useState<Accion>('CORREGIR')
  const [cumple, setCumple] = useState<'1' | '0'>(fila.num === 1 ? '0' : '1')
  const [numV, setNum] = useState(fila.num == null ? '' : String(fila.num))
  const [denV, setDen] = useState(fila.den == null ? '' : String(fila.den))
  const [motivo, setMotivo] = useState('')
  const [detalleTxt, setDetalle] = useState('')
  const [busy, setBusy] = useState(false)
  const enviar = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!motivo) return toast.error('Seleccione el motivo.')
    if (motivo === 'OTRO' && detalleTxt.trim().length < 3) return toast.error('Con el motivo «Otro» el detalle es obligatorio.')
    let n: number | null = null, d: number | null = null
    if (accion === 'CORREGIR') {
      if (porcentaje) { n = Number(cumple); d = 1 }
      else {
        n = numV.trim() === '' ? NaN : Number(numV); d = denV.trim() === '' ? null : Number(denV)
        if (!Number.isFinite(n) || (d != null && !Number.isFinite(d))) return toast.error('Ingrese valores numéricos válidos.')
      }
    }
    setBusy(true)
    try {
      await api.proponer({ codigo: kpi.codigo, ref: fila.ref, fecha: fila.fecha, accion, num: n, den: d, motivo, detalle: detalleTxt.trim() })
      toast.success('Corrección propuesta. Queda pendiente de aprobación.')
      onDone()
    } catch (err) { toast.error(err instanceof Error ? err.message : 'No se pudo proponer la corrección.') }
    finally { setBusy(false) }
  }
  const campo = 'mt-1 w-full rounded-lg border px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#002855]'
  return <Modal isOpen onClose={onClose} title={`Proponer corrección · ${fila.etiqueta}`} maxWidth="max-w-md">
    <form onSubmit={enviar} className="space-y-4 text-sm">
      <p className="text-slate-600">{kpi.nombre} · {fechaTxt(fila.fecha)} · valor actual: <b>{resultadoFila(fila, kpi.unidad)}</b></p>
      <fieldset><legend className="font-semibold text-slate-700">Acción</legend>
        <div className="mt-1 flex gap-4">{(['CORREGIR', 'EXCLUIR'] as const).map(a => <label key={a} className="flex items-center gap-2"><input type="radio" name="accion" checked={accion === a} onChange={() => setAccion(a)} />{a === 'CORREGIR' ? 'Corregir' : 'Excluir'}</label>)}</div>
      </fieldset>
      {accion === 'CORREGIR' && (porcentaje
        ? <fieldset><legend className="font-semibold text-slate-700">Valor nuevo</legend><div className="mt-1 flex flex-wrap gap-4">
          <label className="flex items-center gap-2"><input type="radio" name="cumple" checked={cumple === '1'} onChange={() => setCumple('1')} />Marcar como cumplido</label>
          <label className="flex items-center gap-2"><input type="radio" name="cumple" checked={cumple === '0'} onChange={() => setCumple('0')} />Marcar como no cumplido</label></div></fieldset>
        : <div className="grid grid-cols-2 gap-3">
          <label className="font-semibold text-slate-700">Numerador<input inputMode="decimal" className={campo} value={numV} onChange={e => setNum(e.target.value)} required /></label>
          <label className="font-semibold text-slate-700">Denominador<input inputMode="decimal" className={campo} value={denV} onChange={e => setDen(e.target.value)} /></label>
        </div>)}
      <label className="block font-semibold text-slate-700">Motivo<select className={campo} value={motivo} onChange={e => setMotivo(e.target.value)} required>
        <option value="">Seleccione…</option>{MOTIVOS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <label className="block font-semibold text-slate-700">Detalle{motivo === 'OTRO' && ' (obligatorio)'}<textarea className={campo} rows={3} maxLength={500} value={detalleTxt} onChange={e => setDetalle(e.target.value)} /></label>
      <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded-lg border px-4 py-2">Cancelar</button>
        <button disabled={busy} className="flex items-center gap-2 rounded-lg bg-[#002855] px-4 py-2 font-semibold text-white disabled:opacity-60">{busy && <Loader2 className="h-4 w-4 animate-spin" />}Proponer</button></div>
    </form>
  </Modal>
}

export function FichaKpi({ kpi, desde, hasta, cerrado, onClose, onChange }: { kpi: KpiResultado; desde: string; hasta: string; cerrado: boolean; onClose: () => void; onChange: () => void }) {
  const [data, setData] = useState<Detalle | null>(null)
  const [error, setError] = useState('')
  const [fila, setFila] = useState<FilaDetalle | null>(null)
  const [nonce, setNonce] = useState(0)
  const cargar = useCallback(() => setNonce(n => n + 1), [])
  useEffect(() => {
    let vivo = true
    api.detalle(kpi.codigo, desde, hasta).then(d => { if (vivo) { setData(d); setError('') } })
      .catch(e => { if (vivo) { const m = e instanceof Error ? e.message : 'No se pudo cargar el detalle.'; setError(m); toast.error(m) } })
    return () => { vivo = false }
  }, [kpi.codigo, desde, hasta, nonce])
  const bloqueado = cerrado || !!data?.cerrado
  const exportar = async () => {
    if (!data) return
    const { exportAptXlsx } = await import('@/lib/apt/export')
    exportAptXlsx(`${kpi.codigo} ${desde}`, {
      Ficha: [{ Código: kpi.codigo, Indicador: kpi.nombre, Equipo: equipoTxt(kpi.equipo), Periodo: `${desde} → ${hasta}`, Valor: kpi.valor ?? '', Unidad: kpi.unidad, Meta: metaTxt(kpi), Estado: kpi.estado, Cobertura: kpi.cobertura ?? '', Fórmula: kpi.formula, Fuente: kpi.fuente, 'Nota de datos': kpi.nota_datos || '' }],
      Detalle: data.filas.map(f => ({ Referencia: f.ref, Fecha: f.fecha, Etiqueta: f.etiqueta, Numerador: f.num ?? '', Denominador: f.den ?? '', 'Con dato': f.con_dato ? 'Sí' : 'No', 'Numerador original': f.num_orig ?? '', 'Denominador original': f.den_orig ?? '', Detalle: dimsTxt(f.dims).join(' · '), Origen: f.origen, Responsable: f.responsable_nombre || '',
        Corrección: f.correccion ? `${CORR[f.correccion.estado]} · ${f.correccion.accion === 'EXCLUIR' ? 'Excluir' : 'Corregir'} · ${motivoTxt(f.correccion.motivo)}` : '' })),
    })
  }
  const nota = estadoNota(kpi)
  return <Modal isOpen onClose={onClose} title={kpi.nombre} maxWidth="max-w-5xl">
    <div className="min-w-0 space-y-5 text-sm">
      <div className="flex flex-wrap items-center gap-2"><EstadoBadge estado={kpi.estado} /><span className="text-xs text-slate-500">{equipoTxt(kpi.equipo)} · {kpi.codigo} · {kpi.tipo === 'FOTO' ? 'Foto al cierre' : 'Acumulado del periodo'}</span></div>
      {nota && <p className="rounded-lg bg-slate-50 p-3 text-slate-700">{nota}</p>}
      <dl className="grid gap-3 sm:grid-cols-2">
        {([['Valor', valorTxt(kpi.valor, kpi.unidad)], ['Meta', `${metaTxt(kpi)}${kpi.tolerancia != null ? ` (tolerancia ${num(kpi.tolerancia)})` : ''}`], ['Definición', kpi.descripcion], ['Fórmula', kpi.formula], ['Fuente', kpi.fuente], ['Responsable', kpi.responsable || '—'], ['Nota de datos', kpi.nota_datos || '—'], ['Cobertura', kpi.cobertura == null ? '—' : `${num(kpi.cobertura)} % (${kpi.n_con_dato}/${kpi.n})`]] as const)
          .map(([k, v]) => <div key={k} className="min-w-0"><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{k}</dt><dd className="break-words text-slate-800">{v}</dd></div>)}
      </dl>
      <div><h3 className="mb-1 font-semibold text-[#002855]">Tendencia</h3><Tendencia kpi={kpi} alto={200} ejes /></div>
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold text-[#002855]">Detalle por registro</h3>
          <button onClick={exportar} disabled={!data} className="flex items-center gap-2 rounded-lg border bg-white px-3 py-1.5 text-xs font-semibold disabled:opacity-50"><Download className="h-4 w-4" aria-hidden />Exportar detalle</button></div>
        {bloqueado && <p className="mb-2 text-xs text-slate-500">Periodo cerrado: no se aceptan nuevas correcciones.</p>}
        {error ? <p role="alert" className="text-red-700">{error} <button onClick={cargar} className="font-semibold underline">Reintentar</button></p>
          : !data ? <p role="status" className="flex items-center gap-2 text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Cargando detalle…</p>
          : !data.filas.length ? <p className="text-slate-500">Sin registros en el periodo.</p>
          : <div className="max-h-[50vh] overflow-auto rounded-lg border"><DataTable dense className="w-full min-w-[960px] text-xs">
            <thead className="sticky top-0 bg-slate-50 text-left text-slate-600"><tr><th className="p-2">Referencia</th><th className="p-2">Fecha</th><th className="p-2">Etiqueta</th><th className="p-2">Resultado</th><th className="p-2">Detalle</th><th className="p-2">Origen</th><th className="p-2">Responsable</th><th className="p-2">Corrección</th><th className="p-2"><span className="sr-only">Acciones</span></th></tr></thead>
            <tbody>{data.filas.map(f => <tr key={`${f.ref}|${f.fecha}`} className="border-t">
              <td className="p-2 font-mono">{f.ref}</td><td className="whitespace-nowrap p-2">{fechaTxt(f.fecha)}</td><td className="p-2">{f.etiqueta}</td>
              <td className="p-2">{f.origen === 'CORREGIDO' && (f.num_orig != null || f.den_orig != null) ? <>{resultadoFila({ num: f.num_orig, den: f.den_orig, con_dato: true }, kpi.unidad)} → <b>{resultadoFila(f, kpi.unidad)}</b></> : resultadoFila(f, kpi.unidad)}</td>
              <td className="max-w-[260px] p-2 text-slate-600">{dimsTxt(f.dims).join(' · ') || '—'}</td>
              <td className="p-2"><span className={`rounded-full px-2 py-0.5 font-semibold ${ORIGEN[f.origen] || ORIGEN.AUTO}`}>{f.origen === 'AUTO' ? 'Automático' : f.origen === 'CORREGIDO' ? 'Corregido' : 'Excluido'}</span></td>
              <td className="p-2">{f.responsable_nombre || '—'}</td>
              <td className="p-2">{f.correccion ? <span title={f.correccion.detalle || undefined}>{CORR[f.correccion.estado]} · {f.correccion.accion === 'EXCLUIR' ? 'Excluir' : `→ ${resultadoFila({ num: f.correccion.num_nuevo, den: f.correccion.den_nuevo, con_dato: true }, kpi.unidad)}`} · {motivoTxt(f.correccion.motivo)}<br /><span className="text-slate-500">{f.correccion.propuesto_por_nombre}</span></span> : '—'}</td>
              <td className="p-2">{f.puede_proponer && !f.cerrado && !bloqueado &&<button onClick={() => setFila(f)} className="flex items-center gap-1 whitespace-nowrap rounded-lg border px-2 py-1 font-semibold text-[#002855]"><PencilLine className="h-3.5 w-3.5" aria-hidden />Proponer corrección</button>}</td>
            </tr>)}</tbody>
          </DataTable></div>}
      </div>
    </div>
    {fila && <Proponer kpi={kpi} fila={fila} onClose={() => setFila(null)} onDone={() => { setFila(null); cargar(); onChange() }} />}
  </Modal>
}
