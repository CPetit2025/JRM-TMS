"use client"
import { useState, useEffect } from 'react'
import { Save, Building2, Truck, CreditCard, Loader2, Bot, Lock, FileSignature, Upload, FileImage, Trash2, CheckCircle2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { usePermissions } from '@/hooks/usePermissions'

export default function ConfiguracionPage() {
  const [activeTab, setActiveTab] = useState('empresa')
  const [isSaving, setIsSaving] = useState(false)
  const [isLoaded, setIsLoaded] = useState(false)
  const { role, isLoaded: permissionsLoaded } = usePermissions()

  // Estado del formulario
  const [config, setConfig] = useState({
    razonSocial: 'JRM S.A.C.',
    ruc: '20123456789',
    direccion: 'Calle Los Duraznos 645, San Juan De Lurigancho, Lima',
    toleranciaSobrepeso: '5',
    horarioCorte: '18:00',
    moneda: 'PEN',
    igv: '18',
    adminSignatureUrl: ''
  })
  
  const [isUploadingSignature, setIsUploadingSignature] = useState(false)
  
  useEffect(() => {
    const init = async () => {
      const saved = localStorage.getItem('jrm_sys_config')
      let localConfig = saved ? JSON.parse(saved) : {}
      // Las versiones anteriores guardaban credenciales de IA en el navegador.
      // Eliminarlas al cargar sin volver a exponerlas en la configuración.
      if (localConfig.openAiKey || localConfig.geminiKey) {
        delete localConfig.openAiKey
        delete localConfig.geminiKey
        delete localConfig.aiProvider
        localStorage.setItem('jrm_sys_config', JSON.stringify(localConfig))
      }

      // Intentar recuperar de BD
      try {
        const supabase = createClient()
        const { data } = await supabase.from('system_settings').select('key, value').eq('key', 'admin_signature_url').single()
        if (data?.value) {
          localConfig.adminSignatureUrl = data.value
        }
      } catch (e) {}

      setConfig(prev => ({ ...prev, ...localConfig }))
      setIsLoaded(true)
    }
    init()
  }, [])

  const handleSave = async () => {
    setIsSaving(true)
    
    // Guardar en Supabase (si la tabla system_settings existe, sino hacer fallo silencioso)
    try {
      const supabase = createClient()
      await supabase.from('system_settings').upsert([
        { key: 'admin_signature_url', value: config.adminSignatureUrl }
      ])
    } catch(e) {
      // Ignorar si la tabla no está creada aún
    }
    
    setTimeout(() => {
      localStorage.setItem('jrm_sys_config', JSON.stringify(config))
      toast.success('Configuración del sistema guardada con éxito')
      setIsSaving(false)
    }, 800)
  }

  const handleSignatureUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (!file.type.startsWith('image/')) {
      toast.error('Por favor selecciona un archivo de imagen válido')
      return
    }

    if (file.size > 2 * 1024 * 1024) {
      toast.error('La imagen no debe superar los 2MB')
      return
    }

    setIsUploadingSignature(true)
    try {
      const supabase = createClient()
      const fileExt = file.name.split('.').pop()
      const fileName = `admin_signature_${Date.now()}.${fileExt}`
      
      const { error: uploadError } = await supabase.storage
        .from('signatures')
        .upload(fileName, file, { upsert: true })

      if (uploadError) throw uploadError

      const { data: urlData } = supabase.storage
        .from('signatures')
        .getPublicUrl(fileName)

      setConfig(prev => ({ ...prev, adminSignatureUrl: urlData.publicUrl }))
      toast.success('Firma cargada correctamente. No olvides guardar los cambios.')
    } catch (e: any) {
      toast.error('Error al subir firma: Verifica que el bucket "signatures" exista. ' + e.message)
    } finally {
      setIsUploadingSignature(false)
    }
  }

  const handleDeleteSignature = () => {
    setConfig(prev => ({ ...prev, adminSignatureUrl: '' }))
    toast.success('Firma eliminada de la configuración. No olvides guardar.')
  }

  if (!isLoaded || !permissionsLoaded) return null
  
  if (role !== 'admin') {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh]">
        <Lock className="w-16 h-16 text-slate-300 mb-4" />
        <h2 className="text-xl font-bold text-slate-700">Acceso Restringido</h2>
        <p className="text-slate-500 mt-2">Solo los Administradores del Sistema pueden acceder a este módulo.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Configuración del Sistema</h1>
        <p className="text-sm text-slate-500">Administra los parámetros generales de la plataforma</p>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        {/* Tabs */}
        <div className="flex border-b border-slate-200 bg-slate-50">
          <button 
            onClick={() => setActiveTab('empresa')}
            className={`px-6 py-4 text-sm font-medium flex items-center gap-2 transition-colors ${
              activeTab === 'empresa' 
                ? 'border-b-2 border-[#002855] text-[#002855] bg-white' 
                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
            }`}
          >
            <Building2 className="w-4 h-4" />
            Datos de la Empresa
          </button>
          <button 
            onClick={() => setActiveTab('operaciones')}
            className={`px-6 py-4 text-sm font-medium flex items-center gap-2 transition-colors ${
              activeTab === 'operaciones' 
                ? 'border-b-2 border-[#002855] text-[#002855] bg-white' 
                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
            }`}
          >
            <Truck className="w-4 h-4" />
            Operaciones
          </button>
          <button 
            onClick={() => setActiveTab('facturacion')}
            className={`px-6 py-4 text-sm font-medium flex items-center gap-2 transition-colors ${
              activeTab === 'facturacion' 
                ? 'border-b-2 border-[#002855] text-[#002855] bg-white' 
                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
            }`}
          >
            <CreditCard className="w-4 h-4" />
            Facturación
          </button>
          <button 
            onClick={() => setActiveTab('integraciones')}
            className={`px-6 py-4 text-sm font-medium flex items-center gap-2 transition-colors ${
              activeTab === 'integraciones' 
                ? 'border-b-2 border-purple-600 text-purple-600 bg-white' 
                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
            }`}
          >
            <Bot className="w-4 h-4" />
            Integraciones e IA
          </button>
          <button 
            onClick={() => setActiveTab('firmas')}
            className={`px-6 py-4 text-sm font-medium flex items-center gap-2 transition-colors ${
              activeTab === 'firmas' 
                ? 'border-b-2 border-emerald-600 text-emerald-600 bg-white' 
                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
            }`}
          >
            <FileSignature className="w-4 h-4" />
            Reportes y Firmas
          </button>
        </div>

        {/* Tab Content */}
        <div className="p-6">
          {activeTab === 'empresa' && (
            <div className="space-y-6 animate-in fade-in duration-300">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">Razón Social</label>
                  <input 
                    type="text" 
                    value={config.razonSocial}
                    onChange={(e) => setConfig({...config, razonSocial: e.target.value})}
                    className="w-full px-4 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none" 
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">RUC</label>
                  <input 
                    type="text" 
                    value={config.ruc}
                    onChange={(e) => setConfig({...config, ruc: e.target.value})}
                    className="w-full px-4 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none" 
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-2">Dirección Principal</label>
                  <input 
                    type="text" 
                    value={config.direccion}
                    onChange={(e) => setConfig({...config, direccion: e.target.value})}
                    className="w-full px-4 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none" 
                  />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'operaciones' && (
            <div className="space-y-6 animate-in fade-in duration-300">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">Tolerancia de Sobrepeso (%)</label>
                  <input 
                    type="number" 
                    value={config.toleranciaSobrepeso}
                    onChange={(e) => setConfig({...config, toleranciaSobrepeso: e.target.value})}
                    className="w-full px-4 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none" 
                  />
                  <p className="text-xs text-slate-500 mt-1">Margen de error permitido al asignar carga a un vehículo.</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">Horario de Corte (Programación)</label>
                  <input 
                    type="time" 
                    value={config.horarioCorte}
                    onChange={(e) => setConfig({...config, horarioCorte: e.target.value})}
                    className="w-full px-4 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none" 
                  />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'facturacion' && (
            <div className="space-y-6 animate-in fade-in duration-300">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">Moneda por Defecto</label>
                  <select 
                    value={config.moneda}
                    onChange={(e) => setConfig({...config, moneda: e.target.value})}
                    className="w-full px-4 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                  >
                    <option value="PEN">Soles (PEN)</option>
                    <option value="USD">Dólares (USD)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">IGV (%)</label>
                  <input 
                    type="number" 
                    value={config.igv}
                    onChange={(e) => setConfig({...config, igv: e.target.value})}
                    className="w-full px-4 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none" 
                  />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'integraciones' && (
            <div className="space-y-6 animate-in fade-in duration-300">
              <div className="bg-purple-50 p-4 rounded-lg border border-purple-100 mb-6">
                <h3 className="font-bold text-purple-900 flex items-center gap-2">
                  <Bot className="w-5 h-5" /> Configuración de Inteligencia Artificial
                </h3>
                <p className="text-sm text-purple-700 mt-1">JRM IA y la extracción de comprobantes usan las credenciales configuradas de forma segura en el servidor.</p>
              </div>
            </div>
          )}

          {activeTab === 'firmas' && (
            <div className="space-y-6 animate-in fade-in duration-300">
              <div className="bg-emerald-50 p-4 rounded-lg border border-emerald-100 mb-6">
                <h3 className="font-bold text-emerald-900 flex items-center gap-2">
                  <FileSignature className="w-5 h-5" /> Firmas Digitales Autorizadas
                </h3>
                <p className="text-sm text-emerald-700 mt-1">Configura las firmas digitales que se adjuntarán automáticamente en reportes gerenciales y liquidaciones (fondos, caja, alquileres).</p>
              </div>

              <div className="grid grid-cols-1 gap-6 max-w-2xl">
                <div className="p-6 border border-slate-200 rounded-xl bg-white shadow-sm">
                  <label className="block text-sm font-bold text-slate-800 mb-4">Firma del Administrador General</label>
                  
                  {config.adminSignatureUrl ? (
                    <div className="space-y-4">
                      <div className="border border-slate-200 rounded-lg p-6 bg-slate-50 flex justify-center items-center h-48 relative overflow-hidden group">
                        <img src={config.adminSignatureUrl} alt="Firma Admin" className="max-h-full max-w-full object-contain" />
                        <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                          <button 
                            onClick={handleDeleteSignature}
                            className="bg-white text-red-600 px-4 py-2 rounded-lg font-medium flex items-center gap-2 hover:bg-red-50"
                          >
                            <Trash2 className="w-4 h-4" /> Eliminar Firma
                          </button>
                        </div>
                      </div>
                      <p className="text-xs text-slate-500 flex items-center gap-1">
                        <CheckCircle2 className="w-4 h-4 text-emerald-500" /> Firma cargada correctamente
                      </p>
                    </div>
                  ) : (
                    <div className="border-2 border-dashed border-slate-300 rounded-xl p-8 flex flex-col items-center justify-center text-center hover:bg-slate-50 transition-colors">
                      <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mb-4">
                        {isUploadingSignature ? <Loader2 className="w-6 h-6 animate-spin" /> : <Upload className="w-6 h-6" />}
                      </div>
                      <h4 className="text-sm font-medium text-slate-800">Subir imagen de firma</h4>
                      <p className="text-xs text-slate-500 mt-1 mb-4">Recomendado: PNG con fondo transparente (max 2MB)</p>
                      <label className="cursor-pointer bg-white border border-slate-300 text-slate-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-slate-50 transition-colors flex items-center gap-2">
                        <FileImage className="w-4 h-4" /> Seleccionar Archivo
                        <input type="file" className="hidden" accept="image/png, image/jpeg" onChange={handleSignatureUpload} disabled={isUploadingSignature} />
                      </label>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="mt-8 flex justify-end">
            <button 
              onClick={handleSave}
              disabled={isSaving}
              className="flex items-center gap-2 bg-[#002855] text-white px-6 py-2.5 rounded-lg font-medium hover:bg-[#001d3d] transition-colors shadow-sm disabled:opacity-70"
            >
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Guardar Cambios
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
