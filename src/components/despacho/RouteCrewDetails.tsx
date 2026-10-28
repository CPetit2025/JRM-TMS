'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export type RouteCrewPerson = {
  id: string; name: string; code: string | null; document_number: string | null
  position: string | null; area: string | null; phone: string | null; role: string; active: boolean
}
export type ManualClosure = { reason: string | null; closed_at: string | null; previous_status: string | null; actor_name: string | null }

export function ManualClosureSummary({ closure }: { closure: ManualClosure }) {
  return <section aria-label="Cierre operativo manual registrado" className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
    <h3 className="font-bold">Cierre operativo manual registrado</h3>
    <p className="whitespace-pre-wrap break-words"><strong>Explicación:</strong> {closure.reason || 'Sin explicación registrada'}</p>
    <dl className="grid gap-3 sm:grid-cols-2"><div><dt className="text-xs font-medium">Responsable</dt><dd>{closure.actor_name || 'Usuario no disponible'}</dd></div><div><dt className="text-xs font-medium">Fecha y hora</dt><dd>{closure.closed_at ? new Date(closure.closed_at).toLocaleString('es-PE',{timeZone:'America/Lima',dateStyle:'short',timeStyle:'short'}) : 'Sin registrar'}</dd></div><div><dt className="text-xs font-medium">Estado anterior</dt><dd>{closure.previous_status || 'Sin registrar'}</dd></div></dl>
  </section>
}

const roles: Record<string, string> = { AUXILIAR: 'Auxiliar', AYUDANTE: 'Ayudante', ESTIBADOR: 'Estibador', MONTACARGUISTA: 'Montacarguista', OPERADOR_GRUA: 'Operador de grúa', OTRO: 'Tripulación' }

export function RouteCrewCards({ people }: { people: RouteCrewPerson[] }) {
  if (!people.length) return <p className="rounded-lg border border-dashed border-slate-200 p-4 text-sm text-slate-500">Sin auxiliares ni tripulación adicional registrados en esta ruta.</p>
  return <div className="grid gap-3 md:grid-cols-2">{people.map(person => <article key={person.id} className="min-w-0 rounded-xl border border-slate-200 bg-white p-4">
    <div className="flex flex-wrap items-start justify-between gap-2"><h4 className="break-words font-semibold text-slate-900">{person.name}</h4><span className="rounded bg-blue-50 px-2 py-1 text-xs font-medium text-blue-800">{roles[person.role] || person.role}</span></div>
    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">{([
      ['Documento',person.document_number || 'Sin registrar'], ['Código de Personal',person.code || 'Sin registrar'],
      ['Cargo',person.position || 'Sin registrar'], ['Área',person.area || 'Sin registrar'],
      ['Teléfono',person.phone || 'Sin registrar'], ['Estado de ficha',person.active ? 'Activa' : 'Inactiva · asignación registrada'],
    ] as [string,string][]).map(([title,value]) => <div key={title} className="min-w-0"><dt className="text-xs font-medium text-slate-500">{title}</dt><dd className="mt-0.5 break-words text-slate-800">{value}</dd></div>)}</dl>
  </article>)}</div>
}

export function RouteCrewDetails({ dispatchId }: { dispatchId: string }) {
  const db = useMemo(() => createClient(), [])
  const [closure,setClosure] = useState<ManualClosure | null>(null)
  const [people,setPeople] = useState<RouteCrewPerson[]>([]), [loading,setLoading] = useState(true), [error,setError] = useState(''), [attempt,setAttempt] = useState(0)
  useEffect(() => {
    let alive = true
    const timer = window.setTimeout(() => {
      setLoading(true); setError('')
      void Promise.resolve(db.rpc('get_tower_route_crew',{ p_dispatch_id: dispatchId })).then(({ data,error: queryError }) => {
        if (!alive) return
        const result = data as { success?: boolean; people?: RouteCrewPerson[]; manual_closure?: ManualClosure | null } | null
        if (queryError || !result?.success || !Array.isArray(result.people)) { setError('No se pudo cargar la tripulación de la ruta.'); return }
        setPeople(result.people); setClosure(result.manual_closure || null)
      }).catch(() => { if (alive) setError('No se pudo cargar la tripulación de la ruta.') }).finally(() => { if (alive) setLoading(false) })
    },0)
    return () => { alive = false; window.clearTimeout(timer) }
  },[db,dispatchId,attempt])
  return <div className="space-y-5"><section aria-label="Auxiliares y tripulación" className="space-y-3">
    <h3 className="font-bold text-slate-800">Auxiliares y tripulación</h3>
    {loading ? <p role="status" className="text-sm text-slate-500">Cargando datos de la tripulación…</p> : error ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error} <button type="button" onClick={() => setAttempt(value => value+1)} className="font-semibold underline">Reintentar</button></div> : <RouteCrewCards people={people} />}
  </section>{!loading && !error && closure && <ManualClosureSummary closure={closure} />}</div>
}
