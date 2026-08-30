"use client"
import { useState, useEffect } from 'react'
import { AlertTriangle, Wrench, Camera, CheckCircle2, Loader2, Navigation } from 'lucide-react'
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
      const parsedDriver = JSON.parse(driverData)
      setDriver(parsedDriver)
      fetchActiveVehicle(parsedDriver)
      fetchRecentRecords(parsedDriver.id)
    }
  }, [])

  const fetchActiveVehicle = async (driverData: any) => {
    try {
      // Find the most recent active dispatch for this driver to get the vehicle
      const { data, error } = await supabase
        .from('dispatches')
        .select('vehicle_plate')
        .eq('driver_name', `${driverData.first_name} ${driverData.last_name}`)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
        
      if (data && data.vehicle_plate) {
        setVehiclePlate(data.vehicle_plate)
      }
    } catch (err) {
      console.error(err)
    }
  }
  
  const fetchRecentRecords = async (driverId: string) => {
    try {
      const { data, error } = await supabase
        .from('vehicle_maintenance_records')
        .select('*')
        .eq('reported_by', driverId)
        .order('created_at', { ascending: false })
        .limit(5)
        
      if (data) {
        setRecentRecords(data)
      }
    } catch (err) {
      console.error(err)
    }
  }

  const handlePhotoCapture = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setPhotoFile(file)
      setPhoto(URL.createObjectURL(file))
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!vehiclePlate) {
      toast.error('Indique la placa de la unidad afectada')
      return
    }
    if (!description.trim()) {
      toast.error('Describa el problema o falla')
      return
    }
    
    setProcessing(true)
    try {
      let evidence_url = null

      if (photoFile) {
        const fileExt = photoFile.name.split('.').pop() || 'jpg'
        const fileName = `falla-${vehiclePlate}-${Date.now()}.${fileExt}`
        const filePath = `fallas/${fileName}`

        const { error: uploadError } = await supabase.storage
          .from('evidence')
          .upload(filePath, photoFile)

        if (!uploadError) {
          const { data: urlData } = supabase.storage
            .from('evidence')
            .getPublicUrl(filePath)
          evidence_url = urlData.publicUrl
        }
      }

      const finalDescription = evidence_url 
        ? `${description}\n\n[Evidencia fotográfica adjunta. URL: ${evidence_url}]`
        : description

      const { error } = await supabase
        .from('vehicle_maintenance_records')
        .insert({
          vehicle_plate: vehiclePlate,
          record_type: 'FALLA_REPORTADA',
          status: 'PENDIENTE',
          description: finalDescription,
          reported_by: driver.id
        })
        
      if (error) throw error
      
      toast.success('Falla reportada con éxito. Taller de mantenimiento será notificado.')
      setDescription('')
      setPhoto(null)
      setPhotoFile(null)
      fetchRecentRecords(driver.id)
    } catch (err: any) {
      toast.error('Error al reportar la falla: ' + err.message)
    } finally {
      setProcessing(false)
    }
  }

  return (
    <div className="p-4 max-w-md mx-auto pb-24">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-[#002855] flex items-center gap-2">
          <Wrench className="w-6 h-6 text-orange-500" />
          Taller / Fallas
        </h2>
        <p className="text-slate-500 text-sm">Reporte de fallas y mantenimiento</p>
      </div>

      <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm mb-6">
        <h3 className="font-bold text-slate-800 mb-4 flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-red-500" />
          Nueva Falla Detectada
        </h3>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Placa de la Unidad</label>
            <input 
              type="text" 
              placeholder="ABC-123"
              className="w-full rounded-lg border-slate-300 text-sm focus:ring-[#002855] uppercase"
              value={vehiclePlate}
              onChange={(e) => setVehiclePlate(e.target.value.toUpperCase())}
            />
          </div>
          
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Descripción del Problema</label>
            <textarea 
              rows={3}
              placeholder="Ej. Freno largo, ruido en la caja de cambios, llanta pinchada..."
              className="w-full rounded-lg border-slate-300 text-sm focus:ring-[#002855] resize-none"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          
          <div className="mb-4">
            <label className="block text-xs font-semibold text-slate-700 mb-1">Evidencia Fotográfica (Opcional)</label>
            {photo ? (
                <div className="relative rounded-lg overflow-hidden border border-slate-200 h-32">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photo} alt="Falla" className="w-full h-full object-cover" />
                  <button type="button" onClick={() => {setPhoto(null); setPhotoFile(null);}} className="absolute top-2 right-2 bg-black/50 text-white rounded-full p-1 text-xs px-2 hover:bg-black/70 transition-colors">Quitar</button>
                </div>
            ) : (
              <label className="border-2 border-dashed border-slate-300 bg-slate-50 rounded-lg h-24 flex flex-col items-center justify-center cursor-pointer hover:bg-slate-100 transition-colors">
                <Camera className="w-6 h-6 text-slate-400 mb-1" />
                <span className="text-xs font-semibold text-slate-600">Tomar foto de la falla</span>
                <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handlePhotoCapture} />
              </label>
            )}
          </div>
          
          <button 
            type="submit" 
            disabled={processing}
            className="w-full bg-red-600 text-white py-3 rounded-lg font-bold text-sm hover:bg-red-700 flex justify-center items-center gap-2"
          >
            {processing ? <Loader2 className="w-5 h-5 animate-spin" /> : "Enviar Reporte al Taller"}
          </button>
        </form>
      </div>

      {recentRecords.length > 0 && (
        <div>
          <h3 className="font-bold text-slate-800 mb-3">Historial de Reportes</h3>
          <div className="space-y-3">
            {recentRecords.map((record) => (
              <div key={record.id} className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm text-sm">
                <div className="flex justify-between items-start mb-2">
                  <span className="font-bold text-[#002855]">{record.vehicle_plate}</span>
                  <span className={`text-[10px] font-bold px-2 py-1 rounded-full ${
                    record.status === 'PENDIENTE' ? 'bg-yellow-100 text-yellow-800' :
                    record.status === 'EN_REVISION' ? 'bg-orange-100 text-orange-800' :
                    record.status === 'EN_MANTENIMIENTO' ? 'bg-red-100 text-red-800' :
                    'bg-green-100 text-green-800'
                  }`}>
                    {record.status}
                  </span>
                </div>
                <p className="text-slate-600 line-clamp-2">{record.description}</p>
                <p className="text-[10px] text-slate-400 mt-2">
                  {new Date(record.created_at).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
