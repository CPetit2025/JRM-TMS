'use client'

import { useEffect, useMemo, useState } from 'react'
import { CalendarX2, Loader2, Plus, Scale, Trash2 } from 'lucide-react'
import { Card, Field, Modal, btn2Cls, btnCls, inputCls, useFlow } from './context'
import { LEGAL_BASIS, REFERENCES, call, fmtHours, fmtMoney, lineCost, limaLocal, today, type Detail, type Preview } from '@/lib/hhee/flujo'

// Solicitud de HHEE del Supervisor de Transporte o Despacho: actividad, causa, justificación y, por trabajador,
// horario y descanso. Las horas al 25 %, 35 % y 100 % las calcula el servidor según la ley (hhee_flow_preview) y
// el costo aproximado sale de la ficha del trabajador.
type L = { person_id: string; start: string; end: string; break_minutes: string; rest_day: boolean }
const addDay = (d: string) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10) }
const isSunday = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay() === 0

export function RequestForm({ detail, onClose, onSaved }: { detail: Detail | null; onClose: () => void; onSaved: (id: string) => Promise<void> }) {
  const { ctx } = useFlow()
  const areas = ctx.areas.filter(a => a.can_request)
  const r = detail?.request
  const [f, setF] = useState({
    area_id: r?.area_id ?? areas[0]?.id ?? '', work_date: r?.work_date ?? today(), cause_id: r?.cause_id ?? '', reference_type: r?.reference_type ?? 'SIN_REFERENCIA',
    reference_code: r?.reference_code ?? '', activity: r?.activity ?? '', justification: r?.justification ?? '', alternatives: r?.alternatives ?? '', expected_result: r?.expected_result ?? '',
  })
  const [lines, setLines] = useState<L[]>(() => detail?.lines.map(l => ({ person_id: l.person_id, start: limaLocal(l.start).slice(11), end: limaLocal(l.end).slice(11),
    break_minutes: String(l.break_minutes || 0), rest_day: !!l.rest_day })) ?? [])
  const [preview, setPreview] = useState<Preview | null>(null)
  const [calculating, setCalculating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const people = ctx.people.filter(p => p.active && p.area_id === f.area_id)
  const set = (k: keyof typeof f, v: string) => setF(x => ({ ...x, [k]: v }))
  const setLine = (i: number, k: keyof L, v: string) => setLines(x => x.map((l, j) => (j === i ? { ...l, [k]: v } : l)))

  const nextDayOf = (l: L) => !!l.start && !!l.end && l.end <= l.start
  const payloadLines = useMemo(() => lines.map(l => ({ person_id: l.person_id, start: `${f.work_date}T${l.start}`,
    end: `${nextDayOf(l) ? addDay(f.work_date) : f.work_date}T${l.end}`, break_minutes: Number(l.break_minutes || 0), rest_day: l.rest_day })), [lines, f.work_date])

  // Cálculo legal del servidor, con una breve espera mientras se escribe
  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      setCalculating(true)
      call<Preview>('hhee_flow_preview', { p: { id: r?.id, work_date: f.work_date, lines: payloadLines } })
        .then(p => { if (alive) setPreview(p) }).catch(() => { if (alive) setPreview(null) }).finally(() => { if (alive) setCalculating(false) })
    }, 350)
    return () => { alive = false; clearTimeout(t) }
  }, [payloadLines, f.work_date, r?.id])

  const calc = useMemo(() => lines.map((l, i) => {
    const pv = preview?.lines[i]?.person_id === l.person_id ? preview.lines[i] : undefined
    const person = ctx.people.find(p => p.id === l.person_id)
    const rate = person?.rate_ready ? person.base_hour_cost : null
    const m25 = pv?.m25 ?? 0, m35 = pv?.m35 ?? 0, m100 = pv?.m100 ?? 0
    return { nextDay: nextDayOf(l), pv, total: pv?.minutes ?? 0, m25, m35, m100, error: pv?.error,
      cost: ctx.caps.remuneration && pv?.minutes ? lineCost(rate, m25, m35, m100) : null, pending: !person?.rate_ready }
  }), [lines, preview, ctx.people, ctx.caps.remuneration])
  const totals = calc.reduce((t, c) => ({ min: t.min + c.total, m25: t.m25 + c.m25, m35: t.m35 + c.m35, m100: t.m100 + c.m100, cost: t.cost + (c.cost ?? 0), pending: t.pending + (c.pending ? 1 : 0) }),
    { min: 0, m25: 0, m35: 0, m100: 0, cost: 0, pending: 0 })
  const sunday = isSunday(f.work_date)
  const valid = f.area_id && f.cause_id && f.activity.trim().length >= 5 && f.justification.trim().length >= 10 && f.alternatives.trim().length >= 5
    && f.expected_result.trim().length >= 5 && lines.length > 0 && lines.every(l => l.person_id && l.start && l.end) && calc.every(c => c.total > 0 && !c.error)
    && new Set(lines.map(l => l.person_id)).size === lines.length && !calculating

  const save = async () => {
    setBusy(true); setError('')
    try {
      const res = await call<{ id: string }>('hhee_flow_request_save', { p: {
        id: r?.id, expected_version: r?.version, ...f, lines: payloadLines,
      } })
      await onSaved(res.id)
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo guardar') } finally { setBusy(false) }
  }

  return (
    <Modal title={r ? `Corregir solicitud HE-${String(r.sequence).padStart(5, '0')}` : 'Nueva solicitud de horas extras'} onClose={onClose} wide>
      {r?.approval === 'APROBADA' && <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Esta solicitud ya está aprobada. Si cambia personas u horas volverá a borrador y requerirá una nueva aprobación (se generará una nueva versión del informe).</p>}
      {r?.approval === 'OBSERVADA' && r.approval_reason && <p className="rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm text-orange-900"><strong>Observación del aprobador:</strong> {r.approval_reason}</p>}
      <Card title="1. Datos de la solicitud">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Área *"><select className={inputCls} value={f.area_id} onChange={e => { set('area_id', e.target.value); setLines([]) }}>{areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
          <Field label="Fecha del trabajo *"><input className={inputCls} type="date" value={f.work_date} onChange={e => set('work_date', e.target.value)} /></Field>
          <Field label="Causa *"><select className={inputCls} value={f.cause_id} onChange={e => set('cause_id', e.target.value)}><option value="">Elija la causa</option>{ctx.causes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Referencia"><div className="flex gap-2">
            <select aria-label="Tipo de referencia" className={`${inputCls} w-36`} value={f.reference_type} onChange={e => set('reference_type', e.target.value)}>{REFERENCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            {f.reference_type !== 'SIN_REFERENCIA' && <input aria-label="Número de referencia" className={inputCls} value={f.reference_code} onChange={e => set('reference_code', e.target.value)} placeholder="N.°" maxLength={100} />}
          </div></Field>
          <Field label="Actividad a realizar *" className="sm:col-span-2 lg:col-span-4"><input className={inputCls} value={f.activity} onChange={e => set('activity', e.target.value)} maxLength={300} placeholder="Ej. Carga y despacho de pedidos adicionales" /></Field>
          <Field label="¿Por qué se necesitan las horas extras? *" className="sm:col-span-2"><textarea className={inputCls} rows={3} value={f.justification} onChange={e => set('justification', e.target.value)} maxLength={3000} /></Field>
          <Field label="¿Qué alternativa se evaluó para evitarlas? *" className="sm:col-span-2"><textarea className={inputCls} rows={3} value={f.alternatives} onChange={e => set('alternatives', e.target.value)} maxLength={2000} /></Field>
          <Field label="Resultado esperado *" className="sm:col-span-2 lg:col-span-4"><input className={inputCls} value={f.expected_result} onChange={e => set('expected_result', e.target.value)} maxLength={1000} placeholder="Ej. 12 despachos completados antes de las 22:00" /></Field>
        </div>
      </Card>
      <Card title="2. Trabajadores y horas" subtitle="Indique el horario del trabajo extra y el descanso. Las horas al 25 %, 35 % y 100 % se calculan automáticamente según la ley."
        actions={<button type="button" className={btn2Cls} onClick={() => setLines(x => [...x, { person_id: '', start: '18:00', end: '20:00', break_minutes: '0', rest_day: sunday }])} disabled={lines.length >= 50 || !people.length}><Plus className="h-4 w-4" /> Agregar trabajador</button>}>
        <p className="mb-3 flex gap-2 rounded-lg bg-slate-50 p-2.5 text-[11px] leading-snug text-slate-600"><Scale className="mt-0.5 h-4 w-4 shrink-0 text-[#002855]" />
          <span>{LEGAL_BASIS} Las 2 primeras horas se cuentan por trabajador y por día, sumando sus otras solicitudes del mismo día.</span></p>
        {preview?.holiday && <p className="mb-3 flex items-center gap-2 rounded-lg border border-violet-200 bg-violet-50 p-2.5 text-sm text-violet-900"><CalendarX2 className="h-4 w-4" /> Feriado: <strong>{preview.holiday}</strong>. Todas las horas se pagan al 100 %.</p>}
        {!preview?.holiday && sunday && <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900">Domingo: marque «Su día de descanso» en cada trabajador cuyo descanso semanal sea hoy (se paga al 100 %).</p>}
        {!people.length && <p className="text-sm text-amber-800">No hay personal activo en el área. Regístrelo en la ventana Personal.</p>}
        <div className="grid gap-3">
          {lines.map((l, i) => {
            const c = calc[i]
            return <div key={i} className="grid gap-2 rounded-lg border border-slate-200 bg-white p-3">
              <div className="grid gap-2 sm:grid-cols-[minmax(200px,2fr)_repeat(3,minmax(80px,1fr))_auto]">
                <Field label={`Trabajador ${i + 1}`}><select aria-label={`Trabajador ${i + 1}`} className={inputCls} value={l.person_id} onChange={e => setLine(i, 'person_id', e.target.value)}>
                  <option value="">Elija</option>{people.map(p => <option key={p.id} value={p.id} disabled={lines.some((x, j) => j !== i && x.person_id === p.id)}>{p.code} · {p.name}{p.rate_ready ? '' : ' (costo pendiente)'}</option>)}</select></Field>
                <Field label="Inicio"><input aria-label={`Inicio del trabajador ${i + 1}`} className={inputCls} type="time" value={l.start} onChange={e => setLine(i, 'start', e.target.value)} /></Field>
                <Field label={`Fin${c.nextDay ? ' (día sig.)' : ''}`}><input aria-label={`Fin del trabajador ${i + 1}`} className={inputCls} type="time" value={l.end} onChange={e => setLine(i, 'end', e.target.value)} /></Field>
                <Field label="Descanso (min)"><input aria-label={`Descanso del trabajador ${i + 1}`} className={inputCls} type="number" min={0} step={5} value={l.break_minutes} onChange={e => setLine(i, 'break_minutes', e.target.value)} /></Field>
                <button type="button" aria-label={`Quitar trabajador ${i + 1}`} onClick={() => setLines(x => x.filter((_, j) => j !== i))} className="self-end rounded-md p-2 text-slate-400 hover:bg-slate-100 hover:text-red-700"><Trash2 className="h-4 w-4" /></button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex min-h-9 items-center gap-2 rounded-lg border border-slate-200 px-2.5 text-xs font-semibold text-slate-600">
                  <input type="checkbox" aria-label={`Día de descanso del trabajador ${i + 1}`} className="h-4 w-4" checked={l.rest_day} disabled={!!preview?.holiday}
                    onChange={e => setLines(x => x.map((y, j) => (j === i ? { ...y, rest_day: e.target.checked } : y)))} /> Su día de descanso</label>
                {c.error ? <p role="alert" className="text-xs font-semibold text-red-700">{c.error}</p> : c.total > 0 && <div className="flex flex-wrap gap-1.5" aria-label={`Horas calculadas del trabajador ${i + 1}`}>
                  {([['25 %', c.m25, 'bg-blue-50 text-blue-900'], ['35 %', c.m35, 'bg-amber-50 text-amber-900'], ['100 %', c.m100, 'bg-violet-50 text-violet-900']] as const).filter(([, m]) => m > 0)
                    .map(([lab, m, tone]) => <span key={lab} className={`rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}>{fmtHours(m)} al {lab}</span>)}
                </div>}
                <p className="ml-auto text-xs text-slate-500">
                  {calculating ? <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Calculando…</span> : <>Total <strong className="text-slate-800">{fmtHours(c.total)}</strong></>}
                  {!!c.pv?.prior && <> · ya tiene {fmtHours(c.pv.prior)} extra ese día</>}
                  {ctx.caps.remuneration && c.total > 0 && <> · {c.pending ? 'Costo pendiente: completar ficha' : `≈ ${fmtMoney(c.cost)}`}</>}
                </p>
              </div>
            </div>
          })}
        </div>
        <div className="mt-3 flex flex-wrap justify-end gap-4 border-t border-slate-100 pt-3 text-sm">
          <span>Total: <strong>{fmtHours(totals.min)}</strong> · {lines.length} trabajador(es) · 25 %: {fmtHours(totals.m25)} · 35 %: {fmtHours(totals.m35)} · 100 %: {fmtHours(totals.m100)}</span>
          {ctx.caps.remuneration && <span>Costo aproximado: <strong className="text-[#002855]">{fmtMoney(Math.round(totals.cost * 100) / 100)}</strong>{totals.pending ? ` (+${totals.pending} con costo pendiente)` : ''}</span>}
        </div>
      </Card>
      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {!valid && !calculating && <span className="text-xs text-slate-500">Complete los campos con * y el horario de cada trabajador.</span>}
        <button type="button" className={btn2Cls} onClick={onClose}>Cancelar</button>
        <button type="button" className={btnCls} disabled={busy || !valid} onClick={() => void save()}>{busy ? 'Guardando…' : 'Guardar y revisar solicitud'}</button>
      </div>
    </Modal>
  )
}
