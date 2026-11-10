'use client'

import Link from 'next/link'
import { PackingAssignment } from './PackingAssignment'
import { DispatchNav } from './DispatchNav'
import { DISPATCH_STAGES } from '@/lib/warehouse/dispatch'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Camera, Check, Download, Eye, Loader2, RefreshCw, X } from 'lucide-react'
import { usePermissions } from '@/hooks/usePermissions'
import { AUDIT, STATE, buildPackingListPdf, fmt, fmtDate, type BoardRow, type PackingSnapshot, type TaskLpn, type TaskLpns } from '@/lib/warehouse/packing-list'
import { syncFromTms } from '@/lib/warehouse/sync'

type Form = { lpn: TaskLpn; result: 'OBSERVADO' | 'RECHAZADO' | 'COMENTARIO' }
const btn = 'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-bold disabled:opacity-50'

export function AuditWorkspace({ mode = 'auditoria', initialTaskId = '' }: { mode?: 'auditoria' | 'packing-list'; initialTaskId?: string }) {
  const packing = mode === 'packing-list'
  const stageConfig = DISPATCH_STAGES[mode]
  const { hasAccess } = usePermissions()
  const [rows, setRows] = useState<BoardRow[]>([])
  const [taskId, setTaskId] = useState(initialTaskId)
  const requestVersion = useRef(0)
  const [loadedTaskId, setLoadedTaskId] = useState('')
  const [data, setData] = useState<TaskLpns | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [comment, setComment] = useState('')
  const [pkg, setPkg] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    const warn = await syncFromTms()
    const db = createClient()
    const board = await db.rpc('wh_task_board', { p_scope: packing ? 'tareas' : 'auditoria' })
    if (board.error) { setError(board.error.message); return }
    const list = ((board.data || []) as BoardRow[]).filter(r => !packing || r.lpn_total > 0)
    setRows(list)
    if (warn) setError(warn)
    setTaskId(current => current && list.some(r => r.id === current) ? current : list[0]?.id || '')
  }, [packing])
  const loadTask = useCallback(async (id: string) => {
    const version = ++requestVersion.current
    if (!id) { setData(null); setLoadedTaskId(''); return }
    if (packing) {
      const refreshed = await createClient().rpc('wh_refresh_packing_list', { p_task_id: id })
      if (refreshed.error) { if (version === requestVersion.current) { setError(refreshed.error.message); setData(null) }; return }
    }
    const { data: lpns, error } = await createClient().rpc('wh_task_lpns', { p_task_id: id })
    if (version !== requestVersion.current) return
    if (error) { setError(error.message); setData(null) } else { setData(lpns as TaskLpns); setLoadedTaskId(id) }
  }, [packing])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
    const timer = window.setInterval(() => void load(), 15000)
    return () => window.clearInterval(timer)
  }, [load])
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadTask(taskId)
  }, [taskId, rows, loadTask])

  const task = rows.find(r => r.id === taskId) || null

  // Quien preparó no audita: la base lo rechaza; un supervisor puede continuar dejando el motivo.
  const withOverride = async <T,>(call: (reason: string | null) => PromiseLike<{ data: T; error: { message: string } | null }>) => {
    let result = await call(null)
    if (result.error && /preparó/.test(result.error.message) && hasAccess('almacen-supervisor')) {
      const reason = window.prompt('Usted participó en esta preparación. Motivo de la autorización de supervisión:')
      if (reason?.trim()) result = await call(reason.trim())
    }
    return result
  }

  const audit = async (lpn: TaskLpn, result: string, text = '', pkgCode = '', evidence: File[] = []) => {
    setBusy(true); setError(''); setMessage('')
    const db = createClient()
    const paths: string[] = []
    for (const file of evidence) {
      const path = `${lpn.id}/${crypto.randomUUID()}.${(file.name.split('.').pop() || 'jpg').toLowerCase()}`
      const up = await db.storage.from('wh_audit_evidence').upload(path, file, { contentType: file.type, upsert: false })
      if (up.error) { setError(`No se pudo subir la foto: ${up.error.message}`); setBusy(false); return }
      paths.push(path)
    }
    const { error } = await withOverride(reason => db.rpc('wh_audit_lpn', { p_lpn_id: lpn.id, p_result: result, p_comment: text || null, p_package_code: pkgCode || null, p_evidence_paths: paths, p_override_reason: reason }))
    if (error) { setError(error.message); if (paths.length) await db.storage.from('wh_audit_evidence').remove(paths) }
    else { setMessage(`${lpn.lpn_code}: ${result === 'COMENTARIO' ? 'evidencia registrada' : (result === 'APROBADO' ? 'liberado por Auditoría' : AUDIT[result].label.toLowerCase())}.`); setForm(null); setComment(''); setPkg(''); setFiles([]); await load() }
    setBusy(false)
  }

  const viewPhoto = async (path: string) => {
    const { data: signed, error } = await createClient().storage.from('wh_audit_evidence').createSignedUrl(path, 300)
    if (error) setError(error.message); else window.open(signed.signedUrl, '_blank', 'noopener')
  }

  const preview = async () => {
    if (!task || !data) return
    const lpns = packing ? data.lpns.filter(l => l.audit_status === 'APROBADO' && l.status !== 'VOID') : data.lpns
    const snapshot: PackingSnapshot = { packing_list_number: null, version: null, task_code: task.task_code, request_number: task.request_number, contract_code: task.contract_code,
      client_name: task.client_name, delivery_address: task.delivery_address, lots: task.lots, prepared_at: task.assigned_at, picker_name: task.picker_name, auditor_name: null, released_at: null,
      lpn_count: lpns.length, package_count: lpns.reduce((s, l) => s + l.package_count, 0), total_weight_kg: lpns.reduce((s, l) => s + Number(l.weight_kg), 0), lpns }
    window.open(String((await buildPackingListPdf(snapshot)).output('bloburl')), '_blank', 'noopener')
  }

  const download = async (id: string) => {
    const { data: snapshot, error } = await createClient().rpc('wh_print_packing_list', { p_id: id })
    if (error) { setError(error.message); return }
    ;(await buildPackingListPdf(snapshot as PackingSnapshot)).save(`${snapshot.packing_list_number}-v${snapshot.version}.pdf`)
  }

  const released = data?.packing_lists.find(p => p.status === 'LIBERADO')


  return <div className="space-y-4">
    <DispatchNav stage={mode} taskId={taskId || undefined}/>
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-xs font-bold uppercase tracking-widest text-blue-700">Despacho</p>
        <h1 className="mt-1 text-3xl font-black text-[#002855]">{stageConfig.title}</h1>
        <p className="mt-1 text-sm text-slate-600">{stageConfig.description}</p>
      </div>
      <button onClick={() => void load()} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold"><RefreshCw size={16}/>Actualizar</button>
    </header>
    {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</p>}
    {message && <p role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">{message}</p>}

    <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
      <aside className="h-fit overflow-hidden rounded-xl border border-slate-200 bg-white">
        {rows.length === 0 ? <p className="p-6 text-center text-sm text-slate-500">No hay tareas en preparación.</p> : rows.map(r => {
          const state = STATE[r.display_state] || STATE.EN_PICKING
          return <button key={r.id} onClick={() => setTaskId(r.id)} className={`block w-full border-b px-3 py-2.5 text-left text-sm last:border-0 ${r.id === taskId ? 'bg-blue-50' : 'hover:bg-slate-50'}`}>
            <span className="flex items-center justify-between gap-2"><b className="text-[#002855]">{r.request_number}</b><span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${state.style}`}>{state.label}</span></span>
            <span className="block text-xs text-slate-600">OT {r.contract_code || '—'} · {r.client_name || '—'}</span>
            <span className="block text-xs text-slate-500">{r.picker_name || 'Sin operario'} · {r.picked} paq · LPN {r.lpn_approved}/{r.lpn_total} liberados{r.lpn_pending ? ` · ${r.lpn_pending} por auditar` : ''}</span>
          </button>
        })}
      </aside>

      {task && data && loadedTaskId === taskId && <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3 text-sm">
          <span><b className="text-[#002855]">{task.request_number}</b> · OT {[task.contract_code, task.lots].filter(Boolean).join(' · ')} · {task.client_name} · operario {task.picker_name || '—'} · {fmt(task.weight_kg)} kg{data.loose.length > 0 && <b className="ml-2 text-amber-800">{data.loose.length} paquete(s) aún sin consolidar</b>}</span>
          <span className="flex gap-2">
            <button onClick={() => void preview()} className={`${btn} border border-slate-300`}><Eye size={14}/>Vista preliminar</button>
            {released ? <button onClick={() => void download(released.id)} className={`${btn} bg-emerald-700 text-white`}><Download size={14}/>{released.packing_list_number} v{released.version}</button>
              : packing ? <span className="text-xs text-slate-500">El documento final se genera al terminar Picking y liberar todos los LPN.</span> : <Link href={`/almacen/packing-list/${taskId}`} className={`${btn} border border-slate-300`}>Ir a Packing List</Link>}
          </span>
        </div>

        {data.lpns.length === 0 && <p className="rounded-xl border bg-white p-6 text-center text-sm text-slate-500">El operario aún no consolidó LPN.</p>}
        {packing && <PackingAssignment key={taskId} task={task} data={data} onChanged={async () => { await loadTask(taskId); await load() }}/> }
        {!packing && data.lpns.map(l => {
          const state = AUDIT[l.audit_status] || AUDIT.PENDIENTE
          return <article key={l.id} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <header className="flex flex-wrap items-center gap-2 border-b p-3 text-sm">
              <b className="font-mono text-[#002855]">{l.lpn_code}</b>
              <span className="text-slate-600">{l.package_count} paq · {fmt(l.quantity, 3)} und · {fmt(l.weight_kg)} kg · {l.created_by_name}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${state.style}`}>{l.audit_status === 'APROBADO' ? 'Liberado por Auditoría' : state.label}{l.audited_by_name ? ` · ${l.audited_by_name}` : ''}</span>
              {l.audit_rev > 0 && l.audit_status === 'PENDIENTE' && <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-bold text-blue-900">Corregido · nueva revisión</span>}
              {!packing && l.status === 'CLOSED' && <span className="ml-auto flex gap-1.5">
                <button disabled={busy || l.audit_status === 'APROBADO'} onClick={() => void audit(l, 'APROBADO')} className={`${btn} bg-emerald-700 text-white`}><Check size={14}/>Liberar LPN</button>
                <button disabled={busy} onClick={() => setForm({ lpn: l, result: 'OBSERVADO' })} className={`${btn} border border-amber-400 text-amber-900`}>Observar</button>
                <button disabled={busy} onClick={() => setForm({ lpn: l, result: 'RECHAZADO' })} className={`${btn} border border-rose-400 text-rose-800`}><X size={14}/>Rechazar</button>
                <button disabled={busy} onClick={() => setForm({ lpn: l, result: 'COMENTARIO' })} className={`${btn} border border-slate-300`}><Camera size={14}/>Evidencia</button>
              </span>}
            </header>
            {!packing && form?.lpn.id === l.id && <form onSubmit={e => { e.preventDefault(); void audit(l, form.result, comment.trim(), pkg, files) }} className="space-y-2 border-b bg-slate-50 p-3 text-sm">
              <b>{form.result === 'COMENTARIO' ? 'Registrar evidencia' : form.result === 'OBSERVADO' ? 'Observación (requiere corrección)' : 'Rechazo (no se libera)'}</b>
              <textarea value={comment} onChange={e => setComment(e.target.value)} required={form.result !== 'COMENTARIO'} rows={2} placeholder="Describa lo encontrado" className="w-full rounded-lg border border-slate-300 p-2"/>
              <div className="flex flex-wrap gap-2">
                <select value={pkg} onChange={e => setPkg(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5" aria-label="Paquete"><option value="">Todo el LPN</option>{l.packages.map(p => <option key={p.package_code} value={p.package_code}>{p.package_code}</option>)}</select>
                <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" multiple onChange={e => setFiles([...(e.target.files || [])])} className="text-xs" aria-label="Fotos"/>
                <span className="ml-auto flex gap-2"><button type="button" onClick={() => setForm(null)} className={`${btn} border border-slate-300`}>Cancelar</button><button disabled={busy} className={`${btn} bg-[#002855] text-white`}>{busy && <Loader2 size={14} className="animate-spin"/>}Guardar</button></span>
              </div>
            </form>}
            <div className="divide-y text-sm">{l.packages.map(p => <div key={p.package_code} className="flex flex-wrap gap-2 px-3 py-1.5"><span className="font-mono">{p.package_code}</span><small className="flex-1 text-slate-500">{p.product_code} · {p.description}{p.lot ? ` · lote ${p.lot}` : ''}</small><span>{fmt(p.quantity, 3)} {p.unit} · {p.weight_kg == null ? '—' : `${fmt(p.weight_kg)} kg`}</span></div>)}</div>
            {l.audits.length > 0 && <ul className="border-t bg-slate-50 px-3 py-2 text-xs text-slate-700">{l.audits.slice(0, 5).map(a => <li key={a.id} className="py-0.5">
              <b>{a.result === 'REINICIADO' ? 'Modificado' : a.result === 'COMENTARIO' ? 'Evidencia' : AUDIT[a.result]?.label}</b> · {a.actor_name} · {fmtDate(a.created_at)}{a.package_code ? ` · ${a.package_code}` : ''}{a.comment ? ` — ${a.comment}` : ''}{a.override_reason ? ` (autorizado: ${a.override_reason})` : ''}
              {a.evidence_paths.map((p, i) => <button key={p} onClick={() => void viewPhoto(p)} className="ml-2 font-semibold text-blue-800 underline">foto {i + 1}</button>)}
            </li>)}</ul>}
          </article>
        })}
      </section>}
    </div>
  </div>
}
