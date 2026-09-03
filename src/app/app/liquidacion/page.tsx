"use client"
import { useState, useEffect } from 'react'
import { FileText, Camera, UploadCloud, DollarSign, CheckCircle2, Wand2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

export default function LiquidacionPage() {
  const [activeTab, setActiveTab] = useState<'gastos' | 'documentos'>('gastos')
  const [gastos, setGastos] = useState<{ tipo: string, monto: string, photo: string | null, id?: string }[]>([])
  
  const [gastoForm, setGastoForm] = useState({ tipo: 'PEAJE', monto: '' })
  const [gastoPhoto, setGastoPhoto] = useState<string | null>(null)
  const [gastoFile, setGastoFile] = useState<File | null>(null)
  const [isExtracting, setIsExtracting] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [dispatch, setDispatch] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    const driverData = localStorage.getItem('jrm_driver')
    if (!driverData) {
      router.push('/app/login')
      return
    }
    const parsedDriver = JSON.parse(driverData)
    fetchActiveDispatch(parsedDriver)
  }, [router])

  const fetchActiveDispatch = async (driverData: any) => {
    try {
      setLoading(true)
      const driverName = `${driverData.first_name} ${driverData.last_name}`
      
      const { data, error } = await supabase
        .from('dispatches')
        .select('id, dispatch_number, vehicle_plate, status')
        .eq('driver_name', driverName)
        .in('status', ['PROGRAMADO', 'EN_CURSO', 'ESPERANDO_AUTORIZACION', 'RETORNO', 'LIQUIDADO'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
        
      if (error) throw error
      if (data) {
        setDispatch(data)
        // Fetch existing expenses
        const { data: expData, error: expError } = await supabase
          .from('dispatch_expenses')
          .select('*')
          .eq('dispatch_id', data.id)
        if (!expError && expData) {
          setGastos(expData.map((e: any) => ({
            tipo: e.expense_type,
            monto: e.amount,
            photo: e.receipt_url || null,
            id: e.id
          })))
        }
      }
    } catch (err: any) {
      toast.error('Error al cargar datos: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleAddGasto = async () => {
    if (!gastoForm.monto || isNaN(Number(gastoForm.monto))) {
      toast.error('Ingresa un monto válido')
      return
    }
    if (!gastoPhoto) {
      toast.error('Debes subir la foto del comprobante')
      return
    }
    if (!dispatch) {
      toast.error('No hay un despacho activo para asociar el gasto')
      return
    }

    setIsSubmitting(true)
    try {
      let receipt_url = gastoPhoto

      // Si hay archivo, subirlo a storage
      if (gastoFile) {
        const fileExt = gastoFile.name.split('.').pop()
        const fileName = `${dispatch.id}-${Math.random()}.${fileExt}`
        const filePath = `gastos/${fileName}`

        const { error: uploadError } = await supabase.storage
          .from('evidence')
          .upload(filePath, gastoFile)

        if (uploadError) throw uploadError

        const { data: urlData } = supabase.storage
          .from('evidence')
          .getPublicUrl(filePath)
          
        receipt_url = urlData.publicUrl
      }

      const { data: insertedData, error } = await supabase
        .from('dispatch_expenses')
        .insert([{
          dispatch_id: dispatch.id,
          expense_type: gastoForm.tipo,
          amount: Number(gastoForm.monto),
          description: `Gasto ingresado por conductor - ${gastoForm.tipo}`,
          receipt_url: receipt_url
        }])
        .select()
        .single()

      if (error) throw error

      setGastos([...gastos, { ...gastoForm, photo: receipt_url, id: insertedData.id }])
      setGastoForm({ tipo: 'PEAJE', monto: '' })
      setGastoPhoto(null)
      setGastoFile(null)
      toast.success('Gasto agregado a la liquidación')
    } catch (err: any) {
      toast.error('Error al guardar: ' + err.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleAIExtraction = async () => {
    if (!gastoFile) {
      toast.error('Por favor, toma o sube una foto del comprobante primero.')
      return
    }
    
    setIsExtracting(true)
    const formData = new FormData()
    formData.append('file', gastoFile)
    
    // Leer config para las llaves de IA
    const savedConfig = localStorage.getItem('jrm_sys_config')
    let headers: any = {}
    if (savedConfig) {
      const configObj = JSON.parse(savedConfig)
      headers['x-ai-provider'] = configObj.aiProvider || 'openai'
      headers['x-ai-key'] = configObj.aiProvider === 'gemini' ? configObj.geminiKey : configObj.openAiKey
    }
    
    try {
      const res = await fetch('/api/extract-invoice', {
        method: 'POST',
        body: formData,
        headers
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Error en la extracción IA')
      }
      
      const data = await res.json()
      setGastoForm(prev => ({
        ...prev,
        monto: data.amount ? String(data.amount) : prev.monto,
      }))
      toast.success('Monto extraído exitosamente ✨')
    } catch (error: any) {
      toast.error(error.message)
    } finally {
      setIsExtracting(false)
    }
  }

  const handlePhotoCapture = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setGastoFile(file)
      setGastoPhoto(URL.createObjectURL(file))
    }
  }

  const totalGastos = gastos.reduce((acc, curr) => acc + Number(curr.monto), 0)

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-[#002855]" />
      </div>
    )
  }

  if (!dispatch) {
    return (
      <div className="min-h-screen bg-slate-50 p-6 flex flex-col items-center justify-center text-center">
        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 max-w-sm w-full">
          <DollarSign className="w-12 h-12 text-slate-300 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-slate-800 mb-2">Sin Ruta Activa</h2>
          <p className="text-slate-500 mb-6 text-sm">No tienes ningún despacho activo para liquidar gastos.</p>
          <button onClick={() => router.push('/app/ruta')} className="px-6 py-2 bg-[#002855] text-white rounded-lg font-bold w-full">
            Ir a Mi Ruta
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 max-w-md mx-auto pb-24">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-[#002855]">Liquidación de Ruta</h2>
        <p className="text-slate-500 text-sm">{dispatch.dispatch_number} • {dispatch.vehicle_plate}</p>
      </div>

      {/* Tabs */}
      <div className="flex bg-slate-200 p-1 rounded-xl mb-6">
        <button 
          onClick={() => setActiveTab('gastos')}
          className={`flex-1 py-2 text-sm font-bold rounded-lg flex justify-center items-center gap-2 transition-all ${activeTab === 'gastos' ? 'bg-white text-[#002855] shadow-sm' : 'text-slate-500'}`}
        >
          <DollarSign className="w-4 h-4" /> Gastos
        </button>
        <button 
          onClick={() => setActiveTab('documentos')}
          className={`flex-1 py-2 text-sm font-bold rounded-lg flex justify-center items-center gap-2 transition-all ${activeTab === 'documentos' ? 'bg-white text-[#002855] shadow-sm' : 'text-slate-500'}`}
        >
          <FileText className="w-4 h-4" /> Documentos
        </button>
      </div>

      {activeTab === 'gastos' ? (
        <div className="space-y-6">
          {/* Formulario de Gastos */}
          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
            <h3 className="font-bold text-slate-800 mb-4">Registrar Nuevo Gasto</h3>
            
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Tipo</label>
                <select 
                  className="w-full rounded-lg border-slate-300 text-sm focus:ring-[#002855]"
                  value={gastoForm.tipo}
                  onChange={(e) => setGastoForm({...gastoForm, tipo: e.target.value})}
                >
                  <option value="PEAJE">Peaje</option>
                  <option value="COMBUSTIBLE">Combustible</option>
                  <option value="VIATICOS">Viáticos (Alimentación)</option>
                  <option value="OTROS">Otros</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Monto (S/)</label>
                <input 
                  type="number" 
                  placeholder="0.00"
                  className="w-full rounded-lg border-slate-300 text-sm focus:ring-[#002855]"
                  value={gastoForm.monto}
                  onChange={(e) => setGastoForm({...gastoForm, monto: e.target.value})}
                />
              </div>
            </div>

            <div className="mb-4">
              {gastoPhoto ? (
                <div className="space-y-3">
                  <div className="relative rounded-lg overflow-hidden border border-slate-200 h-24">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={gastoPhoto} alt="Ticket" className="w-full h-full object-cover" />
                    <button onClick={() => { setGastoPhoto(null); setGastoFile(null); }} className="absolute top-1 right-1 bg-black/50 text-white text-xs px-2 py-1 rounded">Quitar</button>
                  </div>
                  <button 
                    type="button" 
                    onClick={handleAIExtraction}
                    disabled={isExtracting}
                    className="w-full bg-purple-600 text-white px-3 py-2 rounded-lg text-xs font-bold hover:bg-purple-700 disabled:opacity-50 flex items-center justify-center gap-1 shadow-sm transition-all"
                  >
                    {isExtracting ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div> : <Wand2 className="w-4 h-4" />}
                    {isExtracting ? 'Analizando con IA...' : 'Escanear Documento con IA'}
                  </button>
                </div>
              ) : (
                <label className="border border-dashed border-slate-300 bg-slate-50 rounded-lg h-24 flex flex-col items-center justify-center cursor-pointer hover:bg-slate-100">
                  <Camera className="w-6 h-6 text-slate-400 mb-1" />
                  <span className="text-xs font-semibold text-slate-600">Foto del Comprobante</span>
                  <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handlePhotoCapture} />
                </label>
              )}
            </div>

            <button 
              onClick={handleAddGasto} 
              disabled={isSubmitting}
              className="w-full bg-[#002855] text-white py-2 rounded-lg font-bold text-sm hover:bg-[#001f44] flex justify-center items-center gap-2"
            >
              {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
              {isSubmitting ? 'Guardando...' : 'Agregar Gasto'}
            </button>
          </div>

          {/* Lista de Gastos Agregados */}
          {gastos.length > 0 && (
            <div>
              <h3 className="font-bold text-slate-800 mb-3 flex justify-between">
                <span>Gastos Registrados</span>
                <span className="text-[#002855]">Total: S/ {totalGastos.toFixed(2)}</span>
              </h3>
              <div className="space-y-2">
                {gastos.map((g, i) => (
                  <div key={i} className="flex items-center gap-3 bg-white p-3 rounded-lg border border-slate-200 shadow-sm">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={g.photo!} alt="" className="w-12 h-12 rounded object-cover border" />
                    <div className="flex-1">
                      <p className="text-xs font-bold text-slate-800">{g.tipo}</p>
                      <p className="text-sm font-black text-[#002855]">S/ {Number(g.monto).toFixed(2)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          <div className="bg-yellow-50 border border-yellow-200 p-4 rounded-xl">
            <h3 className="font-bold text-yellow-800 mb-1">Guías de Remisión</h3>
            <p className="text-xs text-yellow-700">Toma una foto clara a cada guía sellada por el cliente para cerrar el servicio.</p>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm text-center">
            <UploadCloud className="w-12 h-12 text-slate-300 mx-auto mb-3" />
            <h4 className="font-bold text-slate-700 mb-4">Sube las guías selladas (GRT / GRR)</h4>
            <button className="bg-[#002855] text-white px-6 py-2 rounded-lg font-bold text-sm mx-auto flex items-center gap-2">
              <Camera className="w-4 h-4" /> Tomar Fotos Múltiples
            </button>
          </div>
        </div>
      )}

      {/* Enviar Liquidación */}
      <div className="mt-8">
        <button className="w-full bg-green-600 text-white py-4 rounded-xl font-bold text-lg shadow-lg hover:bg-green-700 flex justify-center items-center gap-2">
          <CheckCircle2 className="w-6 h-6" />
          Enviar Liquidación Final
        </button>
      </div>
    </div>
  )
}
