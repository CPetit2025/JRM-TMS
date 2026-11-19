'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { fmt, fmtDate } from '@/lib/warehouse/packing-list'
import { ACTIONS, AREAS, EXCEPTION_STATUS, FINDING_CATEGORIES, FINDING_STATUS, SEVERITIES, type Finding } from './findings'

const btn = 'rounded-lg px-2.5 py-1.5 text-xs font-bold disabled:opacity-50'

/** Un hallazgo con su alcance, masa y pendiente, historial y las acciones que el usuario puede hacer (el servidor valida todo). */
export function FindingCard({ f, userId, onChanged }: { f: Finding; userId: string; onChanged: () => Promise<void> }) {
  const { hasAccess } = usePermissions()
  const [open, setOpen] = useState(false)
  const [action, setAction] = useState('')
  const [comment, setComment] = useState('')
  const [qty, setQty] = useState<Record<number, string>>({})
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [until, setUntil] = useState('')
  const audit = hasAccess('almacen-auditoria') || hasAccess('almacen-supervisor')
  const ops = ['almacen-picking', 'almacen-packing', 'almacen-carga', 'almacen-supervisor'].some(hasAccess)
  const mine = f.assigned_to === userId || (!f.assigned_to && ops) || hasAccess('almacen-supervisor')
  const corrector = f.events.some(e => ['START', 'CORRECTED'].includes(e.action) && e.by_id === userId)
  const st = FINDING_STATUS[f.status] || FINDING_STATUS.ABIERTO
  const [now] = useState(() => Date.now())
  const overdue = f.due_at && f.status !== 'CERRADO' && Date.parse(f.due_at) < now

  const run = async (act: string, needsLines = false) => {
    setBusy(true); setError('')
    const db = createClient(); const paths: string[] = []
    for (const file of files) {
      const path = `hallazgos/${f.id}/${crypto.randomUUID()}.${(file.name.split('.').pop() || 'jpg').toLowerCase()}`
      const up = await db.storage.from('wh_audit_evidence').upload(path, file, { contentType: file.type, upsert: false })
      if (up.error) { setError(`No se pudo subir la foto: ${up.error.message}`); setBusy(false); return }
      paths.push(path)
    }
    const key = act === 'CORRECTED' ? 'corrected_qty' : 'verified_qty'
    const lines = needsLines ? f.lines.filter(l => qty[l.id] !== undefined && qty[l.id] !== '').map(l => ({ line_id: l.id, [key]: Number(qty[l.id]) })) : []
    const r = await db.rpc('wh_finding_action', { p_finding_id: f.id, p_action: act, p_comment: comment.trim() || null, p_lines: lines, p_evidence_paths: paths })
    setBusy(false)
    if (r.error) { setError(r.error.message); if (paths.length) await db.storage.from('wh_audit_evidence').remove(paths); return }
    setAction(''); setComment(''); setQty({}); setFiles([]); await onChanged()
  }
  // Excepción (solo hallazgos menores): la solicita cualquiera del almacén; decide Jefatura (supervisión), nunca quien la pidió
  const exceptionCall = async (fn: () => PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true); setError(''); const r = await fn(); setBusy(false)
    if (r.error) { setError(r.error.message); return } setAction(''); setComment(''); setUntil(''); await onChanged()
  }
  const live = (f.exceptions || []).find(x => x.status === 'SOLICITADA' || x.status === 'APROBADA')
  const photo = async (path: string) => {
    const { data, error: e } = await createClient().storage.from('wh_audit_evidence').createSignedUrl(path, 300)
    if (e) setError(e.message); else window.open(data.signedUrl, '_blank', 'noopener')
  }
  const choices: [string, string, boolean][] = [
    ['START', 'Iniciar corrección', f.status === 'ABIERTO' && mine && f.created_by !== userId],
    ['CORRECTED', 'Registrar corrección', ['ABIERTO', 'EN_CORRECCION'].includes(f.status) && mine && f.created_by !== userId],
    ['VERIFY_OK', 'Verificar conforme', f.status === 'PENDIENTE_VERIFICACION' && audit && !corrector],
    ['VERIFY_REJECT', 'No conforme', f.status === 'PENDIENTE_VERIFICACION' && audit && !corrector],
    ['REOPEN', 'Reabrir', f.status === 'CERRADO' && audit],
    ['CAUSE', 'Confirmar causa', audit],
    ['COMMENT', 'Comentar / foto', audit || ops],
    ['EXCEPTION', 'Solicitar excepción', f.exceptionable && f.status !== 'CERRADO' && !live && (audit || ops)],
  ]
  const needsComment = ['CORRECTED', 'VERIFY_REJECT', 'REOPEN', 'CAUSE'].includes(action)
  const withLines = action === 'CORRECTED' || action === 'VERIFY_OK'

  return <article className="rounded-xl border border-slate-200 bg-white text-sm">
    <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} className="flex w-full flex-wrap items-center gap-2 p-3 text-left">
      <b className="font-mono text-[#002855]">{f.code}</b>
      <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${st.style}`}>{st.label}</span>
      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold">{SEVERITIES[f.severity]}</span>
      <span className="text-slate-700">{f.categories.map(c => FINDING_CATEGORIES[c] || c).join(' · ')}</span>
      <span className="ml-auto text-xs text-slate-600">{f.request_number || f.task_code} · {f.lpn_code} · {f.kg == null ? 'masa sin dato' : `${fmt(f.kg)} kg`}{f.kg_sin_peso > 0 ? ` (+${f.kg_sin_peso} sin peso)` : ''}{f.status !== 'CERRADO' && f.kg_pendiente != null ? ` · pendiente ${fmt(f.kg_pendiente)} kg` : ''}</span>
    </button>
    {open && <div className="space-y-3 border-t p-3">
      <p>{f.description}</p>
      <p className="text-xs text-slate-600">Registró {f.created_name} · {fmtDate(f.created_at)} · Área que corrige: {AREAS[f.area] || f.area} · Responsable: {f.assigned_name || 'sin asignar'}
        {f.due_at && <span className={overdue ? 'font-semibold text-rose-700' : ''}> · Compromiso {fmtDate(f.due_at)}{overdue ? ' (vencido)' : ''}</span>}
        {f.audit_rev !== f.lpn_rev && <span className="font-semibold text-amber-800"> · registrado sobre la revisión {f.audit_rev} (vigente: {f.lpn_rev})</span>}
        {f.exceptionable && (f.excepted ? ' · con excepción vigente' : ' · admite excepción de Jefatura')}{f.reopen_count > 0 && ` · reabierto ${f.reopen_count} vez/veces`}{f.cause && ` · Causa: ${f.cause}`}</p>
      <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-xs">
        <thead className="bg-slate-50 text-slate-600"><tr><th className="p-1.5 text-left">Paquete</th><th className="p-1.5 text-left">SKU · componente</th><th className="p-1.5 text-right">Afectado</th><th className="p-1.5 text-right">Masa</th><th className="p-1.5 text-right">Corregido</th><th className="p-1.5 text-right">Verificado</th>{withLines && <th className="p-1.5 text-right">{action === 'CORRECTED' ? 'Corregido ahora' : 'Verificado ahora'}</th>}</tr></thead>
        <tbody>{f.lines.map(l => <tr key={l.id} className="border-t">
          <td className="p-1.5 font-mono">{l.package_code}{!l.declared && <small className="ml-1 rounded bg-amber-100 px-1 text-amber-900">no declarado</small>}</td>
          <td className="p-1.5">{l.product_code} · {l.contract_code}</td>
          <td className="p-1.5 text-right">{fmt(l.quantity, 3)} {l.unit}</td>
          <td className="p-1.5 text-right">{l.kg == null ? 'sin peso' : `${fmt(l.kg)} kg`}<small className="block text-slate-500">{l.weight_state.toLowerCase()}</small></td>
          <td className="p-1.5 text-right">{fmt(l.corrected_qty, 3)}</td><td className="p-1.5 text-right">{fmt(l.verified_qty, 3)}</td>
          {withLines && <td className="p-1.5 text-right"><input type="number" min="0" max={l.quantity} step="any" placeholder={String(action === 'CORRECTED' ? l.quantity : l.corrected_qty)} value={qty[l.id] ?? ''} onChange={e => setQty({ ...qty, [l.id]: e.target.value })} aria-label={`Cantidad ${l.package_code}`} className="w-20 rounded border px-1 py-0.5 text-right"/></td>}
        </tr>)}</tbody></table></div>
      {error && <p role="alert" className="rounded-lg bg-rose-50 p-2 text-rose-900">{error}</p>}
      <div className="flex flex-wrap gap-2">{choices.filter(c => c[2]).map(([k, label]) => <button key={k} type="button" disabled={busy}
        onClick={() => k === 'START' ? void run('START') : setAction(action === k ? '' : k)} className={`${btn} ${action === k ? 'bg-[#002855] text-white' : 'border border-slate-300'}`}>{label}</button>)}</div>
      {(f.exceptions || []).length > 0 && <ul className="space-y-1 rounded-lg border border-blue-100 bg-blue-50/50 p-2 text-xs">{(f.exceptions || []).map(x => <li key={x.id} className="flex flex-wrap items-center gap-2">
        <b>Excepción {EXCEPTION_STATUS[x.status] || x.status}</b><span>· {x.reason} · vigente hasta {fmtDate(x.valid_until)} · pidió {x.requested_name}{x.decided_name ? ` · decidió ${x.decided_name}` : ''}{x.revoke_reason ? ` · ${x.revoke_reason}` : ''}{x.audit_rev !== f.lpn_rev && x.status === 'APROBADA' ? ' · sin efecto: el LPN cambió de composición' : ''}</span>
        {hasAccess('almacen-supervisor') && x.status === 'SOLICITADA' && x.requested_by !== userId && <span className="ml-auto flex gap-1">
          <button type="button" disabled={busy} onClick={() => void exceptionCall(() => createClient().rpc('wh_exception_decide', { p_id: x.id, p_action: 'APPROVE', p_comment: null }))} className={`${btn} bg-emerald-700 text-white`}>Autorizar</button>
          <button type="button" disabled={busy} onClick={() => { const c = window.prompt('Motivo del rechazo:'); if (c?.trim()) void exceptionCall(() => createClient().rpc('wh_exception_decide', { p_id: x.id, p_action: 'REJECT', p_comment: c.trim() })) }} className={`${btn} border border-slate-300`}>Rechazar</button></span>}
        {hasAccess('almacen-supervisor') && x.status === 'APROBADA' && <button type="button" disabled={busy} onClick={() => { const c = window.prompt('Motivo de la revocación:'); if (c?.trim()) void exceptionCall(() => createClient().rpc('wh_exception_decide', { p_id: x.id, p_action: 'REVOKE', p_comment: c.trim() })) }} className={`${btn} ml-auto border border-rose-300 text-rose-800`}>Revocar</button>}
      </li>)}</ul>}
      {action === 'EXCEPTION' && <div className="space-y-2 rounded-lg bg-slate-50 p-2">
        <p className="text-xs text-slate-600">Vale solo para este hallazgo, este LPN y su composición actual. Si vence, se revoca o cambia la composición, el LPN vuelve a quedar observado.</p>
        <textarea value={comment} onChange={e => setComment(e.target.value)} rows={2} placeholder="Motivo (mín. 10 caracteres)" className="w-full rounded-lg border border-slate-300 p-2"/>
        <div className="flex flex-wrap items-end gap-2"><label className="text-xs font-semibold">Vigente hasta<input type="datetime-local" value={until} onChange={e => setUntil(e.target.value)} className="ml-1 rounded border px-2 py-1"/></label>
          <button type="button" disabled={busy || comment.trim().length < 10 || !until} onClick={() => void exceptionCall(() => createClient().rpc('wh_exception_request', { p_finding_id: f.id, p_reason: comment.trim(), p_valid_until: new Date(until).toISOString(), p_conditions: null, p_evidence_paths: [] }))} className={`${btn} ml-auto bg-[#002855] text-white`}>Solicitar</button></div>
      </div>}
      {action && action !== 'EXCEPTION' && <div className="space-y-2 rounded-lg bg-slate-50 p-2">
        <textarea value={comment} onChange={e => setComment(e.target.value)} rows={2} placeholder={needsComment ? 'Obligatorio' : 'Comentario (opcional)'} className="w-full rounded-lg border border-slate-300 p-2"/>
        <div className="flex flex-wrap items-center gap-2">
          <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" multiple onChange={e => setFiles([...(e.target.files || [])])} className="text-xs" aria-label="Fotos"/>
          {withLines && <small className="text-slate-500">Sin cantidades se toma {action === 'CORRECTED' ? 'todo lo afectado' : 'todo lo corregido'}.</small>}
          <button type="button" disabled={busy || (needsComment && !comment.trim())} onClick={() => void run(action, withLines)} className={`${btn} ml-auto bg-[#002855] text-white`}>{busy ? 'Guardando…' : 'Guardar'}</button>
        </div>
      </div>}
      <ol className="space-y-1 text-xs text-slate-700">{f.events.map((e, i) => <li key={i}><b>{ACTIONS[e.action] || e.action}</b> · {e.by} · {fmtDate(e.at)}{e.to && e.to !== e.from ? ` · ${FINDING_STATUS[e.to]?.label || e.to}` : ''}{e.comment ? ` — ${e.comment}` : ''}
        {e.evidence_paths.map((p, j) => <button key={p} type="button" onClick={() => void photo(p)} className="ml-2 font-semibold text-blue-800 underline">foto {j + 1}</button>)}</li>)}</ol>
    </div>}
  </article>
}
