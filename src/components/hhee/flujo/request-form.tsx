'use client'

import { useMemo, useState } from 'react'
import { Plus, Trash2, Wand2 } from 'lucide-react'
import { Card, Field, Modal, btn2Cls, btnCls, inputCls, useFlow } from './context'
import { REFERENCES, call, fmtHours, fmtMoney, lineCost, limaLocal, today, type Detail } from '@/lib/hhee/flujo'

// Solicitud de HHEE del Supervisor de Transporte o Despacho: actividad, causa, justificación y, por trabajador,
// horario, descanso y horas al 25 %, 35 % y 100 %. Al guardar, el servidor calcula el costo aproximado con la ficha.
type L = { person_id: string; start: string; end: string; break_minutes: string; h25: string; h35: string; h100: string }
const addDay = (d: string) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10) }
const mins = (h: string) => Math.round(Number(h || 0) * 60)

export function RequestForm({ detail, onClose, onSaved }: { detail: Detail | null; onClose: () => void; onSaved: (id: string) => Promise<void> }) {
  const { ctx } = useFlow()
  const areas = ctx.areas.filter(a => a.can_request)
  const r = detail?.request
  const [f, setF] = useState({
    area_id: r?.area_id ?? areas[0]?.id ?? '', work_date: r?.work_date ?? today(), cause_id: r?.cause_id ?? '', reference_type: r?.reference_type ?? 'SIN_REFERENCIA',
    reference_code: r?.reference_code ?? '', activity: r?.activity ?? '', justification: r?.justification ?? '', alternatives: r?.alternatives ?? '', expected_result: r?.expected_result ?? '',
  })
  const [descanso, setDescanso] = useState(false)
  const [lines, setLines] = useState<L[]>(() => detail?.lines.map(l => ({ person_id: l.person_id, start: limaLocal(l.start).slice(11), end: limaLocal(l.end).slice(11),
    break_minutes: String(l.break_minutes || 0), h25: String((l.minutes_25 ?? 0) / 60), h35: String((l.minutes_35 ?? 0) / 60), h100: String((l.minutes_100 ?? 0) / 60) })) ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const people = ctx.people.filter(p => p.active && p.area_id === f.area_id)
  const set = (k: keyof typeof f, v: string) => setF(x => ({ ...x, [k]: v }))
  const setLine = (i: number, k: keyof L, v: string) => setLines(x => x.map((l, j) => (j === i ? { ...l, [k]: v } : l)))

  const calc = useMemo(() => lines.map(l => {
    const nextDay = !!l.start && !!l.end && l.end <= l.start
    const span = l.start && l.end ? ((Number(l.end.slice(0, 2)) * 60 + Number(l.end.slice(3))) - (Number(l.start.slice(0, 2)) * 60 + Number(l.start.slice(3))) + (nextDay ? 1440 : 0)) : 0
    const available = Math.max(0, span - Number(l.break_minutes || 0))
    const total = mins(l.h25) + mins(l.h35) + mins(l.h100)
    const person = ctx.people.find(p => p.id === l.person_id)
    const rate = person?.rate_ready ? person.base_hour_cost : null
    return { nextDay, available, total, over: total > available, cost: ctx.caps.remuneration ? lineCost(rate, mins(l.h25), mins(l.h35), mins(l.h100)) : null, pending: !person?.rate_ready }
  }), [lines, ctx.people, ctx.caps.remuneration])
  const totals = calc.reduce((t, c) => ({ min: t.min + c.total, cost: t.cost + (c.cost ?? 0), pending: t.pending + (c.pending ? 1 : 0) }), { min: 0, cost: 0, pending: 0 })

  // Reparto según ley: primeras 2 h al 25 %, el resto al 35 %; en día de descanso o feriado, todo al 100 %
  const autoSplit = (i: number) => {
    const avail = calc[i].available / 60
    setLines(x => x.map((l, j) => j !== i ? l : descanso ? { ...l, h25: '0', h35: '0', h100: String(avail) }
      : { ...l, h25: String(Math.min(2, avail)), h35: String(Math.max(0, Math.round((avail - 2) * 100) / 100)), h100: '0' }))
  }
  const valid = f.area_id && f.cause_id && f.activity.trim().length >= 5 && f.justification.trim().length >= 10 && f.alternatives.trim().length >= 5
    && f.expected_result.trim().length >= 5 && lines.length > 0 && lines.every(l => l.person_id && l.start && l.end) && calc.every(c => c.total > 0 && !c.over)
    && new Set(lines.map(l => l.person_id)).size === lines.length

  const save = async () => {
    setBusy(true); setError('')
    try {
      const res = await call<{ id: string }>('hhee_flow_request_save', { p: {
        id: r?.id, expected_version: r?.version, ...f,
        lines: lines.map((l, i) => ({ person_id: l.person_id, start: `${f.work_date}T${l.start}`, end: `${calc[i].nextDay ? addDay(f.work_date) : f.work_date}T${l.end}`,
          break_minutes: Number(l.break_minutes || 0), minutes_25: mins(l.h25), minutes_35: mins(l.h35), minutes_100: mins(l.h100) })),
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
      <Card title="2. Trabajadores y horas" subtitle="Horario del trabajo extra, descanso y horas por recargo. «Repartir» aplica: primeras 2 h al 25 % y el resto al 35 % (o todo al 100 % en descanso o feriado)."
        actions={<>
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-600"><input type="checkbox" checked={descanso} onChange={e => setDescanso(e.target.checked)} className="h-4 w-4" /> Día de descanso o feriado</label>
          <button type="button" className={btn2Cls} onClick={() => setLines(x => [...x, { person_id: '', start: '18:00', end: '20:00', break_minutes: '0', h25: '2', h35: '0', h100: '0' }])} disabled={lines.length >= 50 || !people.length}><Plus className="h-4 w-4" /> Agregar trabajador</button>
        </>}>
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
              <div className="flex flex-wrap items-end gap-2">
                {([['h25', '25 %'], ['h35', '35 %'], ['h100', '100 %']] as const).map(([k, lab]) => <Field key={k} label={`Horas al ${lab}`} className="w-28">
                  <input aria-label={`Horas al ${lab} del trabajador ${i + 1}`} className={`${inputCls} text-right`} type="number" min={0} step={0.25} value={l[k]} onChange={e => setLine(i, k, e.target.value)} /></Field>)}
                <button type="button" className={btn2Cls} onClick={() => autoSplit(i)} title="Repartir el horario disponible según ley"><Wand2 className="h-4 w-4" /> Repartir</button>
                <p className={`ml-auto text-xs ${c.over ? 'font-semibold text-red-700' : 'text-slate-500'}`}>
                  {fmtHours(c.total)} de {fmtHours(c.available)} disponibles{c.over ? ' · supera el horario menos el descanso' : ''}
                  {ctx.caps.remuneration && <> · {c.pending ? 'Costo pendiente: completar ficha' : `≈ ${fmtMoney(c.cost)}`}</>}
                </p>
              </div>
            </div>
          })}
        </div>
        <div className="mt-3 flex flex-wrap justify-end gap-4 border-t border-slate-100 pt-3 text-sm">
          <span>Total: <strong>{fmtHours(totals.min)}</strong> · {lines.length} trabajador(es)</span>
          {ctx.caps.remuneration && <span>Costo aproximado: <strong className="text-[#002855]">{fmtMoney(Math.round(totals.cost * 100) / 100)}</strong>{totals.pending ? ` (+${totals.pending} con costo pendiente)` : ''}</span>}
        </div>
      </Card>
      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {!valid && <span className="text-xs text-slate-500">Complete los campos con * y las horas de cada trabajador.</span>}
        <button type="button" className={btn2Cls} onClick={onClose}>Cancelar</button>
        <button type="button" className={btnCls} disabled={busy || !valid} onClick={() => void save()}>{busy ? 'Guardando…' : 'Guardar y revisar solicitud'}</button>
      </div>
    </Modal>
  )
}
