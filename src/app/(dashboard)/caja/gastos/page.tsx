"use client"
import { useState, useRef, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { 
  Camera, Upload, FileText, CheckCircle2, AlertTriangle, 
  X, Save, Activity, CreditCard
} from 'lucide-react'
import { toast } from 'sonner'
import { usePermissions } from '@/hooks/usePermissions'

export default function GastosMobilePage() {
  const supabase = createClient()
  const [user, setUser] = useState<any>(null)
  
  const [activeTab, setActiveTab] = useState<'nuevo' | 'historial'>('nuevo')

  useEffect(() => {
    supabase.auth.getUser().then(res => setUser(res.data.user))
  }, [])
  
  // OCR and Form State
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [ocrData, setOcrData] = useState<any>(null)
  const [funds, setFunds] = useState<any[]>([])
  
  const [form, setForm] = useState({
    cash_fund_id: '',
    category: '',
    provider_ruc: '',
    provider_name: '',
    document_type: 'FACTURA',
    document_serial: '',
    document_number: '',
    total_amount: '',
    description: ''
  })

  // History State
  const [history, setHistory] = useState<any[]>([])
  const [loadingHistory, setLoadingHistory] = useState(false)

  // Contexto de Viaje Automático
  const [activeTrip, setActiveTrip] = useState<any>(null)
  const [duplicateWarning, setDuplicateWarning] = useState<boolean>(false)
  const [createIncidence, setCreateIncidence] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (user?.id) {
      fetchMyFunds()
      fetchActiveTrip()
      if (activeTab === 'historial') fetchHistory()
    }
  }, [user, activeTab])

  const fetchActiveTrip = async () => {
    try {
      const { data, error } = await supabase
        .from('dispatches')
        .select('id, vehicle_plate, code')
        .eq('driver_id', user?.id)
        .eq('status', 'EN_RUTA')
        .single()
      if (!error && data) setActiveTrip(data)
    } catch (err) {}
  }

  const fetchMyFunds = async () => {
    try {
      const { data, error } = await supabase
        .from('cash_funds')
        .select('id, code, amount, currency, status')
        .eq('received_by', user?.id)
        .in('status', ['ENTREGADO', 'PARCIALMENTE_LIQUIDADO', 'PENDIENTE_LIQUIDACION'])
      
      if (!error && data) setFunds(data)
    } catch (err) {}
  }

  const fetchHistory = async () => {
    setLoadingHistory(true)
    try {
      const { data, error } = await supabase
        .from('expense_records')
        .select('*')
        .eq('reported_by', user?.id)
        .order('created_at', { ascending: false })
      
      if (!error && data) setHistory(data)
    } catch (err) {} finally {
      setLoadingHistory(false)
    }
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0]
    if (!selectedFile) return
    
    setFile(selectedFile)
    setPreview(URL.createObjectURL(selectedFile))
    
    // Auto process OCR
    await processOCR(selectedFile)
  }

  const processOCR = async (fileToProcess: File) => {
    setIsProcessing(true)
    setOcrData(null)
    
    try {
      const formData = new FormData()
      formData.append('file', fileToProcess)
      
      const res = await fetch('/api/extract-invoice', {
        method: 'POST',
        body: formData
      })
      
      if (!res.ok) throw new Error('Error en el servicio OCR')
      const data = await res.json()
      
      const parsed = data.parsed_data || {}
      setOcrData(parsed)
      
      // Auto-fill form
      setForm(prev => ({
        ...prev,
        provider_ruc: parsed.RUC || '',
        provider_name: parsed.RazonSocial || '',
        total_amount: parsed.Total ? parsed.Total.toString().replace(/[^0-9.]/g, '') : '',
        document_type: parsed.TipoDocumento || 'FACTURA',
        document_serial: parsed.Serie || '',
        document_number: parsed.Numero || ''
      }))
      
      toast.success('Documento analizado por IA')
    } catch (err: any) {
      toast.error('La IA no pudo leer el documento automáticamente. Por favor digite los datos.')
    } finally {
      setIsProcessing(false)
    }
  }

  // Duplicate check
  useEffect(() => {
    const checkDuplicate = async () => {
      if (form.provider_ruc && form.document_type && form.document_serial && form.document_number) {
        const { data, error } = await supabase.rpc('check_expense_duplicate', {
          p_ruc: form.provider_ruc,
          p_type: form.document_type,
          p_serial: form.document_serial,
          p_number: form.document_number
        })
        if (!error && data === true) {
          setDuplicateWarning(true)
        } else {
          setDuplicateWarning(false)
        }
      } else {
        setDuplicateWarning(false)
      }
    }
    const timeoutId = setTimeout(checkDuplicate, 500)
    return () => clearTimeout(timeoutId)
  }, [form.provider_ruc, form.document_type, form.document_serial, form.document_number])

  const handleSaveExpense = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsProcessing(true)
    try {
      let evidenceUrl = null
      
      // 1. Upload file if exists
      if (file) {
        const fileExt = file.name.split('.').pop()
        const fileName = `${user?.id}_${Date.now()}.${fileExt}`
        const { data: uploadData, error: uploadError } = await supabase.storage
          .from('documents')
          .upload(`expenses/${fileName}`, file)
        
        if (!uploadError && uploadData) {
          const { data: { publicUrl } } = supabase.storage.from('documents').getPublicUrl(`expenses/${fileName}`)
          evidenceUrl = publicUrl
        }
      }

      // 2. Insert expense
      const payload = {
        ...form,
        total_amount: parseFloat(form.total_amount),
        evidence_original_url: evidenceUrl,
        reported_by: user?.id,
        ocr_confidence_score: ocrData ? 85.0 : null, // Mock confidence
        status: 'BORRADOR',
        trip_id: activeTrip?.id || null,
        vehicle_plate: activeTrip?.vehicle_plate || null
      }

      const { data: newExpense, error } = await supabase.from('expense_records').insert([payload]).select().single()
      if (error) throw error

      if (createIncidence && activeTrip?.vehicle_plate) {
        await supabase.from('vehicle_maintenance_records').insert([{
          vehicle_plate: activeTrip.vehicle_plate,
          record_type: 'MANTENIMIENTO_CORRECTIVO',
          description: `Generado automáticamente desde gasto de caja: ${form.description}`,
          reported_by: user?.id,
          status: 'PENDIENTE'
        }])
        toast.success('Incidencia de mantenimiento creada')
      }
      
      toast.success('Gasto registrado correctamente')
      resetForm()
      setActiveTab('historial')
    } catch (err: any) {
      toast.error('Error al guardar: ' + err.message)
    } finally {
      setIsProcessing(false)
    }
  }

  const resetForm = () => {
    setFile(null)
    setPreview(null)
    setOcrData(null)
    setForm({
      cash_fund_id: '', category: '', provider_ruc: '', provider_name: '', 
      document_type: 'FACTURA', document_serial: '', document_number: '', total_amount: '', description: ''
    })
  }

  const formatMoney = (amount: number, curr: string = 'PEN') => {
    return new Intl.NumberFormat('es-PE', { style: 'currency', currency: curr }).format(amount)
  }

  return (
    <div className="w-full max-w-5xl mx-auto bg-slate-50 min-h-[calc(100vh-64px)] pb-10 px-4 sm:px-6">
      {/* Header */}
      <div className="bg-blue-600 text-white p-6 sticky top-0 z-10 shadow-md rounded-b-xl mb-6">
        <h1 className="text-xl font-bold">Registro de Gastos</h1>
        <p className="text-blue-100 text-sm mt-1">Sube tus comprobantes desde tu cámara o archivos</p>
      </div>

      {/* Tabs */}
      <div className="flex bg-white shadow-sm mb-6 rounded-xl overflow-hidden border border-slate-200">
        <button 
          onClick={() => setActiveTab('nuevo')}
          className={`flex-1 py-3 text-sm font-bold border-b-2 transition-colors ${activeTab === 'nuevo' ? 'border-blue-600 text-blue-600 bg-blue-50/50' : 'border-transparent text-slate-500 hover:bg-slate-50'}`}
        >
          Nuevo Gasto
        </button>
        <button 
          onClick={() => setActiveTab('historial')}
          className={`flex-1 py-3 text-sm font-bold border-b-2 transition-colors ${activeTab === 'historial' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500'}`}
        >
          Mis Gastos
        </button>
      </div>

      <div className="px-4">
        {activeTab === 'nuevo' ? (
          <form onSubmit={handleSaveExpense} className="space-y-4">
            
            {/* Foto / OCR Section */}
            <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200">
              <h3 className="text-sm font-bold text-slate-800 mb-3 flex items-center gap-2">
                <Camera className="w-4 h-4 text-blue-500" /> Capturar Comprobante
              </h3>
              
              {!preview ? (
                <div 
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full h-32 border-2 border-dashed border-blue-300 bg-blue-50 rounded-xl flex flex-col items-center justify-center cursor-pointer active:bg-blue-100 transition-colors"
                >
                  <Camera className="w-8 h-8 text-blue-500 mb-2" />
                  <span className="text-sm font-bold text-blue-700">Tomar Foto o Subir</span>
                </div>
              ) : (
                <div className="relative">
                  <img src={preview} alt="Preview" className="w-full h-40 object-cover rounded-xl border border-slate-200 shadow-sm" />
                  <button type="button" onClick={() => {setPreview(null); setFile(null); setOcrData(null)}} className="absolute top-2 right-2 bg-slate-900/50 p-1.5 rounded-full text-white backdrop-blur-sm">
                    <X className="w-4 h-4" />
                  </button>
                  {isProcessing && (
                    <div className="absolute inset-0 bg-slate-900/60 rounded-xl flex flex-col items-center justify-center backdrop-blur-sm">
                      <Activity className="w-8 h-8 text-white animate-spin mb-2" />
                      <span className="text-white font-bold text-sm">IA Leyendo Comprobante...</span>
                    </div>
                  )}
                </div>
              )}
              <input type="file" ref={fileInputRef} className="hidden" accept="image/*,application/pdf" capture="environment" onChange={handleFileSelect} />
            </div>

            {/* Formulario Validado */}
            <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 space-y-4">
              {activeTrip && (
                <div className="bg-blue-50 border border-blue-200 p-3 rounded-lg flex items-center gap-2 mb-2">
                  <Activity className="w-5 h-5 text-blue-600 shrink-0" />
                  <div>
                    <p className="text-xs font-bold text-blue-900">Contexto de Viaje Detectado</p>
                    <p className="text-[10px] text-blue-700">Viaje: {activeTrip.code} | Placa: {activeTrip.vehicle_plate}</p>
                  </div>
                </div>
              )}
              {duplicateWarning && (
                <div className="bg-red-50 border border-red-200 p-3 rounded-lg flex items-center gap-2 mb-2">
                  <AlertTriangle className="w-5 h-5 text-red-600 shrink-0" />
                  <div>
                    <p className="text-xs font-bold text-red-900">Posible Comprobante Duplicado</p>
                    <p className="text-[10px] text-red-700">Este comprobante ya fue registrado anteriormente en el sistema.</p>
                  </div>
                </div>
              )}
              {ocrData && (
                <div className="bg-emerald-50 border border-emerald-200 p-3 rounded-lg flex items-start gap-2 mb-2">
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                  <div>
                    <p className="text-xs font-bold text-emerald-900">Lectura Inteligente Completada</p>
                    <p className="text-[10px] text-emerald-700 mt-0.5">Por favor, verifica que los datos extraídos sean correctos antes de guardar.</p>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Cargar a Fondo (Opcional)</label>
                <select value={form.cash_fund_id} onChange={e => setForm({...form, cash_fund_id: e.target.value})} className="w-full p-2.5 border border-slate-300 rounded-lg bg-slate-50 text-sm">
                  <option value="">Sin Fondo (Gasto directo)</option>
                  {funds.map(f => <option key={f.id} value={f.id}>{f.code} - {formatMoney(f.amount, f.currency)}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Categoría de Gasto *</label>
                <select required value={form.category} onChange={e => setForm({...form, category: e.target.value})} className="w-full p-2.5 border border-slate-300 rounded-lg bg-slate-50 text-sm">
                  <option value="">Seleccione...</option>
                  <option value="COMBUSTIBLE">Combustible</option>
                  <option value="PEAJE">Peaje</option>
                  <option value="ALIMENTACION">Alimentación</option>
                  <option value="HOSPEDAJE">Hospedaje</option>
                  <option value="REPUESTOS">Repuestos / Reparación</option>
                  <option value="OTROS">Otros</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs font-bold text-slate-700 mb-1">Importe Total (S/) *</label>
                  <input type="number" step="0.01" required value={form.total_amount} onChange={e => setForm({...form, total_amount: e.target.value})} className="w-full p-3 border-2 border-blue-200 rounded-lg text-lg font-black text-center text-[#002855] focus:border-blue-500 outline-none transition-colors" placeholder="0.00" />
                </div>

                <div className="col-span-2">
                  <label className="block text-xs font-bold text-slate-700 mb-1">RUC Proveedor</label>
                  <input type="text" value={form.provider_ruc} onChange={e => setForm({...form, provider_ruc: e.target.value})} className="w-full p-2.5 border border-slate-300 rounded-lg text-sm" placeholder="Opcional" />
                </div>
                
                <div className="col-span-2">
                  <label className="block text-xs font-bold text-slate-700 mb-1">Razón Social</label>
                  <input type="text" value={form.provider_name} onChange={e => setForm({...form, provider_name: e.target.value})} className="w-full p-2.5 border border-slate-300 rounded-lg text-sm" placeholder="Opcional" />
                </div>

                <div className="col-span-2">
                  <label className="block text-xs font-bold text-slate-700 mb-1">N° Comprobante (Ej. F001-234)</label>
                  <div className="flex gap-2">
                    <input type="text" value={form.document_serial} onChange={e => setForm({...form, document_serial: e.target.value})} className="w-1/3 p-2.5 border border-slate-300 rounded-lg text-sm uppercase" placeholder="Serie" />
                    <input type="text" value={form.document_number} onChange={e => setForm({...form, document_number: e.target.value})} className="w-2/3 p-2.5 border border-slate-300 rounded-lg text-sm" placeholder="Número" />
                  </div>
                </div>

                <div className="col-span-2">
                  <label className="block text-xs font-bold text-slate-700 mb-1">Descripción / Sustento *</label>
                  <textarea required value={form.description} onChange={e => setForm({...form, description: e.target.value})} rows={2} className="w-full p-2.5 border border-slate-300 rounded-lg text-sm" placeholder="Ej. Almuerzo en ruta Chincha..." />
                </div>
                {form.category === 'REPUESTOS' && activeTrip?.vehicle_plate && (
                  <div className="col-span-2 mt-2 bg-slate-50 p-3 rounded-lg border border-slate-200 flex items-start gap-2">
                    <input type="checkbox" id="createIncidence" checked={createIncidence} onChange={e => setCreateIncidence(e.target.checked)} className="mt-0.5 w-4 h-4" />
                    <label htmlFor="createIncidence" className="text-xs text-slate-700">
                      <strong>¿Crear incidencia de mantenimiento?</strong><br/>
                      Se vinculará a la placa {activeTrip.vehicle_plate} en el CMMS.
                    </label>
                  </div>
                )}
              </div>
            </div>

            <button 
              type="submit" 
              disabled={isProcessing || !form.total_amount} 
              className="w-full bg-[#002855] text-white p-4 rounded-xl font-black text-lg shadow-lg hover:bg-[#003566] active:scale-95 transition-all disabled:opacity-50 disabled:active:scale-100 flex justify-center items-center gap-2"
            >
              {isProcessing ? <Activity className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
              {isProcessing ? 'Procesando...' : 'Guardar Gasto'}
            </button>
            
          </form>
        ) : (
          /* Pestaña Historial */
          <div className="space-y-3">
            {loadingHistory ? (
              <div className="py-12 flex justify-center"><Activity className="w-8 h-8 animate-spin text-blue-500" /></div>
            ) : history.length === 0 ? (
              <div className="bg-white p-8 rounded-xl border border-slate-200 text-center shadow-sm">
                <FileText className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                <p className="text-slate-500 font-medium">Aún no has registrado gastos</p>
              </div>
            ) : (
              history.map(gasto => (
                <div key={gasto.id} className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
                  <div className="flex gap-3 items-center">
                    <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center border border-blue-100">
                      <CreditCard className="w-5 h-5 text-blue-500" />
                    </div>
                    <div>
                      <p className="font-bold text-slate-800 text-sm">{gasto.category}</p>
                      <p className="text-[10px] text-slate-400 mt-0.5">{new Date(gasto.created_at).toLocaleDateString()}</p>
                      <span className={`inline-block mt-1 px-2 py-0.5 text-[9px] font-bold rounded uppercase ${
                        gasto.status === 'BORRADOR' ? 'bg-slate-100 text-slate-600' :
                        gasto.status === 'EN_REVISION' ? 'bg-amber-100 text-amber-700' :
                        gasto.status === 'APROBADO' ? 'bg-emerald-100 text-emerald-700' :
                        'bg-red-100 text-red-700'
                      }`}>
                        {gasto.status}
                      </span>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="font-black text-lg text-[#002855]">{formatMoney(gasto.total_amount)}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}
