'use client'

import { useEffect, useMemo, useState } from 'react'
import { Ban, Loader2, Plus, Receipt, Save, Trash2, Users, Wrench } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { errorMessage, money } from '@/lib/caja'

// Tripulación del despacho y costos de descarga (F4). Transporte asigna ayudantes/auxiliares y planifica la
// descarga (reserva la partida); el costo real llega por Caja (gasto aprobado) o por factura registrada aquí.

type Stop = { request_id: string; request_number: string }
type Candidate = { profile_id: string; full_name: string; employee_type: string | null; busy_dispatch: string | null }
type CrewRow = { profile_id: string; full_name: string; crew_role: string }
type Line = {
  id?: string; transport_request_id: string; concept: string; description: string | null; estimated_pen: number
  planned_pen: number | null; actual_pen: number | null; status: string; provider_name: string | null; expense_id: string | null
  planned: string  // valor editable
}

const ROLES: Record<string, string> = {
  AYUDANTE: 'Ayudante', AUXILIAR: 'Auxiliar', ESTIBADOR: 'Estibador', MONTACARGUISTA: 'Montacarguista', OPERADOR_GRUA: 'Operador de grúa', OTRO: 'Otro',
}
const CONCEPTS: Record<string, string> = { MONTACARGAS: 'Montacargas', GRUA: 'Grúa', ESTIBA: 'Estiba', OTROS: 'Otros' }
const STATUS_CLS: Record<string, string> = {
  ESTIMADO: 'bg-slate-100 text-slate-600', PLANIFICADO: 'bg-blue-100 text-blue-700', CONSUMIDO: 'bg-emerald-100 text-emerald-700', ANULADO: 'bg-red-50 text-red-600',
}

export function DispatchCrewUnloading({ dispatchId, status, stops, canEdit }: {
  dispatchId: string; status: string; stops: Stop[]; canEdit: boolean
}) {
  const supabase = useMemo(() => createClient(), [])
  const programmed = status === 'PROGRAMADO'
  const [crew, setCrew] = useState<CrewRow[] | null>(null)
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [pick, setPick] = useState({ profile_id: '', crew_role: 'AYUDANTE' })
  const [lines, setLines] = useState<Line[] | null>(null)
  const [reload, setReload] = useState(0)
  const [saving, setSaving] = useState<string | null>(null)
  const stopKey = stops.map(s => s.request_id).join(',')
  const requestNumber = (id: string) => stops.find(s => s.request_id === id)?.request_number || '—'

  useEffect(() => {
    let cancel = false
    const run = async () => {
      const ids = stopKey ? stopKey.split(',') : []
      const [crewRes, candRes, lineRes] = await Promise.all([
        supabase.rpc('get_dispatch_crew', { p_dispatch_id: dispatchId }),
        canEdit && programmed ? supabase.rpc('list_crew_candidates') : Promise.resolve({ data: [] }),
        ids.length ? supabase.from('transport_unloading_costs')
          .select('id, transport_request_id, dispatch_id, concept, description, estimated_pen, planned_pen, actual_pen, status, provider_name, expense_id')
          .in('transport_request_id', ids).order('created_at') : Promise.resolve({ data: [] }),
      ])
      if (cancel) return
      setCrew(((crewRes.data || []) as CrewRow[]).map(c => ({ profile_id: c.profile_id, full_name: c.full_name, crew_role: c.crew_role })))
      setCandidates((candRes.data || []) as Candidate[])
      // Líneas de este despacho o aún estimadas (sin despacho) de sus paradas
      const rows = ((lineRes.data || []) as (Line & { dispatch_id: string | null })[])
        .filter(l => l.dispatch_id === dispatchId || (l.dispatch_id === null && l.status === 'ESTIMADO'))
      setLines(rows.map(l => ({ ...l, planned: l.planned_pen != null ? String(l.planned_pen) : l.status === 'ESTIMADO' ? String(l.estimated_pen) : '' })))
    }
    void run()
    return () => { cancel = true }
  }, [supabase, dispatchId, stopKey, canEdit, programmed, reload])

  const saveCrew = async (next: CrewRow[]) => {
    setSaving('crew')
    try {
      const { data, error } = await supabase.rpc('set_dispatch_crew', {
        p_dispatch_id: dispatchId, p_crew: next.map(c => ({ profile_id: c.profile_id, crew_role: c.crew_role })),
      })
      if (error) throw error
      if (!data?.success) throw new Error(data?.error)
      toast.success('Tripulación actualizada')
      setPick({ profile_id: '', crew_role: 'AYUDANTE' })
      setReload(n => n + 1)
    } catch (e) { toast.error(errorMessage(e)) } finally { setSaving(null) }
  }

  const addCrew = () => {
    const c = candidates.find(x => x.profile_id === pick.profile_id)
    if (!c || !crew) return
    if (crew.some(x => x.profile_id === c.profile_id)) { toast.error('Ya está en la tripulación'); return }
    void saveCrew([...crew, { profile_id: c.profile_id, full_name: c.full_name, crew_role: pick.crew_role }])
  }

  const savePlan = async () => {
    if (!lines) return
    const items = lines.filter(l => l.status === 'PLANIFICADO' || (l.planned.trim() !== '' && (l.status === 'ESTIMADO' || !l.id)))
    if (items.some(l => !(Number(l.planned) >= 0) || l.planned.trim() === '')) { toast.error('Indique el monto planificado de cada costo'); return }
    setSaving('plan')
    try {
      const { data, error } = await supabase.rpc('plan_dispatch_unloading', {
        p_dispatch_id: dispatchId,
        p_items: items.map(l => l.id
          ? { id: l.id, planned_pen: Number(l.planned), description: l.description }
          : { request_id: l.transport_request_id, concept: l.concept, description: l.description, planned_pen: Number(l.planned) }),
      })
      if (error) throw error
      if (!data?.success) throw new Error(data?.error)
      toast.success('Descarga planificada y reservada en la partida')
      setReload(n => n + 1)
    } catch (e) { toast.error(errorMessage(e)) } finally { setSaving(null) }
  }

  const registerActual = async (l: Line) => {
    const amount = window.prompt(`Costo real de ${CONCEPTS[l.concept]} (S/)`, String(l.planned_pen ?? ''))
    if (amount === null) return
    const provider = window.prompt('Proveedor (opcional)') || null
    const { data, error } = await supabase.rpc('register_unloading_actual', { p_line_id: l.id, p_amount: Number(amount), p_provider: provider })
    if (error || !data?.success) { toast.error(error ? errorMessage(error) : data?.error); return }
    toast.success('Costo real registrado y consumido de la partida')
    setReload(n => n + 1)
  }

  const voidLine = async (l: Line) => {
    const reason = window.prompt('Motivo de la anulación (libera la reserva)')
    if (reason === null) return
    const { data, error } = await supabase.rpc('void_unloading_cost', { p_line_id: l.id, p_reason: reason })
    if (error || !data?.success) { toast.error(error ? errorMessage(error) : data?.error); return }
    toast.success('Descarga anulada; la reserva se liberó')
    setReload(n => n + 1)
  }

  const editable = canEdit && programmed
  const setLine = (i: number, patch: Partial<Line>) => setLines(ls => ls && ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-bold text-slate-800 flex items-center gap-2 mb-2"><Users className="w-4 h-4" />Tripulación</h3>
        {crew === null ? <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
          : crew.length === 0 ? <p className="text-sm text-slate-400">Sin ayudantes ni auxiliares asignados.</p>
          : (
            <ul className="space-y-1">
              {crew.map(c => (
                <li key={c.profile_id} className="flex items-center gap-2 text-sm">
                  <span className="font-medium text-slate-700">{c.full_name}</span>
                  <span className="text-xs text-slate-500">{ROLES[c.crew_role] || c.crew_role}</span>
                  {editable && (
                    <button onClick={() => saveCrew(crew.filter(x => x.profile_id !== c.profile_id))} disabled={saving === 'crew'}
                      className="text-slate-400 hover:text-red-600" title="Quitar"><Trash2 className="w-3.5 h-3.5" /></button>
                  )}
                </li>
              ))}
            </ul>
          )}
        {editable && (
          <div className="mt-2 flex flex-wrap gap-2 text-sm">
            <select value={pick.profile_id} onChange={e => setPick({ ...pick, profile_id: e.target.value })} className="border rounded-lg px-2 py-1.5 bg-white min-w-[220px]">
              <option value="">Seleccione trabajador…</option>
              {candidates.map(c => (
                <option key={c.profile_id} value={c.profile_id} disabled={!!c.busy_dispatch}>
                  {c.full_name} · {c.employee_type}{c.busy_dispatch ? ` (en ${c.busy_dispatch})` : ''}
                </option>
              ))}
            </select>
            <select value={pick.crew_role} onChange={e => setPick({ ...pick, crew_role: e.target.value })} className="border rounded-lg px-2 py-1.5 bg-white">
              {Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <button onClick={addCrew} disabled={!pick.profile_id || saving === 'crew'}
              className="px-3 py-1.5 rounded-lg bg-blue-600 text-white font-semibold disabled:opacity-50 flex items-center gap-1"><Plus className="w-4 h-4" />Agregar</button>
          </div>
        )}
      </div>

      <div>
        <h3 className="font-bold text-slate-800 flex items-center gap-2 mb-1"><Wrench className="w-4 h-4" />Costos de descarga (partida de transporte)</h3>
        <p className="text-xs text-slate-500 mb-2">
          Lo planificado se reserva en la partida del contrato. El costo real se consume al aprobarse en Caja el gasto del viaje
          (alquiler de equipo o cuadrilla/estiba) o al registrar la factura aquí.
        </p>
        {lines === null ? <Loader2 className="w-4 h-4 animate-spin text-slate-400" /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-slate-500 border-b">
                <th className="py-1 pr-2">Parada</th><th className="pr-2">Concepto</th><th className="pr-2 text-right">Estimado</th>
                <th className="pr-2 text-right">Planificado</th><th className="pr-2 text-right">Real</th><th className="pr-2">Estado</th><th />
              </tr></thead>
              <tbody>
                {lines.length === 0 && <tr><td colSpan={7} className="py-2 text-slate-400">Sin costos de descarga.</td></tr>}
                {lines.map((l, i) => (
                  <tr key={l.id || `new-${i}`} className="border-b last:border-0">
                    <td className="py-1.5 pr-2">
                      {!l.id && editable && stops.length > 1 ? (
                        <select value={l.transport_request_id} onChange={e => setLine(i, { transport_request_id: e.target.value })} className="border rounded px-1 py-0.5 bg-white">
                          {stops.map(s => <option key={s.request_id} value={s.request_id}>{s.request_number}</option>)}
                        </select>
                      ) : requestNumber(l.transport_request_id)}
                    </td>
                    <td className="pr-2">
                      {!l.id && editable ? (
                        <select value={l.concept} onChange={e => setLine(i, { concept: e.target.value })} className="border rounded px-1 py-0.5 bg-white">
                          {Object.entries(CONCEPTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                      ) : CONCEPTS[l.concept]}
                      {l.description && <div className="text-[11px] text-slate-400">{l.description}</div>}
                    </td>
                    <td className="pr-2 text-right">{l.estimated_pen ? `S/ ${money(l.estimated_pen)}` : '—'}</td>
                    <td className="pr-2 text-right">
                      {editable && (l.status === 'ESTIMADO' || l.status === 'PLANIFICADO') ? (
                        <input value={l.planned} onChange={e => setLine(i, { planned: e.target.value })} inputMode="decimal"
                          className="border rounded px-1 py-0.5 w-24 text-right" placeholder="0.00" />
                      ) : l.planned_pen != null ? `S/ ${money(l.planned_pen)}` : '—'}
                    </td>
                    <td className="pr-2 text-right">{l.actual_pen != null ? `S/ ${money(l.actual_pen)}` : '—'}
                      {l.provider_name && <div className="text-[11px] text-slate-400">{l.provider_name}</div>}
                      {l.expense_id && <div className="text-[11px] text-slate-400">vía Caja</div>}
                    </td>
                    <td className="pr-2"><span className={`text-[11px] px-1.5 py-0.5 rounded font-semibold ${STATUS_CLS[l.status] || ''}`}>{l.id ? l.status : 'NUEVO'}</span></td>
                    <td className="text-right whitespace-nowrap">
                      {canEdit && l.status === 'PLANIFICADO' && l.id && (
                        <>
                          <button onClick={() => registerActual(l)} className="text-emerald-700 hover:underline text-xs mr-2 inline-flex items-center gap-0.5"><Receipt className="w-3 h-3" />Real</button>
                          <button onClick={() => voidLine(l)} className="text-red-600 hover:underline text-xs inline-flex items-center gap-0.5"><Ban className="w-3 h-3" />Anular</button>
                        </>
                      )}
                      {!l.id && <button onClick={() => setLines(ls => ls && ls.filter((_, j) => j !== i))} className="text-slate-400 hover:text-red-600"><Trash2 className="w-3.5 h-3.5" /></button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {editable && lines && stops.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            <button onClick={() => setLines(ls => [...(ls || []), {
              transport_request_id: stops[0].request_id, concept: 'MONTACARGAS', description: null, estimated_pen: 0, planned_pen: null,
              actual_pen: null, status: 'ESTIMADO', provider_name: null, expense_id: null, planned: '',
            }])} className="px-3 py-1.5 rounded-lg border text-sm flex items-center gap-1 hover:bg-slate-50"><Plus className="w-4 h-4" />Agregar costo</button>
            <button onClick={savePlan} disabled={saving === 'plan'}
              className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm font-semibold disabled:opacity-50 flex items-center gap-1">
              {saving === 'plan' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}Guardar planificación
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
