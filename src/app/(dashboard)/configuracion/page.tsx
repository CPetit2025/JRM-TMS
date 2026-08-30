"use client"
import { useState, useEffect } from 'react'
import { Save, Building2, Truck, CreditCard, Loader2, Bot, Lock } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'

export default function ConfiguracionPage() {
  const [activeTab, setActiveTab] = useState('empresa')
  const [isSaving, setIsSaving] = useState(false)
  const [isLoaded, setIsLoaded] = useState(false)

  // Estado del formulario
  const [config, setConfig] = useState({
    razonSocial: 'JRM S.A.C.',
    ruc: '20123456789',
    direccion: 'Calle Los Duraznos 645, San Juan De Lurigancho, Lima',
    toleranciaSobrepeso: '5',
    horarioCorte: '18:00',
    moneda: 'PEN',
    igv: '18',
    openAiKey: '',
    geminiKey: '',
    aiProvider: 'openai'
  })
  
  const [userRole, setUserRole] = useState<string | null>(null)

  useEffect(() => {
    const init = () => {
      // Leer el rol desde localStorage (como lo hace el Sidebar)
      const storedRole = localStorage.getItem('userRole')
      setUserRole(storedRole?.toLowerCase() || null)
      
      const saved = localStorage.getItem('jrm_sys_config')
      if (saved) {
        setConfig(JSON.parse(saved))
      }
      setIsLoaded(true)
    }
    init()
  }, [])

  const handleSave = () => {
    setIsSaving(true)
    
    // Simular guardado en BD
    setTimeout(() => {
      localStorage.setItem('jrm_sys_config', JSON.stringify(config))
      toast.success('Configuración del sistema guardada con éxito')
      setIsSaving(false)
    }, 800)
  }

  if (!isLoaded) return null
  
  if (userRole !== 'admin') {
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
                <p className="text-sm text-purple-700 mt-1">Estas credenciales se utilizarán para la extracción automática de datos en boletas y facturas de OT y liquidaciones de ruta.</p>
              </div>

              <div className="grid grid-cols-1 gap-6 max-w-2xl">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">Proveedor de IA Principal</label>
                  <select 
                    value={config.aiProvider}
                    onChange={(e) => setConfig({...config, aiProvider: e.target.value})}
                    className="w-full px-4 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-purple-600 outline-none"
                  >
                    <option value="openai">OpenAI (GPT-4o)</option>
                    <option value="gemini">Google (Gemini 1.5 Pro)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">API Key - OpenAI</label>
                  <input 
                    type="password" 
                    placeholder="sk-proj-..."
                    value={config.openAiKey}
                    onChange={(e) => setConfig({...config, openAiKey: e.target.value})}
                    className="w-full px-4 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-purple-600 outline-none" 
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">API Key - Google Gemini</label>
                  <input 
                    type="password"
                    placeholder="AIzaSy..." 
                    value={config.geminiKey}
                    onChange={(e) => setConfig({...config, geminiKey: e.target.value})}
                    className="w-full px-4 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-purple-600 outline-none" 
                  />
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
