'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { Navigation, Search, Radio, Loader2, RefreshCw, MapPin, Plus } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { errorMessage } from '@/lib/caja'
import { gpsTime, monitorMarker, monitorStates, stateFor, type DriverMonitorRow } from '@/lib/gps-monitor'

const MapComponent = dynamic(() => import('@/components/map/MapComponent'), { ssr: false,
  loading: () => <div className="flex h-full items-center justify-center bg-slate-100 text-slate-500"><Loader2 className="mr-2 h-5 w-5 animate-spin" />Cargando mapa…</div> })
const tones: Record<string, string> = { blue: 'border-blue-200 bg-blue-50 text-blue-800', green: 'border-emerald-200 bg-emerald-50 text-emerald-800', amber: 'border-amber-200 bg-amber-50 text-amber-900', red: 'border-red-200 bg-red-50 text-red-800' }
const Status = ({ row }: { row: DriverMonitorRow }) => { const state = stateFor(row); return <span className={`inline-flex rounded-lg border px-2 py-1 text-xs font-semibold ${tones[state.color]}`}>{state.label}</span> }

export default function MonitoreoPage() {
  const supabase = useMemo(() => createClient(), [])
  const { canWrite } = usePermissions()
  const canRegister = canWrite('monitoreo') || canWrite('despacho') || canWrite('torre-control')
  const [rows, setRows] = useState<DriverMonitorRow[]>([])
  const [search, setSearch] = useState('')
  const [state, setState] = useState('all')
  const [connection, setConnection] = useState('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [geofences, setGeofences] = useState(true)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [now, setNow] = useState(0)
  const [loadedAt, setLoadedAt] = useState(0)
  const [eventOpen, setEventOpen] = useState(false)
  const [eventType, setEventType] = useState('CHECKPOINT')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let stopped = false, fetching = false
    const load = async () => {
      setNow(Date.now())
      if (fetching) return; fetching = true
      try {
        const { data, error } = await supabase.rpc('get_driver_gps_monitor')
        if (stopped) return
        if (error) { setError(errorMessage(error)); return }
        setRows((data?.drivers || []) as DriverMonitorRow[]); setAsOf(data?.as_of || null); setLoadedAt(Date.now()); setNow(Date.now()); setError('')
      } catch (e) { if (!stopped) setError(errorMessage(e)) }
      finally { fetching = false }
    }
    void load()
    const timer = window.setInterval(() => void load(), 15000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [supabase, version])
  // Expire snapshot flags even if the next poll fails; use server time to tolerate device clock skew.
  const serverNow = asOf ? Date.parse(asOf) + Math.max(0, now - loadedAt) : 0
  const drivers = rows.map(row => ({ ...row,
    connected: !!row.connected && !!row.last_seen_at && Date.parse(row.last_seen_at) >= serverNow - 90000,
    gps_fresh: !!row.gps_fresh && !!row.gps_at && Date.parse(row.gps_at) >= serverNow - 120000,
  }))
  const filtered = drivers.filter(row => {
    const text = `${row.driver} ${row.plate || ''} ${row.dispatch_number || ''}`.toLowerCase()
    return text.includes(search.trim().toLowerCase()) && (state === 'all' || row.operational_status === state) &&
      (connection === 'all' || (connection === 'connected' ? row.connected : !row.connected))
  })
  const markers = filtered.map(monitorMarker).filter((row): row is NonNullable<typeof row> => !!row)
  const selected = filtered.find(row => row.id === selectedId)
  const register = async (e: FormEvent) => {
    e.preventDefault(); if (!selected?.dispatch_id || busy || !canRegister) return
    setBusy(true)
    try {
      const { error } = await supabase.from('dispatch_events').insert({ dispatch_id: selected.dispatch_id, event_type: eventType, description: description.trim() })
      if (error) throw error
      if (eventType === 'FIN_RUTA') {
        const { data, error: transitionError } = await supabase.rpc('transition_dispatch_status', { p_dispatch_id: selected.dispatch_id, p_new_status: 'ENTREGADO', p_reason: 'Ruta finalizada desde Monitoreo' })
        if (transitionError || !data?.success) throw new Error(transitionError?.message || data?.error || 'No se puede finalizar la ruta')
      }
      toast.success(eventType === 'FIN_RUTA' ? 'Ruta finalizada' : 'Novedad registrada'); setEventOpen(false); setDescription(''); setVersion(v => v + 1)
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }
  return <div className="flex min-h-[calc(100dvh-7rem)] flex-col gap-4">
    <header className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-3"><span className="rounded-xl bg-[#002855] p-3 text-white"><Navigation className="h-5 w-5" /></span><div><h1 className="text-xl font-bold text-[#002855]">Monitoreo GPS</h1><p className="mt-1 text-xs text-slate-500">Conductores del app, con y sin ruta · actualización cada 15 segundos</p></div></div>
      <button onClick={() => setVersion(v => v + 1)} className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm"><RefreshCw className="h-4 w-4" />Actualizar</button>
    </header>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[
      ['App conectada', drivers.filter(r => r.connected).length], ['Sin ruta · conectados', drivers.filter(r => r.connected && r.operational_status === 'SIN_RUTA').length],
      ['En ruta / retorno', drivers.filter(r => ['EN_RUTA','RETORNO'].includes(r.operational_status)).length], ['Pendientes de documentos', drivers.filter(r => ['ESPERANDO_DOCUMENTOS','ESPERANDO_GUIA','GUIA_EN_VALIDACION','GUIA_OBSERVADA'].includes(r.operational_status)).length],
    ].map(([label, count]) => <div key={label} className="rounded-xl border border-slate-200 bg-white p-3"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-2xl font-bold text-[#002855]">{count}</p></div>)}</div>
    <details className="rounded-xl border border-slate-200 bg-white p-3 text-xs leading-5 text-slate-600"><summary className="cursor-pointer font-semibold text-[#002855]">Cómo leer la conexión y el GPS · Consulta: {gpsTime(asOf)}</summary><div className="mt-2"><p>«App conectada» indica una señal recibida en los últimos 90 segundos. La sesión guardada no implica conexión. Las ubicaciones con más de 2 minutos se muestran en gris como última posición conocida.</p><p>Sin GPS o con permiso denegado, el conductor permanece en la lista. Se muestran conexiones de las últimas 24 horas y servicios abiertos de tu sede.</p></div></details>
    {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">No se pudo actualizar el monitor: {error}. La información anterior puede estar desactualizada.</p>}
    <div className="grid gap-3 rounded-xl border border-slate-200 bg-white p-3 sm:grid-cols-2 xl:grid-cols-4">
      <label className="relative"><span className="sr-only">Buscar conductor, placa o despacho</span><Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Conductor, placa o despacho" className="min-h-11 w-full rounded-lg border border-slate-300 pl-9 pr-3 text-sm" /></label>
      <label><span className="sr-only">Estado operativo</span><select value={state} onChange={e => setState(e.target.value)} className="min-h-11 w-full rounded-lg border border-slate-300 px-3 text-sm"><option value="all">Todos los estados</option>{Object.entries(monitorStates).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select></label>
      <label><span className="sr-only">Conexión del app</span><select value={connection} onChange={e => setConnection(e.target.value)} className="min-h-11 w-full rounded-lg border border-slate-300 px-3 text-sm"><option value="all">Todas las conexiones</option><option value="connected">App conectada</option><option value="disconnected">Sin conexión reciente</option></select></label>
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={geofences} onChange={e => setGeofences(e.target.checked)} />Mostrar geocercas</label>
    </div>
    <div className="grid min-w-0 flex-1 gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
      <section aria-label="Conductores y estados" className="max-h-[42dvh] overflow-y-auto rounded-xl border border-slate-200 bg-white lg:max-h-[65dvh]">
        {!asOf && !error ? <p className="flex items-center justify-center p-6 text-sm"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Consultando conductores…</p> : !filtered.length ? <div className="p-6 text-center text-slate-500"><Radio className="mx-auto mb-2 h-7 w-7" /><p>Sin conductores para estos filtros</p></div> : filtered.map(row => <button key={row.id} type="button" onClick={() => setSelectedId(row.id === selectedId ? null : row.id)} className={`w-full space-y-2 border-b border-slate-100 p-4 text-left ${row.id === selectedId ? 'bg-blue-50' : 'hover:bg-slate-50'}`}>
          <p className="break-words text-sm font-bold text-[#002855]">{row.driver}</p><p className="text-xs text-slate-600">{row.plate || 'Sin unidad asignada'}{row.dispatch_number && ` · ${row.dispatch_number}`}</p><Status row={row} />
          <p className={`text-xs ${row.connected ? 'font-semibold text-emerald-700' : 'text-slate-500'}`}>{row.driver_id ? (row.connected ? '● App conectada' : '○ Sin conexión reciente') : 'Sin app vinculada'}</p>
          <p className="text-xs text-slate-500">Conexión: {gpsTime(row.last_seen_at)}</p>
          <p className={`flex items-start gap-1 text-xs ${row.gps_fresh ? 'text-slate-600' : 'text-amber-800'}`}><MapPin className="mt-0.5 h-3 w-3 shrink-0" />{row.gps_state === 'denied' ? 'Permiso GPS denegado · ' : !row.gps_fresh ? 'GPS sin señal reciente · ' : 'GPS · '}{gpsTime(row.gps_at)}</p>
        </button>)}
      </section>
      <section aria-label="Mapa GPS" className="relative h-[52dvh] min-h-[330px] min-w-0 overflow-hidden rounded-xl border border-slate-200 lg:h-[65dvh]">
        <MapComponent vehicles={markers} selectedVehicleId={selectedId} onVehicleSelect={setSelectedId} showGeofences={geofences} />
        {!markers.length && <p className="pointer-events-none absolute left-3 right-3 top-3 z-[500] rounded-xl border border-slate-200 bg-white/95 p-3 text-xs text-slate-600 shadow">Los conductores sin ubicación disponible se muestran en la lista. No hay puntos GPS para estos filtros.</p>}
      </section>
    </div>
    {selected && <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-bold text-[#002855]">{selected.driver}</h2><p className="text-sm text-slate-600">{selected.plate || 'Sin unidad asignada'} · {selected.dispatch_number || 'Sin ruta asignada'}</p></div><Status row={selected} /></div><p className="text-sm text-slate-600">GPS: {gpsTime(selected.gps_at)}{selected.accuracy_m !== null && ` · precisión ±${Math.round(selected.accuracy_m)} m`}{selected.gps_fresh && selected.speed !== null && ` · ${Math.round(selected.speed)} km/h`}</p><div className="flex flex-wrap gap-2">{selected.dispatch_id && canRegister && <button onClick={() => setEventOpen(true)} className="flex min-h-11 items-center gap-2 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white"><Plus className="h-4 w-4" />Registrar novedad</button>}{selected.dispatch_id && <Link href="/torre-control" className="flex min-h-11 items-center rounded-lg border border-slate-300 px-4 text-sm">Revisar servicio y conformidad</Link>}</div></section>}
    <Modal isOpen={eventOpen} onClose={() => setEventOpen(false)} title={`Registrar novedad · ${selected?.plate || selected?.driver || ''}`} maxWidth="max-w-md"><form onSubmit={register} className="space-y-4"><label className="block text-sm">Tipo de evento<select value={eventType} onChange={e => setEventType(e.target.value)} className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 px-3">{[['CHECKPOINT','Punto de control'],['LLEGADA_CLIENTE','Llegada a cliente'],['SALIDA_CLIENTE','Salida de cliente'],['RETRASO','Retraso / tráfico'],['INCIDENCIA','Incidencia'],['FIN_RUTA','Finalizar ruta (exige conformidad aprobada)']].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="block text-sm">Descripción<textarea required maxLength={1000} value={description} onChange={e => setDescription(e.target.value)} className="mt-2 w-full rounded-lg border border-slate-300 p-3" rows={3} /></label><p className="text-xs text-slate-500">La novedad registra el reporte. El avance del servicio sigue sujeto a su flujo operativo y a la guía aprobada.</p><button disabled={busy || !description.trim()} className="min-h-11 w-full rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Guardando…' : 'Guardar novedad'}</button></form></Modal>
  </div>
}
