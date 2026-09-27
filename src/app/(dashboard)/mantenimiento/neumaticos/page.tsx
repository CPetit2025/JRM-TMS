'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from '@/components/ui/modal'
import { toast } from 'sonner'
import { format } from 'date-fns'
import { CircleDot, Plus, RefreshCw, Loader2, Activity, History } from 'lucide-react'

// Neumáticos (Fase 8): cada evento del ciclo de vida pasa por register_tire_event
// (instalación, rotación, desmontaje, medición, reencauche, baja); migración 20260927220000.

const supabase = createClient()

interface TireRow {
  id: string; codigo_interno: string; serial_number: string | null; dot: string | null; marca: string | null; modelo: string | null; medida: string | null
  estado: 'ALMACEN' | 'INSTALADO' | 'REENCAUCHE' | 'BAJA'; vehicle_plate: string | null; position: string | null
  purchase_cost: number | null; retread_count: number; max_retreads: number; retread_cost_total: number
  cocada_original: number | null; cocada_actual: number | null; min_tread_mm: number
  km_total: number; cost_total: number; cost_per_km: number | null; wear_pct: number | null
  tread_status: 'OK' | 'POR_CAMBIAR' | 'CAMBIAR' | 'BAJA'; last_measured_at: string | null; provider_name: string | null
}
interface HistoryRow { id: string; tire_id: string; codigo_interno: string; tipo_movimiento: string; created_at: string; vehicle_plate: string | null; position_from: string | null; position: string | null; current_odometer: number | null; cocada: number | null; km_accumulated: number | null; cost: number | null; reason: string | null; created_by_name: string | null }

const ESTADO_STYLE: Record<string, string> = { ALMACEN: 'bg-emerald-100 text-emerald-700', INSTALADO: 'bg-blue-100 text-blue-700', REENCAUCHE: 'bg-amber-100 text-amber-700', BAJA: 'bg-slate-200 text-slate-600' }
const TREAD_STYLE: Record<string, string> = { OK: 'text-emerald-700', POR_CAMBIAR: 'text-amber-600', CAMBIAR: 'text-red-600 font-bold', BAJA: 'text-slate-400' }
const EVENTS_BY_STATE: Record<string, [string, string][]> = {
  ALMACEN: [['INSTALACION', 'Instalar'], ['MEDICION', 'Medir cocada'], ['ENVIO_REENCAUCHE', 'Enviar a reencauche'], ['BAJA', 'Dar de baja']],
  INSTALADO: [['ROTACION', 'Rotar'], ['MEDICION', 'Medir cocada'], ['DESMONTAJE', 'Desmontar']],
  REENCAUCHE: [['RETORNO_REENCAUCHE', 'Recibir de reencauche'], ['BAJA', 'Dar de baja']],
  BAJA: [],
}
const money = (n: number | null | undefined) => `S/ ${Number(n || 0).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function loadAll() {
  return Promise.all([
    supabase.from('vw_tires').select('*').order('codigo_interno'),
    supabase.from('vw_tire_history').select('*').order('created_at', { ascending: false }).limit(300),
    supabase.from('vehicles').select('plate, current_odometer').order('plate'),
    supabase.from('maintenance_providers').select('id, business_name').order('business_name'),
  ])
}

export default function NeumaticosPage() {
  const [tab, setTab] = useState<'neumaticos' | 'unidades' | 'historial'>('neumaticos')
  const [tires, setTires] = useState<TireRow[]>([])
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [vehicles, setVehicles] = useState<{ plate: string; current_odometer: number | null }[]>([])
  const [providers, setProviders] = useState<{ id: string; business_name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [estado, setEstado] = useState('TODOS')
  const [creating, setCreating] = useState(false)
  const [eventFor, setEventFor] = useState<{ tire: TireRow; event: string } | null>(null)
  const [historyTire, setHistoryTire] = useState<string>('')

  const apply = useCallback(([t, h, v, p]: Awaited<ReturnType<typeof loadAll>>) => {
    if (t.error) toast.error('Error al cargar neumáticos: ' + t.error.message)
    setTires((t.data || []) as TireRow[]); setHistory((h.data || []) as HistoryRow[]); setVehicles(v.data || []); setProviders(p.data || [])
    setLoading(false)
  }, [])
  const refresh = useCallback(() => { setLoading(true); return loadAll().then(apply) }, [apply])
  useEffect(() => { loadAll().then(apply) }, [apply])

  const filtered = useMemo(() => tires.filter(t => (estado === 'TODOS' || t.estado === estado || t.tread_status === estado) &&
    (!search || `${t.codigo_interno} ${t.marca || ''} ${t.medida || ''} ${t.vehicle_plate || ''}`.toLowerCase().includes(search.toLowerCase()))), [tires, search, estado])

  const kpis = useMemo(() => {
    const withKm = tires.filter(t => t.cost_per_km != null)
    return {
      installed: tires.filter(t => t.estado === 'INSTALADO').length,
      stock: tires.filter(t => t.estado === 'ALMACEN').length,
      retread: tires.filter(t => t.estado === 'REENCAUCHE').length,
      toChange: tires.filter(t => t.tread_status === 'CAMBIAR' || t.tread_status === 'POR_CAMBIAR').length,
      cpk: withKm.length ? withKm.reduce((s, t) => s + Number(t.cost_per_km), 0) / withKm.length : null,
    }
  }, [tires])

  const byVehicle = useMemo(() => {
    const m = new Map<string, TireRow[]>()
    tires.filter(t => t.estado === 'INSTALADO' && t.vehicle_plate).forEach(t => m.set(t.vehicle_plate!, [...(m.get(t.vehicle_plate!) || []), t]))
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [tires])

  return (
    <div className="p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2"><CircleDot className="w-6 h-6" />Neumáticos</h1>
          <p className="text-sm text-slate-500">Identidad individual, posiciones, cocada, reencauches y costo por kilómetro con el odómetro real.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setCreating(true)} className="px-4 py-2 bg-[#002855] text-white rounded-lg text-sm flex items-center gap-2"><Plus className="w-4 h-4" />Nuevo neumático</button>
          <button onClick={refresh} className="px-3 py-2 border rounded-lg text-sm flex items-center gap-2"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />Actualizar</button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[['Instalados', kpis.installed], ['En almacén', kpis.stock], ['En reencauche', kpis.retread], ['Por cambiar', kpis.toChange], ['Costo/km promedio', kpis.cpk == null ? '—' : `S/ ${kpis.cpk.toFixed(4)}`]]
          .map(([l, v]) => <div key={l as string} className="bg-white border rounded-xl p-3"><div className="text-xs text-slate-500">{l}</div><div className="text-xl font-bold">{v}</div></div>)}
      </div>

      <div className="flex gap-1 border-b">
        {([['neumaticos', 'Neumáticos'], ['unidades', 'Por unidad'], ['historial', 'Historial']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`px-3 py-2 text-sm border-b-2 -mb-px ${tab === k ? 'border-[#002855] text-[#002855] font-semibold' : 'border-transparent text-slate-500'}`}>{l}</button>
        ))}
      </div>

      {loading ? <div className="p-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div> : (
        <>
          {tab === 'neumaticos' && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar código, marca, medida o unidad…" className="border rounded-lg px-3 py-2 text-sm w-72" />
                <select value={estado} onChange={e => setEstado(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
                  <option value="TODOS">Todos</option><option value="INSTALADO">Instalados</option><option value="ALMACEN">En almacén</option>
                  <option value="REENCAUCHE">En reencauche</option><option value="BAJA">De baja</option><option value="CAMBIAR">Cocada bajo mínimo</option>
                </select>
              </div>
              <div className="bg-white border rounded-xl overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>
                    <th className="text-left p-3">Neumático</th><th className="text-left p-3">Estado</th><th className="text-left p-3">Ubicación</th>
                    <th className="text-right p-3">Cocada</th><th className="text-right p-3">Km</th><th className="text-right p-3">Reenc.</th>
                    <th className="text-right p-3">Costo total</th><th className="text-right p-3">Costo/km</th><th className="p-3"></th>
                  </tr></thead>
                  <tbody className="divide-y">
                    {filtered.map(t => (
                      <tr key={t.id}>
                        <td className="p-3"><div className="font-semibold">{t.codigo_interno}</div><div className="text-xs text-slate-500">{[t.marca, t.modelo, t.medida].filter(Boolean).join(' · ')}{t.dot ? ` · DOT ${t.dot}` : ''}</div></td>
                        <td className="p-3"><span className={`px-2 py-0.5 rounded text-xs font-semibold ${ESTADO_STYLE[t.estado]}`}>{t.estado}</span></td>
                        <td className="p-3">{t.vehicle_plate ? `${t.vehicle_plate} · ${t.position}` : '—'}</td>
                        <td className={`p-3 text-right ${TREAD_STYLE[t.tread_status]}`}>{t.cocada_actual ?? '—'} mm{t.wear_pct != null && <div className="text-[11px] text-slate-400">desgaste {t.wear_pct}%</div>}</td>
                        <td className="p-3 text-right">{Number(t.km_total || 0).toLocaleString('es-PE')}</td>
                        <td className="p-3 text-right">{t.retread_count}/{t.max_retreads}</td>
                        <td className="p-3 text-right">{money(t.cost_total)}</td>
                        <td className="p-3 text-right">{t.cost_per_km != null ? `S/ ${Number(t.cost_per_km).toFixed(4)}` : '—'}</td>
                        <td className="p-3">
                          <div className="flex gap-1 justify-end">
                            {EVENTS_BY_STATE[t.estado].length > 0 && (
                              <select className="border rounded-lg px-2 py-1 text-xs" value="" onChange={e => e.target.value && setEventFor({ tire: t, event: e.target.value })}>
                                <option value="">Evento…</option>{EVENTS_BY_STATE[t.estado].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                              </select>
                            )}
                            <button title="Historial" onClick={() => { setHistoryTire(t.id); setTab('historial') }} className="p-1.5 border rounded-lg"><History className="w-4 h-4" /></button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {filtered.length === 0 && <tr><td colSpan={9} className="p-8 text-center text-slate-500">Sin neumáticos con estos filtros.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'unidades' && (
            byVehicle.length === 0 ? <p className="text-sm text-slate-500">No hay neumáticos instalados.</p> : (
              <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
                {byVehicle.map(([plate, list]) => (
                  <div key={plate} className="bg-white border rounded-xl p-4">
                    <div className="font-semibold mb-2">{plate}</div>
                    <div className="grid grid-cols-2 gap-2">
                      {list.sort((a, b) => String(a.position).localeCompare(String(b.position))).map(t => (
                        <div key={t.id} className="border rounded-lg p-2 text-xs">
                          <div className="font-semibold">{t.position}</div>
                          <div>{t.codigo_interno}</div>
                          <div className={TREAD_STYLE[t.tread_status]}>{t.cocada_actual ?? '—'} mm</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )
          )}

          {tab === 'historial' && (
            <div className="space-y-3">
              <select value={historyTire} onChange={e => setHistoryTire(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
                <option value="">Todos los neumáticos</option>{tires.map(t => <option key={t.id} value={t.id}>{t.codigo_interno}</option>)}
              </select>
              <div className="bg-white border rounded-xl overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>
                    <th className="text-left p-3">Fecha</th><th className="text-left p-3">Neumático</th><th className="text-left p-3">Evento</th><th className="text-left p-3">Unidad / posición</th>
                    <th className="text-right p-3">Odómetro</th><th className="text-right p-3">Cocada</th><th className="text-right p-3">Km</th><th className="text-right p-3">Costo</th><th className="text-left p-3">Detalle</th>
                  </tr></thead>
                  <tbody className="divide-y">
                    {history.filter(h => !historyTire || h.tire_id === historyTire).map(h => (
                      <tr key={h.id}>
                        <td className="p-3">{format(new Date(h.created_at), 'dd/MM/yyyy HH:mm')}</td>
                        <td className="p-3">{h.codigo_interno}</td>
                        <td className="p-3 font-medium">{h.tipo_movimiento.replace('_', ' ')}</td>
                        <td className="p-3">{h.vehicle_plate ? `${h.vehicle_plate} ${h.position_from ? `${h.position_from} → ` : ''}${h.position || ''}` : '—'}</td>
                        <td className="p-3 text-right">{h.current_odometer ?? '—'}</td>
                        <td className="p-3 text-right">{h.cocada ?? '—'}</td>
                        <td className="p-3 text-right">{h.km_accumulated ?? '—'}</td>
                        <td className="p-3 text-right">{h.cost != null ? money(h.cost) : '—'}</td>
                        <td className="p-3 text-xs text-slate-500">{[h.reason, h.created_by_name].filter(Boolean).join(' · ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {creating && <CreateTireModal providers={providers} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); refresh() }} />}
      {eventFor && <EventModal {...eventFor} vehicles={vehicles} providers={providers} onClose={() => setEventFor(null)} onSaved={() => { setEventFor(null); refresh() }} />}
    </div>
  )
}

function CreateTireModal({ providers, onClose, onSaved }: { providers: { id: string; business_name: string }[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ codigo_interno: '', serial_number: '', dot: '', marca: '', modelo: '', medida: '', costo: '', cocada_original: '', min_tread_mm: '2', max_retreads: '2', expected_life_km: '', purchase_date: '', provider_id: '' })
  const [saving, setSaving] = useState(false)
  const num = (v: string) => (v.trim() === '' ? null : Number(v))
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    const { error } = await supabase.from('tires').insert({
      codigo_interno: form.codigo_interno, serial_number: form.serial_number || null, dot: form.dot || null, marca: form.marca || null,
      modelo: form.modelo || null, medida: form.medida || null, costo: num(form.costo), cocada_original: num(form.cocada_original),
      min_tread_mm: num(form.min_tread_mm) ?? 2, max_retreads: num(form.max_retreads) ?? 2, expected_life_km: num(form.expected_life_km),
      purchase_date: form.purchase_date || null, provider_id: form.provider_id || null,
    })
    setSaving(false)
    if (error) return toast.error(error.code === '23505' ? 'Ya existe un neumático con ese código' : error.message)
    toast.success('Neumático registrado en almacén (evento COMPRA)')
    onSaved()
  }
  const field = 'w-full border rounded-lg px-3 py-2 text-sm'
  return (
    <Modal isOpen onClose={onClose} title="Nuevo neumático" maxWidth="max-w-2xl">
      <form onSubmit={save} className="grid md:grid-cols-3 gap-3 text-sm">
        <label>Código interno<input required className={field} value={form.codigo_interno} onChange={e => setForm({ ...form, codigo_interno: e.target.value })} /></label>
        <label>Serie<input className={field} value={form.serial_number} onChange={e => setForm({ ...form, serial_number: e.target.value })} /></label>
        <label>DOT<input className={field} value={form.dot} onChange={e => setForm({ ...form, dot: e.target.value })} /></label>
        <label>Marca<input className={field} value={form.marca} onChange={e => setForm({ ...form, marca: e.target.value })} /></label>
        <label>Modelo<input className={field} value={form.modelo} onChange={e => setForm({ ...form, modelo: e.target.value })} /></label>
        <label>Medida<input className={field} value={form.medida} onChange={e => setForm({ ...form, medida: e.target.value })} placeholder="295/80R22.5" /></label>
        <label>Costo (S/)<input required type="number" min={0} step="0.01" className={field} value={form.costo} onChange={e => setForm({ ...form, costo: e.target.value })} /></label>
        <label>Cocada original (mm)<input required type="number" min={1} step="0.1" className={field} value={form.cocada_original} onChange={e => setForm({ ...form, cocada_original: e.target.value })} /></label>
        <label>Cocada mínima (mm)<input type="number" min={0} step="0.1" className={field} value={form.min_tread_mm} onChange={e => setForm({ ...form, min_tread_mm: e.target.value })} /></label>
        <label>Máx. reencauches<input type="number" min={0} className={field} value={form.max_retreads} onChange={e => setForm({ ...form, max_retreads: e.target.value })} /></label>
        <label>Vida útil esperada (km)<input type="number" min={0} className={field} value={form.expected_life_km} onChange={e => setForm({ ...form, expected_life_km: e.target.value })} /></label>
        <label>Fecha de compra<input type="date" className={field} value={form.purchase_date} onChange={e => setForm({ ...form, purchase_date: e.target.value })} /></label>
        <label className="md:col-span-3">Proveedor<select className={field} value={form.provider_id} onChange={e => setForm({ ...form, provider_id: e.target.value })}><option value="">—</option>{providers.map(p => <option key={p.id} value={p.id}>{p.business_name}</option>)}</select></label>
        <div className="md:col-span-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 border rounded-lg">Cancelar</button>
          <button disabled={saving} className="px-4 py-2 bg-[#002855] text-white rounded-lg">{saving ? 'Guardando…' : 'Registrar'}</button>
        </div>
      </form>
    </Modal>
  )
}

function EventModal({ tire, event, vehicles, providers, onClose, onSaved }: {
  tire: TireRow; event: string; vehicles: { plate: string; current_odometer: number | null }[]; providers: { id: string; business_name: string }[]; onClose: () => void; onSaved: () => void
}) {
  const [plate, setPlate] = useState(tire.vehicle_plate || '')
  const [position, setPosition] = useState('')
  const [odometer, setOdometer] = useState('')
  const [tread, setTread] = useState('')
  const [cost, setCost] = useState('')
  const [notes, setNotes] = useState('')
  const [provider, setProvider] = useState('')
  const [saving, setSaving] = useState(false)
  const needsVehicle = event === 'INSTALACION'
  const needsPosition = event === 'INSTALACION' || event === 'ROTACION'
  const needsOdometer = ['INSTALACION', 'ROTACION', 'DESMONTAJE'].includes(event)
  const vehicle = vehicles.find(v => v.plate === plate)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    const { data, error } = await supabase.rpc('register_tire_event', {
      p_tire_id: tire.id, p_event: event, p_vehicle_plate: needsVehicle ? plate : null, p_position: needsPosition ? position : null,
      p_odometer: odometer ? Number(odometer) : null, p_tread_mm: tread ? Number(tread) : null, p_cost: cost ? Number(cost) : null,
      p_notes: notes || null, p_provider_id: provider || null,
    })
    setSaving(false)
    if (error || !data?.success) return toast.error(error?.message || data?.error)
    toast.success(data.tread_alert ? 'Evento registrado. Cocada bajo el mínimo: se generó una falla en el backlog.' : 'Evento registrado')
    onSaved()
  }
  const field = 'w-full border rounded-lg px-3 py-2 text-sm'
  return (
    <Modal isOpen onClose={onClose} title={`${event.replace('_', ' ')} · ${tire.codigo_interno}`}>
      <form onSubmit={save} className="space-y-3 text-sm">
        {needsVehicle && (
          <label className="block">Unidad<select required className={field} value={plate} onChange={e => setPlate(e.target.value)}><option value="">Seleccionar…</option>{vehicles.map(v => <option key={v.plate} value={v.plate}>{v.plate}</option>)}</select></label>
        )}
        {needsPosition && <label className="block">Posición<input required className={field} value={position} onChange={e => setPosition(e.target.value.toUpperCase())} placeholder="DI, DD, TI1, TE1…" /></label>}
        {needsOdometer && <label className="block">Odómetro de la unidad {vehicle && <span className="text-xs text-slate-400">(actual {vehicle.current_odometer ?? 0})</span>}<input type="number" min={0} className={field} value={odometer} onChange={e => setOdometer(e.target.value)} placeholder="Vacío = lectura actual" /></label>}
        {['INSTALACION', 'ROTACION', 'DESMONTAJE', 'MEDICION', 'RETORNO_REENCAUCHE'].includes(event) && (
          <label className="block">Cocada (mm){event === 'MEDICION' || event === 'RETORNO_REENCAUCHE' ? ' *' : ''}<input required={event === 'MEDICION' || event === 'RETORNO_REENCAUCHE'} type="number" min={0} step="0.1" className={field} value={tread} onChange={e => setTread(e.target.value)} /></label>
        )}
        {event === 'RETORNO_REENCAUCHE' && (
          <>
            <label className="block">Costo del reencauche (S/) *<input required type="number" min={0} step="0.01" className={field} value={cost} onChange={e => setCost(e.target.value)} /></label>
            <label className="block">Proveedor<select className={field} value={provider} onChange={e => setProvider(e.target.value)}><option value="">—</option>{providers.map(p => <option key={p.id} value={p.id}>{p.business_name}</option>)}</select></label>
          </>
        )}
        <label className="block">{event === 'BAJA' ? 'Motivo de baja *' : 'Notas'}<input required={event === 'BAJA'} className={field} value={notes} onChange={e => setNotes(e.target.value)} /></label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 border rounded-lg">Cancelar</button>
          <button disabled={saving} className="px-4 py-2 bg-[#002855] text-white rounded-lg flex items-center gap-2"><Activity className="w-4 h-4" />{saving ? 'Registrando…' : 'Registrar'}</button>
        </div>
      </form>
    </Modal>
  )
}
