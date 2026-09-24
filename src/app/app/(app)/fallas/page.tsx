'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Camera, Loader2, Mic, Clock } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { useActiveTrip } from '@/contexts/ActiveTripContext'

const categories = ['MOTOR', 'FRENOS', 'NEUMATICOS', 'ELECTRICO', 'TRANSMISION', 'SUSPENSION', 'OTRO']
const severities = ['BAJA', 'MEDIA', 'ALTA', 'CRITICA']

export default function DriverFailuresPage() {
  const supabase = useMemo(() => createClient(), [])
  const { user, driver, trip, refresh } = useActiveTrip()
  const [plate, setPlate] = useState('')
  const [category, setCategory] = useState('MOTOR')
  const [severity, setSeverity] = useState('MEDIA')
  const [canContinue, setCanContinue] = useState<boolean | null>(null)
  const [description, setDescription] = useState('')
  const [odometer, setOdometer] = useState('')
  const [photos, setPhotos] = useState<File[]>([])
  const [audio, setAudio] = useState<File | null>(null)
  const [processing, setProcessing] = useState(false)
  const [recent, setRecent] = useState<Array<{ id: string; vehicle_plate: string; description: string; status: string; created_at: string }>>([])

  useEffect(() => { if (trip?.vehicle_plate) setPlate(trip.vehicle_plate) }, [trip?.vehicle_plate])
  useEffect(() => {
    if (!driver) return
    void supabase.from('maintenance_requests').select('id, vehicle_plate, description, status, created_at')
      .eq('driver_id', driver.id).order('created_at', { ascending: false }).limit(5)
      .then(({ data }) => setRecent(data || []))
  }, [driver, supabase])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!user || !driver) return toast.error('No se encontró el perfil del conductor.')
    if (!plate.trim()) return toast.error('No existe una unidad asociada.')
    if (!description.trim()) return toast.error('Describe la falla.')
    if (canContinue === null) return toast.error('Indica si la unidad puede continuar operando.')
    if (!odometer.trim() || isNaN(Number(odometer))) return toast.error('Ingresa el odómetro actual.')
    setProcessing(true)
    const operationId = crypto.randomUUID()
    try {
      const position = await new Promise<GeolocationPosition | null>(resolve => {
        if (!navigator.geolocation) return resolve(null)
        navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), { enableHighAccuracy: true, timeout: 10_000 })
      })
      const paths: string[] = []
      for (const file of photos.slice(0, 5)) {
        const path = `${user.id}/${trip?.id || 'sin-viaje'}/fallas/${operationId}-${paths.length}-${file.name}`
        const { error } = await supabase.storage.from('driver_evidence').upload(path, file, { contentType: file.type, upsert: false })
        if (error) throw error
        paths.push(path)
      }
      let audioPath: string | null = null
      if (audio) {
        audioPath = `${user.id}/${trip?.id || 'sin-viaje'}/fallas/${operationId}-${audio.name}`
        const { error } = await supabase.storage.from('driver_evidence').upload(audioPath, audio, { contentType: audio.type, upsert: false })
        if (error) throw error
      }
      
      const currentLocation = position ? { lat: position.coords.latitude, lon: position.coords.longitude } : null;
      
      const { error } = await supabase.rpc('submit_maintenance_request', {
        p_vehicle_plate: plate.trim().toUpperCase(),
        p_driver_id: driver.id,
        p_dispatch_id: trip?.id || null,
        p_description: description.trim(),
        p_severity: severity || 'MEDIA',
        p_odometer: Number(odometer),
        p_photo_url: paths[0] || null,
        p_location: currentLocation
      })
      
      if (error) {
        if (paths.length > 0) await supabase.storage.from('driver_evidence').remove(paths)
        if (audioPath) await supabase.storage.from('driver_evidence').remove([audioPath])
        throw error
      }
      toast.success('Falla registrada y enviada para evaluación.')
      setDescription(''); setOdometer(''); setPhotos([]); setAudio(null); setCanContinue(null)
      await refresh()
      const { data } = await supabase.from('maintenance_requests')
        .select('id, vehicle_plate, description, status, created_at').eq('driver_id', driver.id)
        .order('created_at', { ascending: false }).limit(5)
      setRecent(data || [])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo registrar la falla.')
    } finally { setProcessing(false) }
  }

  return <div className="mx-auto max-w-lg space-y-4 p-4 pb-8">
    <div><h1 className="text-xl font-black text-[#002855]">Reportar falla</h1><p className="text-sm text-slate-500">La seguridad para continuar la determina el supervisor o taller.</p></div>
    <form onSubmit={submit} className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div><label className="text-xs font-bold text-slate-600">Unidad</label><input value={plate} onChange={event => setPlate(event.target.value.toUpperCase())} readOnly={Boolean(trip?.vehicle_plate)} className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 font-bold read-only:text-slate-500" /></div>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs font-bold text-slate-600">Sistema<select value={category} onChange={event => setCategory(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm">{categories.map(value => <option key={value}>{value}</option>)}</select></label>
        <label className="text-xs font-bold text-slate-600">Severidad<select value={severity} onChange={event => setSeverity(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm">{severities.map(value => <option key={value}>{value}</option>)}</select></label>
      </div>
      <label className="block text-xs font-bold text-slate-600">Odómetro<input type="number" value={odometer} onChange={event => setOdometer(event.target.value)} placeholder="Ej: 125000" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-3 text-sm" /></label>
      <label className="block text-xs font-bold text-slate-600">Descripción<textarea rows={4} value={description} onChange={event => setDescription(event.target.value)} placeholder="Describe los síntomas observados" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-3 text-sm" /></label>
      <fieldset><legend className="text-xs font-bold text-slate-600">¿Puede continuar operando?</legend><div className="mt-2 grid grid-cols-2 gap-2">{[true, false].map(value => <button key={String(value)} type="button" onClick={() => setCanContinue(value)} className={`rounded-xl border px-3 py-3 font-bold ${canContinue === value ? 'border-[#002855] bg-blue-50 text-[#002855]' : 'border-slate-200'}`}>{value ? 'Sí' : 'No'}</button>)}</div></fieldset>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 p-3 text-sm font-bold text-slate-600"><Camera className="h-5 w-5" />Fotos ({photos.length})<input type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={event => setPhotos(Array.from(event.target.files || []).slice(0, 5))} /></label>
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 p-3 text-sm font-bold text-slate-600"><Mic className="h-5 w-5" />{audio ? 'Audio listo' : 'Audio'}<input type="file" accept="audio/*" capture className="hidden" onChange={event => setAudio(event.target.files?.[0] || null)} /></label>
      </div>
      <button disabled={processing} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#002855] py-3.5 font-black text-white disabled:opacity-50">{processing ? <Loader2 className="h-5 w-5 animate-spin" /> : <AlertTriangle className="h-5 w-5" />}Confirmar reporte</button>
    </form>
    {recent.length > 0 && <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white"><h2 className="flex items-center gap-2 border-b p-4 font-bold"><Clock className="h-4 w-4" />Reportes recientes</h2>{recent.map(item => <div key={item.id} className="border-b border-slate-100 p-4 last:border-0"><div className="flex justify-between gap-2"><b className="text-sm text-[#002855]">{item.vehicle_plate}</b><span className="text-xs font-semibold text-amber-700">{item.status}</span></div><p className="mt-1 text-sm text-slate-600">{item.description}</p></div>)}</section>}
  </div>
}
