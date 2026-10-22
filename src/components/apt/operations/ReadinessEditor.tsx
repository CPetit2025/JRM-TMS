'use client'
import { useRef, useState, useEffect } from 'react'
import type { OperationalReadiness, OperationalSourceRow } from '@/lib/apt/operations'
export function ReadinessEditor({ row, current, onSave, onClose }: { row: OperationalSourceRow; current?: OperationalReadiness; onSave: (value: Record<string, unknown>) => Promise<void>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [status, setStatus] = useState<OperationalReadiness['status']>(current?.status || 'NO_EVALUADO')
  const [reason, setReason] = useState(current?.reason || ''), [responsible, setResponsible] = useState(current?.responsible_name || ''), [action, setAction] = useState(current?.next_action || '')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close() }, [])
  const input = 'mt-1 w-full rounded-lg border border-slate-200 p-3 text-sm'
  return <dialog ref={dialog} onCancel={event => { event.preventDefault(); if (!busy) onClose() }} className="m-auto w-[calc(100%-2rem)] max-w-xl rounded-2xl p-0 backdrop:bg-slate-900/50" aria-labelledby="readiness-title"><form className="max-h-[85dvh] space-y-4 overflow-auto p-6" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { await onSave({ almacen: row.almacen, lote: row.lote, producto: '*', status, reason, responsible_name: responsible, next_action: action, expected_updated_at: current?.updated_at ?? null }); onClose() } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo guardar.'); } finally { setBusy(false) } }}>
    <h3 id="readiness-title" className="text-lg font-bold text-[#002855]">Revisión operativa · {row.lote}</h3><p className="text-xs text-slate-600">Aplica a todos los productos del lote en {row.almacen === 'ST' ? 'ST VENTAS' : row.almacen}. Es una evaluación registrada por el usuario; no confirma inventario físico ni autoriza automáticamente un despacho.</p>
    <label className="block text-sm font-semibold">Evaluación<select className={input} value={status} onChange={e => setStatus(e.target.value as OperationalReadiness['status'])}><option value="NO_EVALUADO">No evaluado</option><option value="DISPONIBLE">Disponible según revisión</option><option value="BLOQUEADO">Bloqueado</option></select></label>
    <label className="block text-sm font-semibold">Motivo / sustento<textarea required={status !== 'NO_EVALUADO'} maxLength={2000} className={input} value={reason} onChange={e => setReason(e.target.value)} /></label>
    <label className="block text-sm font-semibold">Responsable<input required={status !== 'NO_EVALUADO'} maxLength={200} className={input} value={responsible} onChange={e => setResponsible(e.target.value)} placeholder="Nombre del responsable" /></label>
    <label className="block text-sm font-semibold">Próxima acción<textarea required={status !== 'NO_EVALUADO'} maxLength={2000} className={input} value={action} onChange={e => setAction(e.target.value)} /></label>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}<div className="flex justify-end gap-2"><button type="button" disabled={busy} onClick={onClose} className="min-h-11 rounded-lg border px-4 text-sm">Cancelar</button><button disabled={busy} className="min-h-11 rounded-lg bg-[#002855] px-4 text-sm font-bold text-white disabled:opacity-50">{busy ? 'Guardando…' : 'Guardar revisión'}</button></div>
  </form></dialog>
}
