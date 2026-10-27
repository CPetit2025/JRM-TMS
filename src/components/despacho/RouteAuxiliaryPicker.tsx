'use client'

import { X } from 'lucide-react'
import { SearchableSelect } from '@/components/ui/SearchableSelect'

export type RouteAssistant = {
  person_id: string
  profile_id: string | null
  driver_id: string | null
  name: string
  code?: string
  position: string | null
  area: string | null
  kind: 'AUXILIAR' | 'CONDUCTOR'
  busy: string | null
}

const label = (person: RouteAssistant) => [person.name, person.kind === 'CONDUCTOR' ? 'Conductor' : person.position || 'Personal', person.area, person.code].filter(Boolean).join(' · ')

export function RouteAuxiliaryPicker({ people, value, onChange, driverId, loading, error, onRefresh }: {
  people: RouteAssistant[]
  value: string[]
  onChange: (value: string[]) => void
  driverId?: string
  loading: boolean
  error: string
  onRefresh: () => void
}) {
  const options = people.filter(person => !value.includes(person.person_id)).map(person => {
    const reason = person.driver_id && person.driver_id === driverId ? 'Conductor de esta ruta'
      : person.busy ? `Ocupado en ruta ${person.busy}` : ''
    return { value: person.person_id, label: `${label(person)}${reason ? ` · ${reason}` : ''}`, disabled: Boolean(reason) }
  }).sort((a, b) => Number(a.disabled) - Number(b.disabled) || a.label.localeCompare(b.label, 'es'))
  const busy = people.filter(person => person.busy).length

  return <div>
    <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
      <label className="block text-xs font-semibold text-slate-700">Auxiliares <span className="font-normal text-slate-500">(opcional, hasta 6)</span></label>
      <button type="button" onClick={onRefresh} disabled={loading} className="text-xs font-medium text-blue-700 underline disabled:opacity-50">{loading ? 'Actualizando personal…' : 'Actualizar personal'}</button>
    </div>
    {value.length > 0 && <ul aria-label="Auxiliares de la ruta" className="mb-2 flex flex-wrap gap-2">{value.map(id => {
      const person = people.find(candidate => candidate.person_id === id)
      return <li key={id} className="flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 py-1 pl-3 pr-1 text-xs font-semibold text-[#002855]">
        {person ? label(person) : 'Persona seleccionada'}
        <button type="button" aria-label={`Quitar a ${person?.name || 'auxiliar'}`} onClick={() => onChange(value.filter(selected => selected !== id))} className="rounded-full p-1 hover:bg-blue-100"><X className="h-3.5 w-3.5" /></button>
      </li>
    })}</ul>}
    {error && <p role="alert" className="mb-2 text-xs text-red-700">{error}</p>}
    {value.length < 6 && <SearchableSelect ariaLabel="Agregar auxiliar o conductor" value="" disabled={loading || Boolean(error)}
      onChange={id => { if (id && !value.includes(id) && options.some(option => option.value === id && !option.disabled)) onChange([...value, id].slice(0, 6)) }}
      options={options} placeholder={loading ? 'Cargando personal…' : 'Buscar auxiliar o conductor…'} searchPlaceholder="Buscar por nombre, cargo, área o código…" />}
    <p className="mt-1 text-[11px] text-slate-500">Auxiliares y conductores con ficha activa en Personal (HHEE). Los ocupados figuran con su ruta y no se pueden seleccionar.{!loading && !error ? ` ${options.filter(option => !option.disabled).length} disponible(s)${busy ? ` · ${busy} en otra ruta` : ''}.` : ''}</p>
    {!loading && !error && people.length === 0 && <p className="mt-1 text-xs text-amber-700">No hay fichas activas de Personal para esta lista. Revisa Personal (HHEE) y actualiza.</p>}
  </div>
}
