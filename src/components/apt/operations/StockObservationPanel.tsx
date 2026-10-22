'use client'

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Plus, RefreshCw, Scale } from 'lucide-react'
import { stockObservations } from '@/lib/apt/stockObservations'
import type { StockObservationInput, StockReconciliation } from '@/lib/apt/stockObservations'
import { fmtDate, fmtDateTime } from '@/lib/apt/format'

const kg = (value: number | null) => value === null ? 'No evaluable' : new Intl.NumberFormat('es-PE', { maximumFractionDigits: 3 }).format(value)
const fieldClass = 'mt-1 min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-800'
const buttonClass = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-[#002855] disabled:opacity-50'

export function StockObservationPanel({ cutoff, almacen, lote, canEdit = false }: { cutoff?: string | null; almacen?: string; lote?: string; canEdit?: boolean }) {
  const [nonce, setNonce] = useState(0)
  const [page, setPage] = useState(0)
  const key = JSON.stringify({ cutoff, almacen, lote, nonce, page })
  const [response, setResponse] = useState<{ key: string; data: StockReconciliation | null; error: string | null } | null>(null)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    stockObservations.list({ cutoff: cutoff || undefined, almacen, lote, limit: 25, offset: page * 25 }).then(data => {
      if (active) setResponse({ key, data, error: null })
    }).catch((cause: unknown) => {
      if (active) setResponse({ key, data: null, error: cause instanceof Error ? cause.message : 'No se pudo consultar.' })
    })
    return () => { active = false }
  }, [cutoff, almacen, lote, key, page])
  const current = response?.key === key ? response : null
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const input = Object.fromEntries(form.entries()) as unknown as StockObservationInput
    setSaving(true); setError(null); setMessage(null)
    try {
      await stockObservations.save(input)
      setMessage('Observación registrada. No se modificó el saldo reconstruido.'); setOpen(false); setNonce(n => n + 1)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo guardar.') }
    finally { setSaving(false) }
  }
  return <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 p-4"><div><h3 className="flex items-center gap-2 font-bold text-[#002855]"><Scale className="h-4 w-4" />Conciliación con ERP y conteo físico</h3><p className="mt-1 max-w-3xl text-xs text-slate-500">Compara observaciones registradas por fecha, almacén, lote y producto. Cada fuente se muestra por separado; esta muestra no certifica todo el inventario.</p></div><div className="flex gap-2"><button className={buttonClass} onClick={() => setNonce(n => n + 1)} aria-label="Actualizar conciliación"><RefreshCw className="h-4 w-4" /></button>{canEdit && <button className={buttonClass} onClick={() => { setOpen(value => !value); setError(null) }}><Plus className="h-4 w-4" />Registrar observación</button>}</div></header>
    {message && <p role="status" className="m-4 rounded-lg bg-emerald-50 p-3 text-xs text-emerald-800">{message}</p>}
    {error && <p role="alert" className="m-4 rounded-lg bg-red-50 p-3 text-xs text-red-800">{error}</p>}
    {open && canEdit && <form onSubmit={save} className="m-4 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4"><p className="text-xs text-slate-600">Registra el peso total de esta clave al cierre del día. La referencia debe identificar el reporte ERP o acta de conteo. Una corrección crea una nueva observación y conserva las anteriores.</p><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <label className="text-xs font-medium">Fecha de corte<input name="cutoff" type="date" required defaultValue={cutoff || ''} className={fieldClass} /></label>
      <label className="text-xs font-medium">Almacén<select name="almacen" defaultValue={almacen || '647'} className={fieldClass}><option value="647">647 · ALM PT</option><option value="540">540 · APT LB</option><option value="ST">ST VENTAS</option></select></label>
      <label className="text-xs font-medium">Lote exacto<input name="lote" required maxLength={120} defaultValue={lote || ''} className={fieldClass} /></label>
      <label className="text-xs font-medium">Código exacto de producto<input name="producto" required maxLength={160} className={fieldClass} /></label>
      <label className="text-xs font-medium">Peso observado · kg<input name="peso_kg" type="number" min="0" max="999999999999" step="0.000001" required className={fieldClass} /></label>
      <label className="text-xs font-medium">Fuente<select name="source" defaultValue="ERP" className={fieldClass}><option value="ERP">Reporte ERP</option><option value="FISICO">Conteo físico</option></select></label>
      <label className="text-xs font-medium sm:col-span-2">Referencia de evidencia<input name="reference" required maxLength={500} placeholder="Reporte o acta de conteo" className={fieldClass} /></label>
    </div><label className="block text-xs font-medium">Observación<textarea name="notes" maxLength={2000} rows={2} className={fieldClass} /></label><div className="flex justify-end gap-2"><button type="button" disabled={saving} className={buttonClass} onClick={() => setOpen(false)}>Cancelar</button><button type="submit" disabled={saving} className={`${buttonClass} !bg-[#002855] !text-white`}>{saving ? 'Guardando…' : 'Guardar observación'}</button></div></form>}
    {!current && <p className="p-4 text-sm text-slate-500">Consultando observaciones…</p>}
    {current?.error && <p role="alert" className="p-4 text-sm text-red-700">{current.error}</p>}
    {current?.data && <><p className="px-4 py-3 text-xs text-slate-500">Corte: {fmtDate(current.data.cutoff)} · Última observación de cada fuente y clave · {current.data.total} registros. Diferencia = observado − documental.</p>{!current.data.documentary_available && <p className="px-4 pb-3 text-xs text-amber-800">{current.data.model_fresh ? 'No hay modelo disponible para este corte. El saldo documental permanece no evaluable.' : 'El modelo está pendiente de actualización. Las observaciones se conservan, pero no se comparan hasta completar el recálculo.'}</p>}<div className="overflow-x-auto"><table className="w-full min-w-[850px] text-left text-xs"><thead className="bg-slate-50 uppercase text-slate-500"><tr>{['Almacén / lote','Producto','Fuente / referencia','Observado kg','Documental kg','Diferencia kg','Resultado'].map(label => <th key={label} className="px-4 py-3">{label}</th>)}</tr></thead><tbody>{current.data.rows.map(row => <tr key={row.id} className="border-t border-slate-100"><td className="px-4 py-3 font-semibold">{row.almacen} · {row.lote}</td><td className="px-4 py-3">{row.producto}</td><td className="max-w-60 px-4 py-3"><b>{row.source === 'FISICO' ? 'Conteo físico' : 'ERP'}</b><p className="break-words text-slate-500">{row.reference}</p><p className="text-slate-400">{fmtDateTime(row.created_at)}</p></td><td className="px-4 py-3 tabular-nums">{kg(row.observed_kg)}</td><td className="px-4 py-3 tabular-nums">{kg(row.documentary_kg)}</td><td className="px-4 py-3 tabular-nums">{kg(row.difference_kg)}</td><td className="px-4 py-3"><span className={row.status === 'DIFERENCIA' ? 'font-semibold text-amber-800' : 'text-slate-600'}>{row.status === 'COINCIDE_DOCUMENTAL' ? 'Coincide documental' : row.status === 'DIFERENCIA' ? 'Revisar diferencia' : row.status === 'MODELO_PENDIENTE' ? 'Recálculo pendiente' : 'No evaluable'}</span></td></tr>)}</tbody></table></div>{current.data.total === 0 && <p className="p-4 text-sm text-slate-500">No hay observaciones registradas para este corte y alcance. Esto no demuestra que el inventario esté conciliado.</p>}<footer className="flex justify-end gap-2 border-t border-slate-100 p-3"><button disabled={page === 0} onClick={() => setPage(value => value - 1)} className={buttonClass}>Anterior</button><button disabled={(page + 1) * 25 >= current.data.total} onClick={() => setPage(value => value + 1)} className={buttonClass}>Siguiente</button></footer></>}
  </section>
}
