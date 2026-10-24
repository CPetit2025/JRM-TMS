'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowDown, ArrowUp, ArrowUpDown, Download, FileUp, Link2, Loader2, Plus, Search, Trash2, Truck } from 'lucide-react'
import * as XLSX from 'xlsx'
import { Card, Field, Modal, btn2Cls, btnCls, inputCls, useFlow } from './context'
import { RECARGOS, baseRate, call, fmtDate, fmtDateTime, fmtHours, fmtMoney, fmtNum, today, type CompList, type Concept, type Person, type UnifyIssue, type UnifyReport } from '@/lib/hhee/flujo'

// Personal: ficha de cada trabajador con su jornada de referencia y remuneración; calcula la hora normal y las
// tarifas de HHEE al 25 %, 35 % y 100 %. Sin divisor confirmado o sin conceptos computables: «costo pendiente».
export function Personal() {
  const { ctx, reload } = useFlow()
  const [q, setQ] = useState('')
  const [estado, setEstado] = useState<'activos' | 'todos' | 'pendientes'>('activos')
  const [edit, setEdit] = useState<Person | 'new' | null>(null)
  const [history, setHistory] = useState<Person | null>(null)
  const [bank, setBank] = useState<Person | null>(null)
  const [importing, setImporting] = useState(false)
  const [unifying, setUnifying] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 })
  const people = useMemo(() => ctx.people.filter(p => (estado === 'todos' || (estado === 'activos' ? p.active : p.active && !p.rate_ready))
    && (!q.trim() || `${p.code} ${p.name} ${p.document_number ?? ''} ${p.position ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())))
    .sort((a, b) => {
      const va = SORT_VALUE[sort.key](a), vb = SORT_VALUE[sort.key](b)
      // Sin dato siempre al final, en cualquier sentido
      if (va == null || vb == null) return va == null && vb == null ? 0 : va == null ? 1 : -1
      const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'es', { numeric: true, sensitivity: 'base' })
      return (c || a.name.localeCompare(b.name, 'es')) * sort.dir
    }), [ctx.people, q, estado, sort])
  const toggle = (key: SortKey) => setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))
  const pendientes = ctx.people.filter(p => p.active && !p.rate_ready).length
  const showPay = ctx.caps.remuneration
  return (
    <div className="grid gap-4">
      <Card title="Personal" subtitle={`${ctx.people.filter(p => p.active).length} trabajadores activos${pendientes ? ` · ${pendientes} con costo pendiente (completar ficha)` : ''}`}
        actions={ctx.caps.people && <>
          <button type="button" className={btn2Cls} onClick={() => setUnifying(true)}><Link2 className="h-4 w-4" /> Unificar con Flota</button>
          <button type="button" className={btn2Cls} onClick={() => setImporting(true)}><FileUp className="h-4 w-4" /> Importar Excel</button>
          <button type="button" className={btnCls} onClick={() => setEdit('new')}><Plus className="h-4 w-4" /> Registrar trabajador</button>
        </>}>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Field label="Buscar" className="min-w-56 flex-1"><span className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-2"><Search className="h-4 w-4 text-slate-400" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Código, nombre, documento o cargo" className="min-h-9 w-full text-sm outline-none" /></span></Field>
          <Field label="Mostrar"><select className={inputCls} value={estado} onChange={e => setEstado(e.target.value as typeof estado)}>
            <option value="activos">Activos</option><option value="pendientes">Con costo pendiente</option><option value="todos">Todos (incluye inactivos)</option></select></Field>
        </div>
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500"><tr>
              <SortTh sort={sort} onSort={toggle} k="code" label="Código" /><SortTh sort={sort} onSort={toggle} k="name" label="Trabajador" /><SortTh sort={sort} onSort={toggle} k="position" label="Cargo / área" /><SortTh sort={sort} onSort={toggle} k="monthly_hours" label="Jornada" />
              {showPay && <><SortTh sort={sort} onSort={toggle} k="rate" label="Hora normal" right />{RECARGOS.map(r => <SortTh key={r.key} sort={sort} onSort={toggle} k="rate" label={`HHEE ${r.label}`} right />)}</>}
              <SortTh sort={sort} onSort={toggle} k="comp" label="Bolsa de horas" right /><SortTh sort={sort} onSort={toggle} k="status" label="Estado" /><th className="p-2.5" />
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {people.map(p => <tr key={p.id} className={p.active ? 'hover:bg-slate-50' : 'bg-slate-50 text-slate-400'}>
                <td className="p-2.5 font-mono text-xs">{p.code}</td>
                <td className="p-2.5"><p className="font-semibold text-slate-800">{p.name}</p><p className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">{p.document_number ? `DNI ${p.document_number}` : 'Sin documento'}
                  {p.master === 'FLOTA' && <span title="Nombre y DNI enlazados al conductor de Flota" className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-1.5 py-0.5 font-semibold text-blue-800"><Truck className="h-3 w-3" /> Conductor · Flota</span>}
                  {p.master === 'MAESTROS' && <span title="Nombre y DNI enlazados al trabajador de Maestros" className="rounded-full bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-700">Maestros</span>}</p></td>
                <td className="p-2.5"><p>{p.position || '—'}</p><p className="text-[11px] text-slate-500">{p.area_name}</p></td>
                <td className="p-2.5 text-xs">{fmtNum(p.daily_hours, 2)} h/día · divisor {fmtNum(p.monthly_hours, 2)} h<p className={p.divisor_confirmed ? 'text-emerald-700' : 'font-semibold text-amber-700'}>{p.divisor_confirmed ? 'Divisor confirmado' : 'Divisor sin confirmar'}</p></td>
                {showPay && <><td className="p-2.5 text-right tabular-nums">{p.rate_ready ? fmtMoney(p.base_hour_cost) : '—'}</td>
                  {RECARGOS.map(r => <td key={r.key} className="p-2.5 text-right tabular-nums">{p.rate_ready && p.base_hour_cost != null ? fmtMoney(p.base_hour_cost * r.factor) : '—'}</td>)}</>}
                <td className="p-2.5 text-right tabular-nums">{p.comp_balance ? <button type="button" className="font-semibold text-[#002855] underline" onClick={() => setBank(p)}>{fmtHours(p.comp_balance)}</button> : <span className="text-slate-400">—</span>}</td>
                <td className="p-2.5">{!p.active ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold">Inactivo</span>
                  : p.rate_ready ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">Ficha completa</span>
                  : <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-900">Costo pendiente: completar ficha</span>}</td>
                <td className="p-2.5 text-right"><div className="flex justify-end gap-1">
                  {ctx.caps.people && <button type="button" className="rounded-md px-2 py-1 text-xs font-semibold text-[#002855] underline" onClick={() => setEdit(p)}>Editar ficha</button>}
                  {showPay && <button type="button" className="rounded-md px-2 py-1 text-xs font-semibold text-[#002855] underline" onClick={() => setHistory(p)}>Historial</button>}
                  <button type="button" className="rounded-md px-2 py-1 text-xs font-semibold text-[#002855] underline" onClick={() => setBank(p)}>Bolsa</button>
                </div></td>
              </tr>)}
            </tbody>
          </table>
          {!people.length && <p className="p-6 text-center text-sm text-slate-400">Sin trabajadores con ese filtro.</p>}
        </div>
        {!showPay && <p className="mt-3 text-xs text-slate-500">La remuneración y las tarifas solo las ve quien tiene el permiso de costos o administra el personal.</p>}
      </Card>
      {edit && <PersonForm person={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await reload() }} />}
      {history && <HistoryModal person={history} onClose={() => setHistory(null)} />}
      {bank && <CompModal person={bank} canEdit={ctx.caps.people} onClose={() => setBank(null)} onChanged={reload} />}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={reload} />}
      {unifying && <UnifyModal onClose={() => setUnifying(false)} onDone={reload} />}
    </div>
  )
}

type SortKey = 'code' | 'name' | 'position' | 'monthly_hours' | 'rate' | 'comp' | 'status'
const SORT_VALUE: Record<SortKey, (p: Person) => string | number | null> = {
  code: p => p.code,
  name: p => p.name,
  position: p => [p.position, p.area_name].filter(Boolean).join(' ') || null,
  monthly_hours: p => p.monthly_hours,
  rate: p => (p.rate_ready ? p.base_hour_cost ?? null : null),
  comp: p => p.comp_balance ?? 0,
  status: p => (!p.active ? 2 : p.rate_ready ? 1 : 0),
}

function SortTh({ k, label, right = false, sort, onSort }: { k: SortKey; label: string; right?: boolean; sort: { key: SortKey; dir: 1 | -1 }; onSort: (k: SortKey) => void }) {
  const on = sort.key === k, Icon = on ? (sort.dir === 1 ? ArrowUp : ArrowDown) : ArrowUpDown
  return <th className="p-0" aria-sort={on ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
    <button type="button" onClick={() => onSort(k)} title={`Ordenar por ${label.toLowerCase()}`}
      className={`flex w-full items-center gap-1 whitespace-nowrap p-2.5 uppercase tracking-wide hover:text-slate-800 ${right ? 'justify-end' : ''} ${on ? 'text-[#002855]' : ''}`}>
      {label}<Icon className={`h-3.5 w-3.5 shrink-0 ${on ? '' : 'opacity-40'}`} /></button></th>
}

const DEFAULT_CONCEPTS: Concept[] = [{ name: 'Básico', amount: 0, computable: true }, { name: 'Asignación familiar', amount: 0, computable: true }]

function PersonForm({ person, onClose, onSaved }: { person: Person | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const { ctx } = useFlow()
  const areas = ctx.areas
  const linked = person?.master === 'FLOTA' ? 'Flota (conductor)' : person?.master === 'MAESTROS' ? 'Maestros → Trabajadores' : null
  const [f, setF] = useState({
    code: person?.code ?? '', name: person?.name ?? '', document_number: person?.document_number ?? '', position: person?.position ?? '',
    area_id: person?.area_id ?? areas[0]?.id ?? '', active: person?.active ?? true, daily_hours: String(person?.daily_hours ?? 8),
    monthly_hours: String(person?.monthly_hours ?? 240), divisor_confirmed: person?.divisor_confirmed ?? false,
    effective_from: person?.effective_from ?? today(),
  })
  const [concepts, setConcepts] = useState<Array<{ name: string; amount: string; computable: boolean }>>(
    (person?.remuneration_concepts?.length ? person.remuneration_concepts : DEFAULT_CONCEPTS).map(c => ({ name: c.name, amount: c.amount ? String(c.amount) : '', computable: c.computable })))
  const [sim, setSim] = useState({ m25: '2', m35: '0', m100: '0' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const parsed: Concept[] = concepts.filter(c => c.name.trim()).map(c => ({ name: c.name.trim(), amount: Math.round(Number(c.amount || 0) * 100) / 100, computable: c.computable }))
  const divisor = Number(f.monthly_hours)
  const base = parsed.filter(c => c.computable).reduce((t, c) => t + c.amount, 0)
  const rate = baseRate(parsed, divisor)
  const usable = rate != null && rate > 0 && f.divisor_confirmed
  const simCost = usable ? rate * (Number(sim.m25 || 0) * 1.25 + Number(sim.m35 || 0) * 1.35 + Number(sim.m100 || 0) * 2) : null
  const set = (k: keyof typeof f, v: string | boolean) => setF(x => ({ ...x, [k]: v }))
  const save = async () => {
    setBusy(true); setError('')
    try {
      await call('hhee_flow_person_save', { p: { id: person?.id, ...f, code: f.code.trim(), daily_hours: Number(f.daily_hours), monthly_hours: divisor, remuneration_concepts: parsed } })
      await onSaved()
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo guardar la ficha') } finally { setBusy(false) }
  }
  return (
    <Modal title={person ? `Ficha de ${person.name}` : 'Registrar trabajador'} onClose={onClose} wide>
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="grid gap-4">
          <Card title="Identificación">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Código *"><input className={inputCls} value={f.code} onChange={e => set('code', e.target.value.toUpperCase())} maxLength={50} /></Field>
              <Field label="Documento de identidad" hint={linked ? `Se corrige en ${linked}` : 'Con el DNI de un conductor se enlaza a Flota y toma su nombre'}>
                <input className={inputCls} value={f.document_number} onChange={e => set('document_number', e.target.value)} maxLength={20} inputMode="numeric" disabled={!!linked} /></Field>
              <Field label="Nombres y apellidos *" className="sm:col-span-2" hint={linked ? `Viene de ${linked}; si cambia allá se actualiza aquí` : undefined}>
                <input className={inputCls} value={f.name} onChange={e => set('name', e.target.value)} maxLength={160} disabled={!!linked} /></Field>
              <Field label="Cargo"><input className={inputCls} value={f.position} onChange={e => set('position', e.target.value)} maxLength={100} placeholder="Ej. Operario de despacho" /></Field>
              <Field label="Área *"><select className={inputCls} value={f.area_id} onChange={e => set('area_id', e.target.value)}>{areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.active} onChange={e => set('active', e.target.checked)} className="h-4 w-4" /> Activo (aparece en las solicitudes)</label>
            </div>
          </Card>
          <Card title="Jornada de referencia" subtitle="El divisor mensual convierte la remuneración mensual en tarifa por hora">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Horas diarias"><input className={inputCls} type="number" min={1} max={24} step={0.5} value={f.daily_hours} onChange={e => set('daily_hours', e.target.value)} /></Field>
              <Field label="Divisor mensual (horas)" hint="Referencia usual: 240 (30 días × 8 h)"><input className={inputCls} type="number" min={1} max={744} step={0.5} value={f.monthly_hours} onChange={e => set('monthly_hours', e.target.value)} /></Field>
              <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={f.divisor_confirmed} onChange={e => set('divisor_confirmed', e.target.checked)} className="mt-0.5 h-4 w-4" />
                <span>Confirmo el divisor mensual aplicable a este trabajador. <span className="text-slate-500">Sin confirmar no se calcula el costo.</span></span></label>
            </div>
          </Card>
          <Card title="Remuneración mensual" subtitle="Marque como computables los conceptos que integran la base para las horas extras"
            actions={<button type="button" className={btn2Cls} onClick={() => setConcepts(c => [...c, { name: '', amount: '', computable: true }])} disabled={concepts.length >= 20}><Plus className="h-4 w-4" /> Concepto</button>}>
            <div className="grid gap-2">
              {concepts.map((c, i) => <div key={i} className="grid grid-cols-[1fr_130px_auto_auto] items-center gap-2">
                <input aria-label={`Concepto ${i + 1}`} className={inputCls} value={c.name} placeholder="Concepto" onChange={e => setConcepts(x => x.map((y, j) => j === i ? { ...y, name: e.target.value } : y))} />
                <input aria-label={`Importe mensual ${i + 1}`} className={`${inputCls} text-right`} type="number" min={0} step={0.01} value={c.amount} placeholder="0.00" onChange={e => setConcepts(x => x.map((y, j) => j === i ? { ...y, amount: e.target.value } : y))} />
                <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={c.computable} onChange={e => setConcepts(x => x.map((y, j) => j === i ? { ...y, computable: e.target.checked } : y))} className="h-4 w-4" /> Computable</label>
                <button type="button" aria-label={`Quitar concepto ${i + 1}`} onClick={() => setConcepts(x => x.filter((_, j) => j !== i))} className="rounded-md p-2 text-slate-400 hover:bg-slate-100 hover:text-red-700"><Trash2 className="h-4 w-4" /></button>
              </div>)}
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Vigente desde" hint="Los cambios posteriores no alteran las autorizaciones ya aprobadas"><input className={inputCls} type="date" value={f.effective_from} onChange={e => set('effective_from', e.target.value)} /></Field>
            </div>
          </Card>
        </div>
        <div className="grid content-start gap-4">
          <Card title="Resultado automático">
            <dl className="grid gap-2 text-sm">
              <div className="flex justify-between"><dt className="text-slate-500">Base computable mensual</dt><dd className="font-semibold tabular-nums">{fmtMoney(base)}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Divisor mensual</dt><dd className="tabular-nums">{fmtNum(divisor, 2)} h</dd></div>
              <div className="flex justify-between border-t border-slate-100 pt-2"><dt className="font-semibold">Hora normal</dt><dd className="font-bold tabular-nums text-[#002855]">{rate != null ? fmtMoney(rate) : '—'}</dd></div>
              {RECARGOS.map(r => <div key={r.key} className="flex justify-between"><dt className="text-slate-500">HHEE al {r.label}</dt><dd className="font-semibold tabular-nums">{rate != null ? fmtMoney(rate * r.factor) : '—'}</dd></div>)}
            </dl>
            {!usable && <p className="mt-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">{rate == null ? 'Ingrese al menos un concepto computable con importe.' : 'Confirme el divisor mensual para usar estas tarifas.'} Mientras tanto, las solicitudes mostrarán «Costo pendiente: completar ficha».</p>}
          </Card>
          <Card title="Simulador" subtitle="Costo aproximado de una jornada de horas extras">
            <div className="grid grid-cols-3 gap-2">
              {([['m25', '25 %'], ['m35', '35 %'], ['m100', '100 %']] as const).map(([k, l]) => <Field key={k} label={`Horas ${l}`}>
                <input className={`${inputCls} text-right`} type="number" min={0} step={0.5} value={sim[k]} onChange={e => setSim(s => ({ ...s, [k]: e.target.value }))} /></Field>)}
            </div>
            <p className="mt-3 text-sm">Costo aproximado: <strong className="tabular-nums text-[#002855]">{simCost != null ? fmtMoney(Math.round(simCost * 100) / 100) : 'Costo pendiente'}</strong></p>
          </Card>
        </div>
      </div>
      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={btn2Cls} onClick={onClose}>Cancelar</button>
        <button type="button" className={btnCls} disabled={busy || !f.code.trim() || f.name.trim().length < 3 || !f.area_id} onClick={() => void save()}>{busy ? 'Guardando…' : 'Guardar ficha de personal'}</button>
      </div>
    </Modal>
  )
}

// Bolsa de horas: horas ejecutadas marcadas «compensar con descanso» menos los descansos tomados
function CompModal({ person, canEdit, onClose, onChanged }: { person: Person; canEdit: boolean; onClose: () => void; onChanged: () => Promise<void> }) {
  const [data, setData] = useState<CompList | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = async () => {
    try { setData(await call<CompList>('hhee_comp_list', { p_person: person.id })) } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo cargar') }
  }
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) }, [person.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await fn(); await load(); await onChanged() } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo guardar') } finally { setBusy(false) }
  }
  return (
    <Modal title={`Bolsa de horas · ${person.name}`} onClose={onClose}>
      {error && <p role="alert" className="mb-2 rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      {!data ? <p className="text-sm text-slate-500">Cargando…</p> : <div className="grid gap-3 text-sm">
        <div className="grid grid-cols-3 gap-2 text-center">
          <p className="rounded-lg bg-slate-50 p-2"><span className="block text-[11px] text-slate-500">Ganadas</span><b>{fmtHours(data.balance.earned)}</b></p>
          <p className="rounded-lg bg-slate-50 p-2"><span className="block text-[11px] text-slate-500">Descansos tomados</span><b>{fmtHours(data.balance.taken)}</b></p>
          <p className="rounded-lg bg-emerald-50 p-2"><span className="block text-[11px] text-emerald-700">Saldo</span><b className="text-emerald-900">{fmtHours(data.balance.balance)}</b></p>
        </div>
        <p className="text-xs text-slate-500">Solo suman las HHEE cerradas, validadas y destinadas a compensación. Reservadas: {fmtHours(data.balance.reserved ?? 0)}. Históricas pendientes de validar: {fmtHours(data.balance.legacy_unvalidated ?? 0)}.</p>
        <Link href="/hhee/permisos" className={btn2Cls}>Gestionar permisos y compensaciones</Link>
        <div><h3 className="mb-1 text-xs font-bold uppercase text-slate-500">Horas a compensar</h3>
          {data.earned.length ? <ul className="divide-y divide-slate-100">{data.earned.map((e, i) => <li key={i} className="flex justify-between py-1"><span>{e.folio} · {fmtDate(e.work_date)}{e.route ? ` · ruta ${e.route}` : ''}</span><b>{fmtHours(e.minutes)}</b></li>)}</ul>
            : <p className="text-xs text-slate-400">Ninguna.</p>}</div>
        <div><h3 className="mb-1 text-xs font-bold uppercase text-slate-500">Descansos</h3>
          {data.rests.length ? <ul className="divide-y divide-slate-100">{data.rests.map(r => <li key={r.id} className={`flex items-center justify-between gap-2 py-1 ${r.cancelled ? 'text-slate-400 line-through' : ''}`}>
            <span>{fmtDate(r.rest_date)} · {fmtHours(r.minutes)}{r.note ? ` · ${r.note}` : ''} <small className="text-slate-500">({r.by})</small></span>
            {canEdit && !r.cancelled && !r.note?.startsWith('Permiso ') && <button type="button" className="text-xs font-semibold text-red-700 underline" disabled={busy} onClick={() => { if (window.confirm('¿Anular este descanso? Las horas vuelven a la bolsa.')) void run(() => call('hhee_comp_rest_cancel', { p_id: r.id })) }}>Anular</button>}
          </li>)}</ul> : <p className="text-xs text-slate-400">Ninguno.</p>}</div>
      </div>}
    </Modal>
  )
}

function HistoryModal({ person, onClose }: { person: Person; onClose: () => void }) {
  const [rows, setRows] = useState<Array<{ recorded_at: string; recorded_by: string; effective_from: string | null; monthly_hours: number; daily_hours: number
    divisor_confirmed: boolean; remuneration_concepts: Concept[]; base_hour_cost: number | null }> | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    call<{ rows: NonNullable<typeof rows> }>('hhee_flow_person_history', { p_person: person.id })
      .then(r => { if (alive) setRows(r.rows) }).catch(e => { if (alive) setError(e instanceof Error ? e.message : 'No se pudo cargar') })
    return () => { alive = false }
  }, [person.id])
  return (
    <Modal title={`Historial remunerativo · ${person.name}`} onClose={onClose}>
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : !rows ? <p className="text-sm text-slate-500">Cargando…</p> : !rows.length ? <p className="text-sm text-slate-500">Sin cambios registrados.</p>
        : <div className="grid gap-2">{rows.map((h, i) => <div key={i} className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
          <p className="font-semibold text-slate-800">{fmtDateTime(h.recorded_at)} · {h.recorded_by}</p>
          <p className="text-xs text-slate-500">Vigente desde {fmtDate(h.effective_from)} · divisor {fmtNum(h.monthly_hours, 2)} h {h.divisor_confirmed ? '(confirmado)' : '(sin confirmar)'} · hora normal {fmtMoney(h.base_hour_cost)}</p>
          <p className="mt-1 text-xs">{h.remuneration_concepts.map(c => `${c.name}: ${fmtMoney(c.amount)}${c.computable ? '' : ' (no computable)'}`).join(' · ') || 'Sin conceptos'}</p>
        </div>)}</div>}
    </Modal>
  )
}

// Unificar con Flota y Maestros: un DNI = una persona. Diagnóstico, enlace (Flota o Maestros mandan en nombre y DNI)
// y fichas para los conductores activos que aún no tienen (remuneración pendiente)
const KINDS: Record<UnifyIssue['kind'], { label: string; hint: string; tone: string }> = {
  CONDUCTOR_SIN_FICHA: { label: 'Conductor sin ficha', hint: 'Está activo en Flota y no tiene ficha de personal', tone: 'bg-amber-50 text-amber-900' },
  COINCIDE_SIN_ENLACE: { label: 'DNI coincide sin enlace', hint: 'El DNI está repetido en Flota o el conductor ya está enlazado a otra ficha', tone: 'bg-red-50 text-red-800' },
  NOMBRE_DISTINTO: { label: 'Nombre distinto', hint: 'Enlazado, pero el nombre aún no se actualizó', tone: 'bg-orange-50 text-orange-900' },
  SIN_DNI: { label: 'Ficha sin DNI', hint: 'Sin DNI no se puede enlazar', tone: 'bg-slate-100 text-slate-700' },
  DNI_REPETIDO_FLOTA: { label: 'DNI repetido en Flota', hint: 'Dos conductores con el mismo DNI: corregir en Flota', tone: 'bg-red-50 text-red-800' },
}
function UnifyModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const { ctx } = useFlow()
  const [rep, setRep] = useState<UnifyReport | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [kind, setKind] = useState<UnifyIssue['kind'] | ''>('')
  const [area, setArea] = useState(ctx.areas[0]?.id ?? '')
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    call<UnifyReport>('hhee_people_unify', { p: { action: 'report' } }).then(r => { if (alive) setRep(r) }).catch(e => { if (alive) setError(e instanceof Error ? e.message : 'No se pudo cargar') })
    return () => { alive = false }
  }, [nonce])
  const run = async (p: Record<string, unknown>, done: (r: { reviewed?: number; linked_new?: number; created?: number }) => string) => {
    setBusy(true); setError(''); setMsg('')
    try { const r = await call<{ reviewed?: number; linked_new?: number; created?: number }>('hhee_people_unify', { p }); setMsg(done(r)); await onDone(); setNonce(n => n + 1) }
    catch (e) { setError(e instanceof Error ? e.message : 'No se pudo completar') } finally { setBusy(false) }
  }
  const s = rep?.summary
  const rows = (rep?.rows ?? []).filter(r => !kind || r.kind === kind)
  const sinFicha = s?.by_kind.CONDUCTOR_SIN_FICHA ?? 0
  return (
    <Modal title="Unificar personal con Flota y Maestros" onClose={onClose} wide>
      <p className="rounded-lg bg-blue-50 p-3 text-xs leading-relaxed text-blue-950">Un DNI = una persona. La ficha con el DNI de un conductor se enlaza a Flota y toma de allí el nombre y el DNI
        (para los demás, de Maestros → Trabajadores). Si se corrigen en Flota o Maestros, la ficha se actualiza sola. La remuneración sigue solo en esta ventana.</p>
      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      {msg && <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{msg}</p>}
      {!rep ? <p className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Cruzando por DNI…</p> : <>
        <div className="grid gap-3 sm:grid-cols-4">
          {[['Fichas de personal', s!.people], ['Enlazadas a Flota', s!.linked_driver], ['Enlazadas a Maestros', s!.linked_profile], ['Conductores activos en Flota', s!.drivers_active]]
            .map(([k, v]) => <div key={k} className="rounded-xl border border-slate-200 bg-white p-3"><p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{k}</p><p className="mt-1 text-2xl font-black text-[#002855]">{v}</p></div>)}
        </div>
        <Card title="Acciones">
          <div className="flex flex-wrap items-end gap-3">
            <button type="button" className={btn2Cls} disabled={busy} onClick={() => void run({ action: 'link' }, r => `Revisadas ${r.reviewed} fichas: ${r.linked_new} enlazada(s) nueva(s); nombres y DNI tomados de Flota / Maestros.`)}>
              <Link2 className="h-4 w-4" /> Enlazar por DNI y actualizar datos</button>
            <Field label="Área para las fichas nuevas"><select className={`${inputCls} w-48`} value={area} onChange={e => setArea(e.target.value)}>{ctx.areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
            <button type="button" className={btnCls} disabled={busy || !sinFicha || !area} onClick={() => void run({ action: 'create_drivers', area_id: area }, r => `${r.created} ficha(s) creada(s) para conductores. Complete su remuneración para calcular el costo.`)}>
              <Truck className="h-4 w-4" /> Crear fichas de {sinFicha} conductor(es)</button>
          </div>
        </Card>
        <Card title="Diferencias encontradas" subtitle={rep.rows.length ? `${rep.rows.length} caso(s)` : 'Todo coincide'}
          actions={<select aria-label="Tipo de diferencia" className={`${inputCls} w-56`} value={kind} onChange={e => setKind(e.target.value as typeof kind)}>
            <option value="">Todas</option>{(Object.keys(KINDS) as UnifyIssue['kind'][]).map(k => <option key={k} value={k}>{KINDS[k].label} ({s!.by_kind[k] ?? 0})</option>)}</select>}>
          {rows.length ? <div className="max-h-[50vh] overflow-auto rounded-lg border border-slate-200">
            <table className="w-full min-w-[680px] text-left text-xs">
              <thead className="sticky top-0 bg-slate-50 text-[10px] uppercase text-slate-500"><tr><th className="p-2">Caso</th><th className="p-2">DNI</th><th className="p-2">Ficha de personal</th><th className="p-2">Conductor en Flota</th></tr></thead>
              <tbody className="divide-y divide-slate-100">{rows.map((r, i) => <tr key={i}>
                <td className="p-2"><span title={KINDS[r.kind].hint} className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${KINDS[r.kind].tone}`}>{KINDS[r.kind].label}</span></td>
                <td className="p-2 font-mono">{r.doc ?? '—'}</td>
                <td className="p-2">{r.name ? <><p className="font-semibold">{r.name}</p><p className="text-[10px] text-slate-500">{r.code} · {r.area}</p></> : '—'}</td>
                <td className="p-2">{r.driver_name ?? '—'}</td>
              </tr>)}</tbody>
            </table>
          </div> : <p className="py-6 text-center text-sm text-slate-400">Sin diferencias en este filtro.</p>}
        </Card>
      </>}
    </Modal>
  )
}

// Importación por Excel: una fila por trabajador; el código identifica a quien ya existe (se actualiza)
const TEMPLATE_HEADERS = ['Código', 'Nombres y apellidos', 'Documento', 'Cargo', 'Área', 'Horas diarias', 'Divisor mensual', 'Divisor confirmado (SI/NO)',
  'Vigente desde (DD/MM/AAAA)', 'Básico', 'Asignación familiar', 'Otros computables', 'No computables', 'Activo (SI/NO)']
function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const { ctx } = useFlow()
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([])
  const [problems, setProblems] = useState<string[]>([])
  const [result, setResult] = useState<{ saved: number; total: number; rows: Array<{ row: number; code: string; ok: boolean; updated: boolean; error: string | null }> } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const template = () => {
    const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS, ['T001', 'Juan Pérez Rojas', '70123456', 'Operario de despacho', ctx.areas[0]?.name ?? 'Distribución', 8, 240, 'SI', today().split('-').reverse().join('/'), 1500, 113, 0, 0, 'SI']])
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Personal'); XLSX.writeFile(wb, 'plantilla-personal-hhee.xlsx')
  }
  const yes = (v: unknown, dflt: boolean) => (v == null || v === '' ? dflt : /^(si|sí|s|1|true|x)$/i.test(String(v).trim()))
  const num = (v: unknown) => (v == null || v === '' ? 0 : Number(String(v).replace(',', '.')))
  // Fecha de Excel (número de serie) o texto DD/MM/AAAA, DD-MM-AAAA o AAAA-MM-DD → AAAA-MM-DD; undefined si no se reconoce
  const isoDate = (v: unknown): string | null | undefined => {
    if (v == null || String(v).trim() === '') return null
    const pad = (n: number) => String(n).padStart(2, '0')
    const valid = (y: number, m: number, d: number) => {
      const dt = new Date(Date.UTC(y, m - 1, d))
      return y >= 1950 && y <= 2100 && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : undefined
    }
    if (typeof v === 'number') { const c = XLSX.SSF.parse_date_code(v); return c ? valid(c.y, c.m, c.d) : undefined }
    const t = String(v).trim()
    let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(t)
    if (m) return valid(+m[1], +m[2], +m[3])
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(t)
    if (m) return valid(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1])
    return undefined
  }
  const read = async (file: File) => {
    setResult(null); setError('')
    const wb = XLSX.read(await file.arrayBuffer())
    const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: '' })
    const issues: string[] = []
    const out = data.map((r, i) => {
      const area = ctx.areas.find(a => a.name.toLowerCase() === String(r['Área'] ?? '').trim().toLowerCase()) ?? (ctx.areas.length === 1 ? ctx.areas[0] : undefined)
      if (!area) issues.push(`Fila ${i + 2}: área «${r['Área']}» no encontrada`)
      const vigRaw = r['Vigente desde (DD/MM/AAAA)'] ?? r['Vigente desde (AAAA-MM-DD)'] ?? r['Vigente desde']
      const vig = isoDate(vigRaw)
      if (vig === undefined) issues.push(`Fila ${i + 2}: fecha «${vigRaw}» no válida en Vigente desde (use DD/MM/AAAA o AAAA-MM-DD)`)
      const concepts: Concept[] = [['Básico', true], ['Asignación familiar', true], ['Otros computables', true], ['No computables', false]]
        .map(([k, comp]) => ({ name: String(k), amount: Math.round(num(r[String(k)]) * 100) / 100, computable: Boolean(comp) })).filter(c => c.amount > 0)
      return { code: String(r['Código'] ?? '').trim(), name: String(r['Nombres y apellidos'] ?? '').trim(), document_number: String(r['Documento'] ?? '').trim(),
        position: String(r['Cargo'] ?? '').trim(), area_id: area?.id, daily_hours: num(r['Horas diarias']) || 8, monthly_hours: num(r['Divisor mensual']) || 240,
        divisor_confirmed: yes(r['Divisor confirmado (SI/NO)'], false), active: yes(r['Activo (SI/NO)'], true),
        effective_from: vig ?? null, remuneration_concepts: concepts }
    })
    // Duplicados dentro del archivo
    const seen = new Map<string, number>()
    out.forEach((r, i) => { const k = r.code.toUpperCase(); if (k && seen.has(k)) issues.push(`Fila ${i + 2}: código ${r.code} repetido (fila ${seen.get(k)! + 2})`); seen.set(k, i) })
    const docs = new Map<string, number>()
    out.forEach((r, i) => { if (r.document_number && docs.has(r.document_number)) issues.push(`Fila ${i + 2}: documento ${r.document_number} repetido`); if (r.document_number) docs.set(r.document_number, i) })
    if (out.length > 500) issues.push('Máximo 500 filas por archivo')
    setRows(out); setProblems(issues)
  }
  const send = async () => {
    setBusy(true); setError('')
    try { const r = await call<NonNullable<typeof result>>('hhee_flow_people_import', { p_rows: rows }); setResult(r); await onDone() }
    catch (e) { setError(e instanceof Error ? e.message : 'No se pudo importar') } finally { setBusy(false) }
  }
  const existing = new Set(ctx.people.map(p => p.code))
  return (
    <Modal title="Importar personal desde Excel" onClose={onClose} wide>
      <Card title="1. Descargue la plantilla y complétela" subtitle="Una fila por trabajador. Si el código ya existe, se actualiza su ficha (y se guarda en el historial si cambia la remuneración).">
        <button type="button" className={btn2Cls} onClick={template}><Download className="h-4 w-4" /> Plantilla Excel</button>
      </Card>
      <Card title="2. Suba el archivo">
        <input type="file" accept=".xlsx,.xls,.csv" onChange={e => { const file = e.target.files?.[0]; if (file) void read(file) }} className="text-sm" />
        {rows.length > 0 && <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="bg-slate-50 uppercase text-slate-500"><tr><th className="p-2">Fila</th><th className="p-2">Código</th><th className="p-2">Nombre</th><th className="p-2">Documento</th><th className="p-2">Divisor</th><th className="p-2 text-right">Base computable</th><th className="p-2">Acción</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{rows.slice(0, 200).map((r, i) => {
              const res = result?.rows[i]
              const concepts = r.remuneration_concepts as Concept[]
              return <tr key={i}><td className="p-2">{i + 2}</td><td className="p-2 font-mono">{String(r.code)}</td><td className="p-2">{String(r.name)}</td><td className="p-2">{String(r.document_number || '—')}</td>
                <td className="p-2">{String(r.monthly_hours)} h {r.divisor_confirmed ? '✓' : '(sin confirmar)'}</td><td className="p-2 text-right">{fmtMoney(concepts.filter(c => c.computable).reduce((t, c) => t + c.amount, 0))}</td>
                <td className="p-2">{res ? (res.ok ? <span className="text-emerald-700">{res.updated ? 'Actualizado' : 'Registrado'}</span> : <span className="text-red-700">{res.error}</span>)
                  : existing.has(String(r.code).toUpperCase()) ? 'Actualizará' : 'Nuevo'}</td></tr>
            })}</tbody>
          </table>
        </div>}
        {problems.length > 0 && <ul className="mt-3 list-disc space-y-1 rounded-lg bg-amber-50 p-3 pl-6 text-xs text-amber-900">{problems.slice(0, 20).map(p => <li key={p}>{p}</li>)}</ul>}
        {result && <p role="status" className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">Importación terminada: {result.saved} de {result.total} filas guardadas.</p>}
        {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      </Card>
      <div className="flex justify-end gap-2">
        <button type="button" className={btn2Cls} onClick={onClose}>Cerrar</button>
        <button type="button" className={btnCls} disabled={busy || !rows.length || problems.length > 0 || !!result} onClick={() => void send()}>{busy ? 'Importando…' : `Importar ${rows.length} filas`}</button>
      </div>
    </Modal>
  )
}
