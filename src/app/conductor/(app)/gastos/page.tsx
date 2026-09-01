"use client"
import { useState, useEffect } from 'react'
import { DollarSign, FileText, Camera, UploadCloud, CheckCircle2, Wand2, Loader2, Fuel, Receipt, Utensils, Package } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

export default function GastosPage() {
  const [activeTab, setActiveTab] = useState<'gastos' | 'documentos'>('gastos')
  const [gastos, setGastos] = useState<{ tipo: string; monto: string; photo: string | null; id?: string }[]>([])
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
    if (!driverData) { router.push('/conductor/login'); return }
    fetchActiveDispatch(JSON.parse(driverData))
  }, [router])

  const fetchActiveDispatch = async (driverData: any) => {
    setLoading(true)
    try {
      const { data } = await supabase
        .from('dispatches')
        .select('id, dispatch_number, vehicle_plate, status')
        .eq('driver_name', `${driverData.first_name} ${driverData.last_name}`)
        .in('status', ['PROGRAMADO', 'EN_CURSO', 'ESPERANDO_AUTORIZACION', 'RETORNO', 'LIQUIDADO'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (data) {
        setDispatch(data)
        const { data: expData } = await supabase.from('dispatch_expenses').select('*').eq('dispatch_id', data.id)
        if (expData) setGastos(expData.map((e: any) => ({ tipo: e.expense_type, monto: e.amount, photo: e.receipt_url || null, id: e.id })))
      }
    } catch (err: any) {
      toast.error('Error: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const handlePhotoCapture = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) { setGastoFile(file); setGastoPhoto(URL.createObjectURL(file)) }
  }

  const handleAIExtraction = async () => {
    if (!gastoFile) return toast.error('Primero toma una foto del comprobante')
    setIsExtracting(true)
    const formData = new FormData()
    formData.append('file', gastoFile)
    const savedConfig = localStorage.getItem('jrm_sys_config')
    let headers: any = {}
    if (savedConfig) {
      const c = JSON.parse(savedConfig)
      headers['x-ai-provider'] = c.aiProvider || 'openai'
      headers['x-ai-key'] = c.aiProvider === 'gemini' ? c.geminiKey : c.openAiKey
    }
    try {
      const res = await fetch('/api/extract-invoice', { method: 'POST', body: formData, headers })
      if (!res.ok) throw new Error((await res.json()).error)
      const data = await res.json()
      if (data.amount) setGastoForm(prev => ({ ...prev, monto: String(data.amount) }))
      toast.success('Monto extraído con IA ✨')
    } catch (error: any) {
      toast.error(error.message)
    } finally {
      setIsExtracting(false)
    }
  }

  const handleAddGasto = async () => {
    if (!gastoForm.monto || isNaN(Number(gastoForm.monto))) return toast.error('Ingresa un monto válido')
    if (!gastoPhoto) return toast.error('Debes subir la foto del comprobante')
    if (!dispatch) return toast.error('No hay despacho activo')

    setIsSubmitting(true)
    try {
      let receipt_url = gastoPhoto
      if (gastoFile) {
        const fileExt = gastoFile.name.split('.').pop()
        const filePath = `gastos/${dispatch.id}-${Math.random()}.${fileExt}`
        const { error: upErr } = await supabase.storage.from('evidence').upload(filePath, gastoFile)
        if (upErr) throw upErr
        const { data: urlData } = supabase.storage.from('evidence').getPublicUrl(filePath)
        receipt_url = urlData.publicUrl
      }
      const { data: inserted, error } = await supabase.from('dispatch_expenses')
        .insert([{ dispatch_id: dispatch.id, expense_type: gastoForm.tipo, amount: Number(gastoForm.monto), description: `Gasto - ${gastoForm.tipo}`, receipt_url }])
        .select().single()
      if (error) throw error
      setGastos([...gastos, { ...gastoForm, photo: receipt_url, id: inserted.id }])
      setGastoForm({ tipo: 'PEAJE', monto: '' })
      setGastoPhoto(null); setGastoFile(null)
      toast.success('Gasto registrado correctamente')
    } catch (err: any) {
      toast.error('Error: ' + err.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const totalGastos = gastos.reduce((acc, g) => acc + Number(g.monto), 0)

  const tipoConfig: Record<string, { icon: any; color: string }> = {
    PEAJE: { icon: Receipt, color: 'text-blue-600 bg-blue-50' },
    COMBUSTIBLE: { icon: Fuel, color: 'text-orange-600 bg-orange-50' },
    VIATICOS: { icon: Utensils, color: 'text-green-600 bg-green-50' },
    OTROS: { icon: Package, color: 'text-purple-600 bg-purple-50' },
  }

  if (loading) return (
    <div className="flex-1 flex items-center justify-center h-full py-20">
      <div className="text-center">
        <Loader2 className="w-10 h-10 animate-spin text-[#002855] mx-auto mb-3" />
        <p className="text-sm text-slate-500 font-medium">Cargando liquidación...</p>
      </div>
    </div>
  )

  if (!dispatch) return (
    <div className="flex-1 flex items-center justify-center p-6 py-16">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 max-w-xs w-full text-center">
        <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-4">
          <DollarSign className="w-8 h-8 text-slate-400" />
        </div>
        <h2 className="text-lg font-black text-slate-800 mb-2">Sin Ruta Activa</h2>
        <p className="text-slate-500 text-sm mb-6">No tienes despacho activo para registrar gastos.</p>
        <button onClick={() => router.push('/conductor/ruta')} className="w-full bg-[#002855] text-white py-3 rounded-xl font-bold">
          Ir a Mi Ruta
        </button>
      </div>
    </div>
  )

  return (
    <div className="min-h-full bg-slate-100 pb-6">
      {/* Page Header */}
      <div className="bg-white border-b border-slate-200 px-4 py-4 mb-4">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-lg font-black text-[#002855]">Liquidación de Ruta</h1>
            <p className="text-xs text-slate-500 mt-0.5">{dispatch.dispatch_number} • {dispatch.vehicle_plate}</p>
          </div>
          {gastos.length > 0 && (
            <div className="bg-[#002855] text-white px-3 py-1.5 rounded-xl text-right">
              <p className="text-[9px] font-semibold uppercase tracking-wide opacity-75">Total</p>
              <p className="font-black text-sm">S/ {totalGastos.toFixed(2)}</p>
            </div>
          )}
        </div>
      </div>

      <div className="px-4 max-w-md mx-auto space-y-4">
        {/* Tabs */}
        <div className="flex bg-white border border-slate-200 p-1 rounded-2xl shadow-sm gap-1">
          <button
            onClick={() => setActiveTab('gastos')}
            className={`flex-1 py-2.5 text-sm font-bold rounded-xl flex justify-center items-center gap-1.5 transition-all ${activeTab === 'gastos' ? 'bg-[#002855] text-white shadow-md' : 'text-slate-500 hover:bg-slate-50'}`}
          >
            <DollarSign className="w-4 h-4" /> Gastos
          </button>
          <button
            onClick={() => setActiveTab('documentos')}
            className={`flex-1 py-2.5 text-sm font-bold rounded-xl flex justify-center items-center gap-1.5 transition-all ${activeTab === 'documentos' ? 'bg-[#002855] text-white shadow-md' : 'text-slate-500 hover:bg-slate-50'}`}
          >
            <FileText className="w-4 h-4" /> Documentos
          </button>
        </div>

        {activeTab === 'gastos' ? (
          <div className="space-y-4">
            {/* Form Card */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 bg-slate-50">
                <h3 className="font-bold text-slate-800 text-sm">Registrar Nuevo Gasto</h3>
              </div>
              <div className="p-4 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Tipo</label>
                    <select
                      className="w-full px-3 py-3 rounded-xl border-2 border-slate-200 focus:border-[#002855] outline-none text-slate-900 text-sm bg-slate-50 transition-colors"
                      value={gastoForm.tipo}
                      onChange={(e) => setGastoForm({ ...gastoForm, tipo: e.target.value })}
                    >
                      <option value="PEAJE">Peaje</option>
                      <option value="COMBUSTIBLE">Combustible</option>
                      <option value="VIATICOS">Viáticos</option>
                      <option value="OTROS">Otros</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">Monto (S/)</label>
                    <input
                      type="number"
                      placeholder="0.00"
                      className="w-full px-3 py-3 rounded-xl border-2 border-slate-200 focus:border-[#002855] outline-none text-slate-900 text-sm bg-slate-50 transition-colors font-bold"
                      value={gastoForm.monto}
                      onChange={(e) => setGastoForm({ ...gastoForm, monto: e.target.value })}
                    />
                  </div>
                </div>

                {/* Photo area */}
                {gastoPhoto ? (
                  <div className="space-y-2">
                    <div className="relative rounded-xl overflow-hidden border-2 border-slate-200 h-28">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={gastoPhoto} alt="Comprobante" className="w-full h-full object-cover" />
                      <button
                        onClick={() => { setGastoPhoto(null); setGastoFile(null) }}
                        className="absolute top-2 right-2 bg-black/60 text-white rounded-full text-xs px-3 py-1 font-bold"
                      >Quitar</button>
                    </div>
                    <button
                      type="button"
                      onClick={handleAIExtraction}
                      disabled={isExtracting}
                      className="w-full bg-violet-600 text-white py-2.5 rounded-xl text-sm font-bold flex justify-center items-center gap-2 hover:bg-violet-700 transition-all"
                    >
                      {isExtracting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                      {isExtracting ? 'Analizando con IA...' : 'Escanear con IA ✨'}
                    </button>
                  </div>
                ) : (
                  <label className="border-2 border-dashed border-slate-300 bg-slate-50 rounded-xl h-24 flex flex-col items-center justify-center cursor-pointer hover:bg-slate-100 hover:border-[#002855] transition-all group">
                    <Camera className="w-6 h-6 text-slate-400 group-hover:text-[#002855] mb-1 transition-colors" />
                    <span className="text-xs font-bold text-slate-500 group-hover:text-[#002855]">Foto del Comprobante</span>
                    <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handlePhotoCapture} />
                  </label>
                )}

                <button
                  onClick={handleAddGasto}
                  disabled={isSubmitting}
                  className="w-full bg-[#002855] text-white py-3.5 rounded-xl font-bold text-sm shadow-md hover:bg-[#001f44] active:scale-95 flex justify-center items-center gap-2 transition-all"
                >
                  {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <DollarSign className="w-4 h-4" />}
                  {isSubmitting ? 'Guardando...' : 'Agregar Gasto'}
                </button>
              </div>
            </div>

            {/* Gastos list */}
            {gastos.length > 0 && (
              <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100 flex justify-between items-center">
                  <h3 className="font-bold text-slate-800 text-sm">Gastos Registrados</h3>
                  <span className="font-black text-[#002855] text-sm">S/ {totalGastos.toFixed(2)}</span>
                </div>
                <div className="divide-y divide-slate-100">
                  {gastos.map((g, i) => {
                    const Icon = tipoConfig[g.tipo]?.icon || Package
                    const colorCls = tipoConfig[g.tipo]?.color || 'text-slate-500 bg-slate-100'
                    return (
                      <div key={i} className="flex items-center gap-3 px-4 py-3">
                        <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${colorCls}`}>
                          <Icon className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-bold text-slate-700 capitalize">{g.tipo.replace('_', ' ')}</p>
                        </div>
                        <span className="font-black text-[#002855] text-sm">S/ {Number(g.monto).toFixed(2)}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Submit liquidation */}
            <button className="w-full bg-gradient-to-r from-green-500 to-green-600 text-white py-4 rounded-2xl font-black text-base shadow-lg hover:from-green-600 hover:to-green-700 active:scale-95 flex justify-center items-center gap-2 transition-all">
              <CheckCircle2 className="w-5 h-5" />
              Enviar Liquidación Final
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="bg-amber-50 border border-amber-200 px-4 py-3 rounded-2xl flex items-start gap-3">
              <FileText className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <h4 className="font-bold text-amber-800 text-sm">Guías de Remisión</h4>
                <p className="text-xs text-amber-700 mt-0.5">Toma una foto clara a cada guía sellada por el cliente para cerrar el servicio.</p>
              </div>
            </div>
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm text-center">
              <UploadCloud className="w-12 h-12 text-slate-300 mx-auto mb-3" />
              <h4 className="font-bold text-slate-700 mb-4">Sube las guías selladas (GRT / GRR)</h4>
              <button className="bg-[#002855] text-white px-6 py-3 rounded-xl font-bold text-sm mx-auto flex items-center gap-2 mx-auto">
                <Camera className="w-4 h-4" /> Tomar Fotos
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
