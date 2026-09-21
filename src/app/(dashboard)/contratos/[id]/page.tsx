"use client"
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Briefcase, Layers, FileWarning, DollarSign, MapPin } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'

export default function ContratoDetallePage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const supabase = createClient()
  const [contract, setContract] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('info')

  useEffect(() => {
    fetchContractDetails()
  }, [params.id])

  const fetchContractDetails = async () => {
    try {
      setLoading(true)
      const { data, error } = await supabase
        .from('vw_contracts_dashboard')
        .select('*')
        .eq('id', params.id)
        .single()

      if (error) throw error
      setContract(data)
    } catch (error: any) {
      toast.error('Error al cargar detalle del contrato')
      router.push('/contratos')
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return <div className="p-8 text-center text-slate-500">Cargando expediente...</div>
  }

  if (!contract) return null

  return (
    <div className="space-y-6 w-full mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4 border-b border-slate-200 pb-4">
        <button 
          onClick={() => router.push('/contratos')}
          className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
        >
          <ArrowLeft className="w-5 h-5 text-slate-600" />
        </button>
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-800">Expediente OT: {contract.code}</h1>
            <span className="bg-blue-100 text-blue-800 px-2.5 py-0.5 rounded-full text-xs font-semibold">
              {contract.type}
            </span>
            <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${contract.status === 'ACTIVO' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-800'}`}>
              {contract.status}
            </span>
          </div>
          <p className="text-sm text-slate-500 mt-1">
            Cliente: <span className="font-medium text-slate-700">{contract.client_name || 'Sin cliente asignado'}</span>
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex space-x-1 border-b border-slate-200">
        <button
          onClick={() => setActiveTab('info')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'info' 
              ? 'border-blue-600 text-blue-600' 
              : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
          }`}
        >
          <Briefcase className="w-4 h-4" />
          Info General
        </button>
        <button
          onClick={() => setActiveTab('subcontratos')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'subcontratos' 
              ? 'border-blue-600 text-blue-600' 
              : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
          }`}
        >
          <Layers className="w-4 h-4" />
          Subcontratos
          {contract.subcontracts_count > 0 && (
            <span className="bg-slate-100 text-slate-600 ml-1 px-2 py-0.5 rounded-full text-xs">
              {contract.subcontracts_count}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('errores')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'errores' 
              ? 'border-blue-600 text-blue-600' 
              : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
          }`}
        >
          <FileWarning className="w-4 h-4" />
          Errores / Penalidades
          {contract.errors_count > 0 && (
            <span className="bg-red-50 text-red-600 ml-1 px-2 py-0.5 rounded-full text-xs">
              {contract.errors_count}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('finanzas')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'finanzas' 
              ? 'border-blue-600 text-blue-600' 
              : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
          }`}
        >
          <DollarSign className="w-4 h-4" />
          Presupuesto
        </button>
      </div>

      {/* Tab Content */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
        {activeTab === 'info' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div>
              <h3 className="text-sm font-semibold text-slate-800 mb-4 flex items-center gap-2">
                <MapPin className="w-4 h-4" />
                Datos de Destino y Carga
              </h3>
              <div className="space-y-3">
                <div className="grid grid-cols-3 text-sm">
                  <span className="text-slate-500">Departamento:</span>
                  <span className="col-span-2 font-medium">{contract.destination_department || '-'}</span>
                </div>
                <div className="grid grid-cols-3 text-sm">
                  <span className="text-slate-500">Provincia:</span>
                  <span className="col-span-2 font-medium">{contract.destination_province || '-'}</span>
                </div>
                <div className="grid grid-cols-3 text-sm">
                  <span className="text-slate-500">Distrito:</span>
                  <span className="col-span-2 font-medium">{contract.destination_district || '-'}</span>
                </div>
                <div className="grid grid-cols-3 text-sm">
                  <span className="text-slate-500">Dirección:</span>
                  <span className="col-span-2 font-medium">{contract.destination_address || '-'}</span>
                </div>
                <div className="grid grid-cols-3 text-sm pt-2 border-t border-slate-100">
                  <span className="text-slate-500">Carga Total:</span>
                  <span className="col-span-2 font-medium">
                    {contract.total_weight_kg ? (contract.total_weight_kg / 1000).toLocaleString() : '0'} TON
                  </span>
                </div>
                <div className="grid grid-cols-3 text-sm">
                  <span className="text-slate-500">Volumen:</span>
                  <span className="col-span-2 font-medium">{contract.total_volume_m3 || '0'} m³</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'subcontratos' && (
          <div>
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-sm font-semibold text-slate-800">Subcontratos Asociados</h3>
              <button className="text-sm bg-blue-50 text-blue-700 px-3 py-1.5 rounded-lg font-medium hover:bg-blue-100">
                + Añadir Subcontrato
              </button>
            </div>
            <p className="text-sm text-slate-500">
              Aquí se listarán los subcontratos hijos. (En desarrollo...)
            </p>
          </div>
        )}

        {activeTab === 'errores' && (
          <div>
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-sm font-semibold text-slate-800">Errores y Penalidades</h3>
              <button className="text-sm bg-red-50 text-red-700 px-3 py-1.5 rounded-lg font-medium hover:bg-red-100">
                + Registrar Error
              </button>
            </div>
            <p className="text-sm text-slate-500">
              Aquí se listarán los errores que afectan el presupuesto de la OT. (En desarrollo...)
            </p>
          </div>
        )}

        {activeTab === 'finanzas' && (
          <div>
            <h3 className="text-sm font-semibold text-slate-800 mb-4">Resumen Presupuestal</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
                <span className="block text-xs font-medium text-slate-500 mb-1">Presupuesto Asignado</span>
                <span className="text-xl font-bold text-slate-800">
                  S/ {contract.allocated_pen?.toLocaleString('en-US', {minimumFractionDigits: 2}) || '0.00'}
                </span>
              </div>
              <div className="bg-orange-50 p-4 rounded-lg border border-orange-200">
                <span className="block text-xs font-medium text-orange-600 mb-1">Monto Reservado (En tránsito)</span>
                <span className="text-xl font-bold text-orange-700">
                  S/ {contract.reserved_pen?.toLocaleString('en-US', {minimumFractionDigits: 2}) || '0.00'}
                </span>
              </div>
              <div className="bg-emerald-50 p-4 rounded-lg border border-emerald-200">
                <span className="block text-xs font-medium text-emerald-600 mb-1">Saldo Disponible</span>
                <span className="text-xl font-bold text-emerald-700">
                  S/ {contract.balance_pen?.toLocaleString('en-US', {minimumFractionDigits: 2}) || '0.00'}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
