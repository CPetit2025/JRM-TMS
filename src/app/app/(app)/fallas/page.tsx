"use client"
import { useState, useEffect } from 'react'
import { AlertTriangle, Camera, Loader2, CheckCircle2, Clock, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'

export default function ConductorFallasPage() {
  const [driver, setDriver] = useState<any>(null)
  const [vehiclePlate, setVehiclePlate] = useState('')
  const [description, setDescription] = useState('')
  const [photo, setPhoto] = useState<string | null>(null)
  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const [processing, setProcessing] = useState(false)
  const [recentRecords, setRecentRecords] = useState<any[]>([])
  const supabase = createClient()

  useEffect(() => {
    const driverData = localStorage.getItem('jrm_driver')
    if (driverData) {
      const parsed = JSON.parse(driverData)
      setDriver(parsed)
      fetchActiveVehicle(parsed)
      fetchRecentRecords(parsed.id)
    }
  }, [])

  const fetchActiveVehicle = async (driverData: any) => {
    const { data } = await supabase
      .from('dispatches')
      .select('vehicle_plate')
      .eq('driver_name', `${driverData.first_name} ${driverData.last_name}`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (data?.vehicle_plate) setVehiclePlate(data.vehicle_plate)
  }

  const fetchRecentRecords = async (driverId: string) => {
    const { data } = await supabase
      .from('vehicle_maintenance_records')
      .select('*')
      .eq('reported_by', driverId)
      .order('created_at', { ascending: false })
      .limit(5)
    if (data) setRecentRecords(data)
  }

  const handlePhotoCapture = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) { setPhotoFile(file); setPhoto(URL.createObjectURL(file)) }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!vehiclePlate) return toast.error('Indique la placa de la unidad afectada')
    if (!description.trim()) return toast.error('Describa el problema o falla')

    setProcessing(true)
    try {
      let evidence_url = null
      if (photoFile) {
        const fileExt = photoFile.name.split('.').pop() || 'jpg'
        const filePath = `fallas/falla-${vehiclePlate}-${Date.now()}.${fileExt}`
        const { error: upErr } = await supabase.storage.from('evidence').upload(filePath, photoFile)
        if (!upErr) {
          const { data: urlData } = supabase.storage.from('evidence').getPublicUrl(filePath)
          evidence_url = urlData.publicUrl
        }
      }

      const { error } = await supabase.from('vehicle_maintenance_records').insert({
        vehicle_plate: vehiclePlate,
        record_type: 'FALLA_REPORTADA',
        status: 'PENDIENTE',
        description: evidence_url ? `${description}\n\n[Foto adjunta: ${evidence_url}]` : description,
        reported_by: driver.id
      })

      if (error) throw error
      toast.success('Falla reportada. El taller ha sido notificado.')
      setDescription('')
      setPhoto(null)
      setPhotoFile(null)
      fetchRecentRecords(driver.id)
    } catch (err: any) {
      toast.error('Error: ' + err.message)
    } finally {
      setProcessing(false)
    }
  }

  const statusConfig: Record<string, { label: string; cls: string }> = {
    PENDIENTE: { label: 'Pendiente', cls: 'bg-amber-100 text-amber-800' },
    EN_REVISION: { label: 'En Revisión', cls: 'bg-orange-100 text-orange-800' },
    EN_MANTENIMIENTO: { label: 'En Taller', cls: 'bg-red-100 text-red-800' },
    COMPLETADO: { label: 'Resuelto', cls: 'bg-green-100 text-green-800' },
    DESCARTADO: { label: 'Descartado', cls: 'bg-slate-100 text-slate-600' },
  }

  return (
    <div className="min-h-full bg-slate-100 pb-6">
      {/* Page Header */}
      <div className="bg-white border-b border-slate-200 px-4 py-4 mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
            <AlertTriangle className="w-5 h-5 text-orange-500" />
          </div>
          <div>
            <h1 className="text-lg font-black text-[#002855]">Reportar Falla</h1>
            <p className="text-xs text-slate-500">Notifica al taller en tiempo real</p>
          </div>
        </div>
      </div>

      <div className="px-4 space-y-4 max-w-md mx-auto">
        {/* Form Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="bg-gradient-to-r from-red-500 to-red-600 px-4 py-3 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-white" />
            <h2 className="font-bold text-white text-sm">Nueva Falla Detectada</h2>
          </div>

          <form onSubmit={handleSubmit} className="p-4 space-y-4">
            {/* Plate */}
            <div>
              <label className="block text-xs font-bold text-slate-600 mb-1.5 uppercase tracking-wide">
                Placa de la Unidad
              </label>
              <input
                type="text"
                placeholder="ABC-123"
                className="w-full px-4 py-3 rounded-xl border-2 border-slate-200 focus:border-[#002855] outline-none font-bold text-slate-900 uppercase text-sm bg-slate-50 transition-colors"
                value={vehiclePlate}
                onChange={(e) => setVehiclePlate(e.target.value.toUpperCase())}
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-xs font-bold text-slate-600 mb-1.5 uppercase tracking-wide">
                Descripción del Problema
              </label>
              <textarea
                rows={4}
                placeholder="Ej. Freno largo, ruido en caja de cambios, llanta pinchada..."
                className="w-full px-4 py-3 rounded-xl border-2 border-slate-200 focus:border-[#002855] outline-none text-slate-900 text-sm bg-slate-50 resize-none transition-colors"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            {/* Photo */}
            <div>
              <label className="block text-xs font-bold text-slate-600 mb-1.5 uppercase tracking-wide">
                Evidencia Fotográfica <span className="text-slate-400 normal-case font-normal">(Opcional)</span>
              </label>
              {photo ? (
                <div className="relative rounded-xl overflow-hidden border-2 border-slate-200 h-36">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photo} alt="Falla" className="w-full h-full object-cover" />
                  <button
                    type="button"
                    onClick={() => { setPhoto(null); setPhotoFile(null) }}
                    className="absolute top-2 right-2 bg-black/60 text-white rounded-full text-xs px-3 py-1 font-bold"
                  >
                    Quitar
                  </button>
                </div>
              ) : (
                <label className="border-2 border-dashed border-slate-300 bg-slate-50 rounded-xl h-28 flex flex-col items-center justify-center cursor-pointer hover:bg-slate-100 hover:border-[#002855] transition-all group">
                  <Camera className="w-7 h-7 text-slate-400 group-hover:text-[#002855] mb-1 transition-colors" />
                  <span className="text-xs font-bold text-slate-500 group-hover:text-[#002855] transition-colors">Tomar foto de la falla</span>
                  <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handlePhotoCapture} />
                </label>
              )}
            </div>

            <button
              type="submit"
              disabled={processing}
              className="w-full bg-red-600 text-white py-4 rounded-xl font-black text-base shadow-md hover:bg-red-700 active:scale-95 flex justify-center items-center gap-2 transition-all"
            >
              {processing ? <Loader2 className="w-5 h-5 animate-spin" /> : <AlertTriangle className="w-5 h-5" />}
              {processing ? 'Enviando...' : 'Enviar Reporte al Taller'}
            </button>
          </form>
        </div>

        {/* Recent Reports */}
        {recentRecords.length > 0 && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
              <Clock className="w-4 h-4 text-slate-400" />
              <h3 className="font-bold text-slate-800 text-sm">Mis Reportes Recientes</h3>
            </div>
            <div className="divide-y divide-slate-100">
              {recentRecords.map((record) => {
                const sc = statusConfig[record.status] || { label: record.status, cls: 'bg-slate-100 text-slate-600' }
                return (
                  <div key={record.id} className="px-4 py-3 flex items-start gap-3">
                    <div className="w-8 h-8 rounded-lg bg-red-50 flex items-center justify-center shrink-0 mt-0.5">
                      <AlertTriangle className="w-4 h-4 text-red-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2 mb-0.5">
                        <span className="font-bold text-[#002855] text-sm">{record.vehicle_plate}</span>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${sc.cls}`}>{sc.label}</span>
                      </div>
                      <p className="text-xs text-slate-600 line-clamp-1">{record.description}</p>
                      <p className="text-[10px] text-slate-400 mt-1">
                        {new Date(record.created_at).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
