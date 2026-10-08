'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { Search, Radio, Loader2, RefreshCw, MapPin, Plus, Info, X, Wifi, Coffee, Route, FileClock } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { InlineStatusBar } from '@/components/ui/inline-status-bar'
import { FilterToolbar, filterControl } from '@/components/ui/filter-toolbar'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { errorMessage } from '@/lib/caja'
import { gpsTime, monitorMarker, monitorStates, stateFor, type DriverMonitorRow } from '@/lib/gps-monitor'

const MapComponent = dynamic(() => import('@/components/map/MapComponent'), { ssr: false,
  loading: () => <div className="flex h-full items-center justify-center bg-slate-100 text-slate-500"><Loader2 className="mr-2 h-5 w-5 animate-spin" />Cargando mapa…</div> })
const tones: Record<string, string> = { blue: 'border-blue-200 bg-blue-50 text-blue-800', green: 'border-emerald-200 bg-emerald-50 text-emerald-800', amber: 'border-amber-200 bg-amber-50 text-amber-900', red: 'border-red-200 bg-red-50 text-red-800' }
const Status = ({ row, compact = false }: { row: DriverMonitorRow; compact?: boolean }) => { const state = stateFor(row); return <span className={`inline-flex shrink-0 whitespace-nowrap rounded-lg border font-semibold ${compact ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-1 text-xs'} ${tones[state.color]}`}>{state.label}</span> }

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
  const [quick, setQuick] = useState<'' | 'conectados' | 'sin_ruta' | 'en_ruta' | 'documentos'>('')
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
  const quickMatch: Record<Exclude<typeof quick, ''>, (row: DriverMonitorRow) => boolean> = {
    conectados: row => row.connected,
    sin_ruta: row => row.connected && row.operational_status === 'SIN_RUTA',
    en_ruta: row => ['EN_RUTA', 'RETORNO'].includes(row.operational_status),
    documentos: row => ['ESPERANDO_DOCUMENTOS', 'ESPERANDO_GUIA', 'GUIA_EN_VALIDACION', 'GUIA_OBSERVADA'].includes(row.operational_status),
  }
  const filtered = drivers.filter(row => {
    const text = `${row.driver} ${row.plate || ''} ${row.dispatch_number || ''}`.toLowerCase()
    return text.includes(search.trim().toLowerCase()) && (state === 'all' || row.operational_status === state) &&
      (connection === 'all' || (connection === 'connected' ? row.connected : !row.connected)) && (!quick || quickMatch[quick](row))
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
  return <div className="flex min-w-0 flex-col gap-2.5">
    <PageHeader showTitle title="Monitoreo GPS" description="Conductores del app, con y sin ruta · actualización cada 15 segundos"
      actions={<><span className="whitespace-nowrap text-xs text-slate-500" aria-live="polite">Consulta: {gpsTime(asOf)}</span><button onClick={() => setVersion(v => v + 1)} className="flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm hover:bg-slate-50"><RefreshCw className="h-4 w-4" />Actualizar</button></>} />
    <InlineStatusBar label="Resumen de conductores (filtra la lista y el mapa)" active={quick || undefined} loading={!asOf && !error}
      onChange={key => setQuick(prev => prev === key ? '' : key as typeof quick)}
      items={[
        { key: 'conectados', label: 'App conectada', count: drivers.filter(quickMatch.conectados).length, icon: <Wifi />, tone: 'emerald' },
        { key: 'sin_ruta', label: 'Sin ruta · conectados', count: drivers.filter(quickMatch.sin_ruta).length, icon: <Coffee />, tone: 'navy' },
        { key: 'en_ruta', label: 'En ruta / retorno', count: drivers.filter(quickMatch.en_ruta).length, icon: <Route />, tone: 'blue' },
        { key: 'documentos', label: 'Pendientes de documentos', count: drivers.filter(quickMatch.documentos).length, icon: <FileClock />, tone: 'amber' },
      ]} />
    {error && <p role="alert" className="rounded-jrm border border-red-200 bg-red-50 p-3 text-sm text-red-800">No se pudo actualizar el monitor: {error}. La información anterior puede estar desactualizada.</p>}
    <FilterToolbar compact label="Búsqueda y filtros del monitor" onClear={() => { setSearch(''); setState('all'); setConnection('all'); setQuick('') }}>
      <label className="relative min-w-0 flex-1 basis-48"><span className="sr-only">Buscar conductor, placa o despacho</span><Search className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" aria-hidden="true" /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Conductor, placa o despacho" className={`${filterControl} pl-9`} /></label>
      <label className="w-full sm:w-52"><span className="sr-only">Estado operativo</span><select value={state} onChange={e => setState(e.target.value)} className={filterControl}><option value="all">Todos los estados</option>{Object.entries(monitorStates).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select></label>
      <label className="w-full sm:w-44"><span className="sr-only">Conexión del app</span><select value={connection} onChange={e => setConnection(e.target.value)} className={filterControl}><option value="all">Todas las conexiones</option><option value="connected">App conectada</option><option value="disconnected">Sin conexión reciente</option></select></label>
      <label className="flex min-h-11 items-center gap-2 whitespace-nowrap text-sm text-slate-700"><input type="checkbox" checked={geofences} onChange={e => setGeofences(e.target.checked)} />Geocercas</label>
      <details className="relative">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-jrm-navy hover:bg-blue-50 [&::-webkit-details-marker]:hidden"><Info className="h-4 w-4" aria-hidden="true" />Cómo leer</summary>
        <div className="absolute right-0 z-[1000] mt-1 w-[min(28rem,calc(100vw-2rem))] space-y-2 rounded-jrm border border-jrm-line bg-white p-4 text-xs leading-5 text-slate-600 shadow-xl">
          <p>«App conectada» indica una señal recibida en los últimos 90 segundos. La sesión guardada no implica conexión. Las ubicaciones con más de 2 minutos se muestran en gris como última posición conocida.</p>
          <p>Sin GPS o con permiso denegado, el conductor permanece en la lista. Se muestran conexiones de las últimas 24 horas y servicios abiertos de tu sede.</p>
        </div>
      </details>
      <span className="whitespace-nowrap text-xs text-slate-500">{asOf ? `${filtered.length} conductor(es)` : ''}</span>
    </FilterToolbar>
    <div className="grid min-w-0 gap-3 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <section aria-label="Conductores y estados" className="max-h-[42dvh] overflow-y-auto rounded-jrm border border-jrm-line bg-jrm-surface shadow-jrm-card lg:h-[calc(100dvh-250px)] lg:max-h-none lg:min-h-[420px]">
        {!asOf && !error ? <p className="flex items-center justify-center p-6 text-sm"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Consultando conductores…</p> : !filtered.length ? <div className="p-6 text-center text-slate-500"><Radio className="mx-auto mb-2 h-7 w-7" /><p>Sin conductores para estos filtros</p></div> : <ul className="divide-y divide-slate-100">{filtered.map(row => <li key={row.id}><button type="button" aria-pressed={row.id === selectedId} onClick={() => setSelectedId(row.id === selectedId ? null : row.id)} className={`w-full px-3 py-2.5 text-left ${row.id === selectedId ? 'bg-blue-50 shadow-[inset_3px_0_0_0_#002855]' : 'hover:bg-slate-50'}`}>
          <span className="block truncate text-sm font-bold text-jrm-navy" title={row.driver}>{row.driver}</span>
          <span className="mt-1 flex min-w-0 items-center gap-2"><Status row={row} compact /><span className="min-w-0 truncate text-xs text-slate-600">{row.plate || 'Sin unidad asignada'}{row.dispatch_number && ` · ${row.dispatch_number}`}</span></span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px]">
            <span className={row.connected ? 'font-semibold text-emerald-700' : 'text-slate-500'} title={`Conexión: ${gpsTime(row.last_seen_at)}`}>{row.driver_id ? (row.connected ? '● App conectada' : '○ Sin conexión reciente') : 'Sin app vinculada'}</span>
            <span className={`inline-flex items-center gap-1 ${row.gps_fresh ? 'text-slate-500' : 'text-amber-800'}`}><MapPin className="h-3 w-3 shrink-0" aria-hidden="true" />{row.gps_state === 'denied' ? 'GPS denegado · ' : !row.gps_fresh ? 'Sin señal · ' : ''}{gpsTime(row.gps_at)}</span>
          </span>
        </button></li>)}</ul>}
      </section>
      <section aria-label="Mapa GPS" className="relative h-[52dvh] min-h-[330px] min-w-0 overflow-hidden rounded-jrm border border-jrm-line shadow-jrm-card lg:h-[calc(100dvh-250px)] lg:min-h-[420px]">
        <MapComponent vehicles={markers} selectedVehicleId={selectedId} onVehicleSelect={setSelectedId} showGeofences={geofences} />
        {!markers.length && <p className="pointer-events-none absolute left-3 right-3 top-3 z-[500] rounded-xl border border-slate-200 bg-white/95 p-3 text-xs text-slate-600 shadow">Los conductores sin ubicación disponible se muestran en la lista. No hay puntos GPS para estos filtros.</p>}
        {selected && <div className="absolute bottom-3 left-3 right-3 z-[500] space-y-2 rounded-jrm border border-jrm-line bg-white/95 p-3 shadow-xl backdrop-blur sm:right-auto sm:w-[26rem]" role="region" aria-label={`Detalle de ${selected.driver}`}>
          <div className="flex items-start justify-between gap-2"><div className="min-w-0"><h2 className="truncate font-bold text-jrm-navy">{selected.driver}</h2><p className="truncate text-sm text-slate-600">{selected.plate || 'Sin unidad asignada'} · {selected.dispatch_number || 'Sin ruta asignada'}</p></div><div className="flex shrink-0 items-center gap-1"><Status row={selected} /><button type="button" onClick={() => setSelectedId(null)} aria-label="Cerrar detalle" className="grid h-9 w-9 place-items-center rounded-lg text-slate-500 hover:bg-slate-100"><X className="h-4 w-4" /></button></div></div>
          <p className="text-xs text-slate-600">GPS: {gpsTime(selected.gps_at)}{selected.accuracy_m !== null && ` · precisión ±${Math.round(selected.accuracy_m)} m`}{selected.gps_fresh && selected.speed !== null && ` · ${Math.round(selected.speed)} km/h`} · Conexión: {gpsTime(selected.last_seen_at)}</p>
          {selected.dispatch_id && <div className="flex flex-wrap gap-2">{canRegister && <button onClick={() => setEventOpen(true)} className="flex min-h-10 items-center gap-2 rounded-lg bg-jrm-navy px-3 text-sm font-semibold text-white hover:bg-jrm-navy-dark"><Plus className="h-4 w-4" />Registrar novedad</button>}<Link href="/torre-control" className="flex min-h-10 items-center rounded-lg border border-slate-300 bg-white px-3 text-sm hover:bg-slate-50">Revisar servicio y conformidad</Link></div>}
        </div>}
      </section>
    </div>
    <Modal isOpen={eventOpen} onClose={() => setEventOpen(false)} title={`Registrar novedad · ${selected?.plate || selected?.driver || ''}`} maxWidth="max-w-md"><form onSubmit={register} className="space-y-4"><label className="block text-sm">Tipo de evento<select value={eventType} onChange={e => setEventType(e.target.value)} className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 px-3">{[['CHECKPOINT','Punto de control'],['LLEGADA_CLIENTE','Llegada a cliente'],['SALIDA_CLIENTE','Salida de cliente'],['RETRASO','Retraso / tráfico'],['INCIDENCIA','Incidencia'],['FIN_RUTA','Finalizar ruta (exige conformidad aprobada)']].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="block text-sm">Descripción<textarea required maxLength={1000} value={description} onChange={e => setDescription(e.target.value)} className="mt-2 w-full rounded-lg border border-slate-300 p-3" rows={3} /></label><p className="text-xs text-slate-500">La novedad registra el reporte. El avance del servicio sigue sujeto a su flujo operativo y a la guía aprobada.</p><button disabled={busy || !description.trim()} className="min-h-11 w-full rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Guardando…' : 'Guardar novedad'}</button></form></Modal>
  </div>
}
