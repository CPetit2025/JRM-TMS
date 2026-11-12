'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { buildPackingListPdf, fmt, unitLabel, type BoardRow, type LoadUnit, type PackingSnapshot, type TaskLpns } from '@/lib/warehouse/packing-list'

const button = 'rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold disabled:opacity-50'

/** Packing List operativo: selecciona LPN completos ya liberados, conservando sus etiquetas. */
export function PackingAssignment({ task, data, onChanged }: { task: BoardRow; data: TaskLpns; onChanged: () => Promise<void> }) {
  const { hasAccess } = usePermissions()
  const [units, setUnits] = useState<LoadUnit[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [destination, setDestination] = useState('')
  const [filter, setFilter] = useState('available')
  const [plate, setPlate] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const canManage = ['almacen-packing', 'almacen-carga', 'almacen-supervisor'].some(hasAccess) && ['PICKING', 'PACKING', 'READY_FOR_LOAD'].includes(task.status)
  const load = useCallback(async () => {
    const result = await createClient().rpc('wh_task_load_units', { p_task_id: task.id })
    if (result.error) setError(result.error.message)
    else setUnits((result.data || []) as LoadUnit[])
  }, [task.id])
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load, data])

  const assigned = (id: string) => units.find(u => u.lpn_ids.includes(id))
  const released = data.lpns.filter(l => l.audit_status === 'APROBADO' && l.status !== 'VOID')
  const visible = released.filter(l => filter === 'all' || (filter === 'available' ? !assigned(l.id) : assigned(l.id)?.id === filter))
  const selectable = visible.filter(l => l.status === 'CLOSED')
  const chosen = selectable.filter(l => selected.includes(l.id))
  const blocked = data.lpns.filter(l => l.status !== 'VOID' && l.audit_status !== 'APROBADO').length
  const allChecked = selectable.length > 0 && chosen.length === selectable.length
  const run = async (fn: () => PromiseLike<{ error: { message: string } | null }>, text: string) => {
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await fn()
      if (result.error) setError(result.error.message)
      else { setSelected([]); setMessage(text); await Promise.all([load(), onChanged()]) }
    } catch { setError('No se pudo completar la operación. Actualice y vuelva a intentar.') }
    finally { setBusy(false) }
  }
  const add = async () => {
    await run(async () => {
      const result = await createClient().rpc('wh_load_unit_add', { p_task_id: task.id, p_plate: plate.trim() || null })
      if (!result.error) { setDestination(result.data.id); setPlate('') }
      return result
    }, 'Unidad creada. Seleccione los bultos y pulse Asignar unidad.')
  }
  const assign = (unit: string | null) => {
    const ids = chosen.map(l => l.id)
    if (!canManage || !ids.length || (unit !== null && !units.some(u => u.id === unit))) return
    void run(() => createClient().rpc('wh_lpns_assign_unit', { p_task_id: task.id, p_lpn_ids: ids, p_unit_id: unit }), unit ? `${ids.length} LPN asignado(s). Se conservaron los códigos y etiquetas existentes.` : 'Asignación retirada; los LPN siguen liberados.')
  }
  // Documentos de despacho de cada unidad: Guía de carga (consolidado por ítem) y Packing List de la unidad (detalle por LPN).
  const guide = async (unit: LoadUnit, kind: 'GUIA' | 'PACKING' = 'GUIA') => {
    await run(async () => {
      const version = data.packing_lists.find(p => p.status === 'LIBERADO')
      if (!version) return { error: { message: 'La guía requiere Picking finalizado y todos los LPN liberados por Auditoría.' } }
      const result = await createClient().rpc('wh_print_packing_list', { p_id: version.id })
      if (result.error) return result
      const snapshot = result.data as PackingSnapshot
      const lpns = snapshot.lpns.filter(l => unit.lpn_ids.includes(l.id))
      const subset = { ...snapshot, lpns, lpn_count: lpns.length, package_count: lpns.reduce((n,l) => n+l.package_count,0), total_weight_kg: lpns.reduce((n,l) => n+Number(l.weight_kg),0) }
      if (kind === 'GUIA') (await buildPackingListPdf(subset, { title: `GUÍA DE CARGA ${unitLabel(unit)}`, consolidated: true })).save(`guia-${version.packing_list_number}-${unit.label}.pdf`)
      else (await buildPackingListPdf(subset, { title: `PACKING LIST ${version.packing_list_number} · ${unitLabel(unit)}` })).save(`packing-list-${version.packing_list_number}-${unit.label}.pdf`)
      return { error: null }
    }, kind === 'GUIA' ? 'Guía de carga descargada.' : 'Packing List de la unidad descargado.')
  }

  return <section id="unidades" className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
    <h2 className="text-lg font-bold text-[#002855]">Seleccionar liberados y asignar unidad</h2>
    <p className="text-sm text-slate-600">Cada fila representa un LPN lógico completo. Puede usar la etiqueta original de sus paquetes; asignar unidad no genera etiquetas ni confirma la carga física.</p>
    {blocked > 0 && <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900">{blocked} LPN pendiente(s), observado(s) o rechazado(s): no se pueden asignar.</p>}
    {error && <p role="alert" className="rounded-lg bg-rose-50 p-2 text-sm text-rose-900">{error}</p>}
    {message && <p role="status" className="rounded-lg bg-emerald-50 p-2 text-sm text-emerald-900">{message}</p>}
    {canManage && <div className="flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-3">
      <label className="text-sm font-semibold">Placa de nueva unidad (opcional)<input value={plate} onChange={e => setPlate(e.target.value)} maxLength={20} placeholder="Sin placa: UT1, UT2…" className="mt-1 block rounded-lg border border-slate-300 px-3 py-2"/></label>
      <button disabled={busy} onClick={() => void add()} className={button}>Agregar unidad</button>
    </div>}
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-sm font-semibold">Mostrar<select aria-label="Mostrar" value={filter} onChange={e => { setFilter(e.target.value); setSelected([]) }} className="mt-1 block rounded-lg border border-slate-300 px-3 py-2">
        <option value="available">Disponibles para asignar</option><option value="all">Todos los liberados</option>
        {units.map(u => <option key={u.id} value={u.id}>Asignados a {unitLabel(u)}</option>)}
      </select></label>
      {canManage && <>
        <label className="text-sm font-semibold">Unidad de destino<select aria-label="Unidad de destino" value={destination} onChange={e => setDestination(e.target.value)} className="mt-1 block rounded-lg border border-slate-300 px-3 py-2"><option value="">Seleccione UT o placa…</option>{units.map(u => <option key={u.id} value={u.id}>{unitLabel(u)}</option>)}</select></label>
        <button disabled={busy || !chosen.length || !destination} onClick={() => assign(destination)} className={`${button} bg-[#002855] text-white`}>Asignar unidad</button>
        <button disabled={busy || !chosen.some(l => assigned(l.id))} onClick={() => assign(null)} className={button}>Quitar asignación</button>
      </>}
    </div>
    <p className="text-sm font-semibold">Seleccionados: {chosen.length} LPN · {chosen.reduce((n,l) => n+l.package_count,0)} paquetes · {fmt(chosen.reduce((n,l) => n+Number(l.weight_kg),0))} kg</p>
    <div className="overflow-x-auto"><table className="w-full text-left text-sm">
      <thead className="bg-slate-50"><tr><th className="p-2">{canManage && <input type="checkbox" aria-label="Seleccionar todos los LPN disponibles" checked={allChecked} disabled={busy || !selectable.length} onChange={e => setSelected(e.target.checked ? selectable.map(l => l.id) : [])}/>}</th><th className="p-2">LPN / etiquetas existentes</th><th className="p-2">Paquetes</th><th className="p-2">Peso</th><th className="p-2">Unidad</th></tr></thead>
      <tbody>{visible.map(l => <tr key={l.id} className="border-t border-slate-100">
        <td className="p-2">{canManage && <input type="checkbox" aria-label={`Seleccionar ${l.lpn_code}`} checked={chosen.some(c => c.id === l.id)} disabled={busy || l.status !== 'CLOSED'} onChange={e => setSelected(prev => e.target.checked ? [...prev,l.id] : prev.filter(id => id !== l.id))}/>}</td>
        <td className="p-2"><b className="font-mono text-[#002855]">{l.lpn_code}</b><p className="text-xs text-slate-500">{l.packages.map(p => p.package_code).join(' · ')}</p><small className="text-emerald-800">Liberado por Auditoría{l.status === 'LOADED' ? ' · cargado' : ''}</small></td>
        <td className="p-2">{l.package_count}</td><td className="p-2">{fmt(l.weight_kg)} kg</td><td className="p-2">{assigned(l.id) ? unitLabel(assigned(l.id)!) : 'Sin unidad'}</td>
      </tr>)}{!visible.length && <tr><td colSpan={5} className="p-5 text-center text-slate-500">No hay LPN liberados en esta vista.</td></tr>}</tbody>
    </table></div>
    <h3 className="font-bold text-[#002855]">Reparto por unidad</h3>
    <div className="grid gap-2 sm:grid-cols-2">{units.map(u => <article key={u.id} className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm">
      <b>{unitLabel(u)}</b><p>{u.lpn_count} LPN · {u.package_count} paquetes · {fmt(u.weight_kg)} kg · {u.loaded_count} cargados</p>
      {canManage && <label className="block">Placa (opcional)<input key={u.plate || ''} defaultValue={u.plate || ''} aria-label={`Placa de ${u.label}`} maxLength={20} disabled={busy} onBlur={e => { const value = e.target.value.trim().toUpperCase().replace(/\s+/g,''); if (value !== (u.plate || '')) void run(() => createClient().rpc('wh_load_unit_set_plate', { p_unit_id: u.id, p_plate: value }), 'Placa actualizada; etiquetas conservadas.') }} className="ml-2 w-36 rounded border border-slate-300 px-2 py-1"/></label>}
      <div className="flex flex-wrap gap-2"><button onClick={() => { setFilter(u.id); setSelected([]) }} className={button}>Ver bultos de {u.label}</button>{u.lpn_count > 0 && <><button disabled={busy} onClick={() => void guide(u)} className={button}>Guía de carga {u.label}</button><button disabled={busy} onClick={() => void guide(u, 'PACKING')} className={button}>Packing List {u.label}</button></>}
      {canManage && u.loaded_count === 0 && <button disabled={busy} className={button} onClick={() => { if (window.confirm(`¿Quitar ${u.label}? Sus LPN quedarán disponibles para asignar.`)) void run(() => createClient().rpc('wh_load_unit_remove', { p_unit_id: u.id }), 'Unidad retirada.') }}>Quitar {u.label}</button>}</div>
    </article>)}</div>
  </section>
}
