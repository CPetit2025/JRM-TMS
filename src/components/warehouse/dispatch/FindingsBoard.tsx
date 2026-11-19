'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { RefreshCw } from 'lucide-react'
import { PeriodFilter, usePeriod } from '@/components/ui/period-filter'
import { DispatchNav } from './DispatchNav'
import { FindingCard } from './FindingCard'
import { FINDING_STATUS, type Finding } from './findings'

/** Bandeja de hallazgos del WMS: corrección, verificación y reapertura con su historial. */
export function FindingsBoard() {
  const [rows, setRows] = useState<Finding[]>([])
  const [status, setStatus] = useState('ABIERTOS')
  const [mineOnly, setMineOnly] = useState(false)
  const [userId, setUserId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const period = usePeriod()
  const [from, to] = period.range
  const load = useCallback(async () => {
    const db = createClient()
    const [{ data: auth }, r] = await Promise.all([db.auth.getUser(), db.rpc('wh_findings_list', {
      p_task_id: null, p_status: status === 'TODOS' ? null : status, p_from: status === 'ABIERTOS' ? null : from, p_to: status === 'ABIERTOS' ? null : to, p_mine: mineOnly })])
    setUserId(auth.user?.id || '')
    if (r.error) setError(r.error.message); else { setError(''); setRows((r.data || []) as Finding[]) }
    setLoading(false)
  }, [status, from, to, mineOnly])
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])
  const shown = rows
  return <div className="space-y-4">
    <DispatchNav stage="auditoria"/>
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div><p className="text-xs font-bold uppercase tracking-widest text-blue-700">Despacho</p>
        <h1 className="mt-1 text-3xl font-black text-[#002855]">Hallazgos</h1>
        <p className="mt-1 text-sm text-slate-600">Auditoría registra; el responsable corrige; otro auditor verifica. Un LPN con hallazgos sin cerrar no se puede liberar.</p></div>
      <button onClick={() => void load()} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold"><RefreshCw size={16}/>Actualizar</button>
    </header>
    <section className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3 text-sm">
      {[['ABIERTOS', 'Sin cerrar'], ...Object.entries(FINDING_STATUS).map(([k, v]) => [k, v.label]), ['TODOS', 'Todos']].map(([k, label]) =>
        <button key={k} type="button" aria-pressed={status === k} onClick={() => setStatus(k)} className={`rounded-full px-3 py-1 text-xs font-semibold ${status === k ? 'bg-[#002855] text-white' : 'ring-1 ring-slate-200'}`}>{label}</button>)}
      <label className="ml-auto flex items-center gap-1.5"><input type="checkbox" checked={mineOnly} onChange={e => setMineOnly(e.target.checked)}/>Asignados a mí</label>
      {status !== 'ABIERTOS' && <div className="basis-full"><PeriodFilter state={period}/></div>}
    </section>
    {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</p>}
    {loading ? <p className="p-8 text-center text-slate-500">Cargando hallazgos…</p> : shown.length === 0 ? <p className="rounded-xl border bg-white p-8 text-center text-slate-500">No hay hallazgos en esta vista.</p>
      : <div className="space-y-2">{shown.map(f => <FindingCard key={f.id} f={f} userId={userId} onChanged={load}/>)}</div>}
  </div>
}
