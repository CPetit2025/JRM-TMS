"use client"
import { operatingBudget } from '@/lib/transport-budget'
import { useState, useEffect, use } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Briefcase, Layers, FileWarning, DollarSign, MapPin, Send, Receipt } from 'lucide-react'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { createClient } from '@/lib/supabase/client'
import { MAX_TONS, checkVolume, kgHint, tonsToKg } from '@/lib/contract-weight'
import Link from 'next/link'

export default function ContratoDetallePage({ params }: { params: Promise<{ id: string }> }) {
  const unwrappedParams = use(params)
  const router = useRouter()
  const supabase = createClient()
  const [contract, setContract] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('info')
  const [childrenContracts, setChildrenContracts] = useState<any[]>([])
  const [requests, setRequests] = useState<any[]>([])
  const [expenses, setExpenses] = useState<any[]>([])
  
  // Modals state
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [modalType, setModalType] = useState<'SUBCONTRATO' | 'ERROR'>('SUBCONTRATO')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [newChild, setNewChild] = useState({
    correlative: '',
    budget_pen: '',
    total_weight_kg: '',
    total_volume_m3: ''
  })

  useEffect(() => {
    fetchContractDetails()
  }, [unwrappedParams.id])

  const fetchContractDetails = async () => {
    try {
      setLoading(true)
      const { data, error } = await supabase
        .from('vw_contracts_dashboard')
        .select('*')
        .eq('id', unwrappedParams.id)
        .single()

      if (error) throw error
      setContract(data)

      const { data: childrenData, error: childrenError } = await supabase
        .from('contracts')
        .select('*, contract_budgets(allocated_pen, concept)')
        .eq('parent_contract_id', unwrappedParams.id)
        .order('created_at', { ascending: false })
        
      if (!childrenError && childrenData) {
        setChildrenContracts(childrenData.map(child => ({
          ...child,
          allocated_pen: child.contract_budgets?.find((budget: { allocated_pen: number, concept: string }) => budget.concept === 'PARTIDA_TRANSPORTE')?.allocated_pen || 0,
        })))
      }

      const { data: reqData } = await supabase
        .from('transport_requests')
        .select('*')
        .eq('contract_id', unwrappedParams.id)
        .order('created_at', { ascending: false })
      if (reqData) setRequests(reqData)

      // Historial de gastos de la OT: los suyos y los de sus subcontratos y errores (contract_services)
      const ids = [unwrappedParams.id, ...((childrenData || []) as Array<{ id: string }>).map(child => child.id)]
      const { data: expData } = await supabase
        .from('contract_services')
        .select('id, contract_id, service_type, description, amount_pen, service_date, status, provider_name, hours, dispatch_id, void_reason, contracts!contract_id(code, type)')
        .in('contract_id', ids)
        .order('service_date', { ascending: false })
      setExpenses(expData || [])

    } catch (error: any) {
      toast.error('Error al cargar detalle del contrato')
      router.push('/contratos')
    } finally {
      setLoading(false)
    }
  }

  const handleCreateChild = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)

    try {
      let finalCode = newChild.correlative.trim()
      finalCode = `${contract.code}-${finalCode}`

      // Alta en el servidor: hereda la sede del contrato madre, valida duplicados y fija la partida
      const { data, error } = await supabase.rpc('create_contract', {
        p_payload: {
          code: finalCode,
          type: modalType,
          parent_contract_id: contract.id,
          client_id: contract.client_id,
          total_weight_kg: tonsToKg(newChild.total_weight_kg),
          total_volume_m3: checkVolume(newChild.total_volume_m3),
          destination_department: contract.destination_department,
          destination_province: contract.destination_province,
          destination_district: contract.destination_district,
          destination_address: contract.destination_address,
        },
        p_budget_pen: Number(newChild.budget_pen) || 0,
      })
      if (error) throw new Error(error.message)
      const result = data as { success?: boolean; error?: string } | null
      if (!result?.success) throw new Error(result?.error || 'No se pudo registrar')

      toast.success(`${modalType === 'SUBCONTRATO' ? 'Subcontrato' : 'Error'} registrado exitosamente`)
      setIsModalOpen(false)
      setNewChild({ correlative: '', budget_pen: '', total_weight_kg: '', total_volume_m3: '' })
      fetchContractDetails() // refresh parent and children
    } catch (error: any) {
      toast.error(error.message)
    } finally {
      setIsSubmitting(false)
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
        <button
          onClick={() => setActiveTab('solicitudes')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'solicitudes' 
              ? 'border-blue-600 text-blue-600' 
              : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
          }`}
        >
          <Send className="w-4 h-4" />
          Solicitudes
          {requests.length > 0 && (
            <span className="bg-blue-50 text-blue-600 ml-1 px-2 py-0.5 rounded-full text-xs">
              {requests.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('gastos')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'gastos' 
              ? 'border-blue-600 text-blue-600' 
              : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
          }`}
        >
          <Receipt className="w-4 h-4" />
          Gastos
          {expenses.length > 0 && (
            <span className="bg-slate-100 text-slate-600 ml-1 px-2 py-0.5 rounded-full text-xs">
              {expenses.length}
            </span>
          )}
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
              <button 
                onClick={() => { setModalType('SUBCONTRATO'); setIsModalOpen(true); }}
                className="text-sm bg-blue-50 text-blue-700 px-3 py-1.5 rounded-lg font-medium hover:bg-blue-100"
              >
                + Añadir Subcontrato
              </button>
            </div>
            
            {childrenContracts.filter(c => c.type === 'SUBCONTRATO').length === 0 ? (
              <p className="text-sm text-slate-500 py-8 text-center bg-slate-50 rounded-lg border border-slate-100">
                No hay subcontratos registrados.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Código</th>
                      <th className="px-4 py-3 font-semibold text-right">Carga (TON)</th>
                      <th className="px-4 py-3 font-semibold text-right">Partida (S/)</th>
                      <th className="px-4 py-3 font-semibold">Estado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {childrenContracts.filter(c => c.type === 'SUBCONTRATO').map((child) => (
                      <tr key={child.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-3 font-semibold text-slate-900">{child.code}</td>
                        <td className="px-4 py-3 font-medium text-slate-700 text-right">
                          {child.total_weight_kg ? (Number(child.total_weight_kg) / 1000).toLocaleString('en-US') : '0'}
                        </td>
                        <td className="px-4 py-3 font-medium text-slate-700 text-right">
                          S/ {child.allocated_pen?.toLocaleString('en-US', { minimumFractionDigits: 2 }) || '0.00'}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-1 rounded-full text-[10px] font-semibold ${child.status === 'ACTIVO' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-700'}`}>
                            {child.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {activeTab === 'errores' && (
          <div>
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-sm font-semibold text-slate-800">Errores y Penalidades</h3>
              <button 
                onClick={() => { setModalType('ERROR'); setIsModalOpen(true); }}
                className="text-sm bg-red-50 text-red-700 px-3 py-1.5 rounded-lg font-medium hover:bg-red-100"
              >
                + Registrar Error
              </button>
            </div>
            
            {childrenContracts.filter(c => c.type === 'ERROR').length === 0 ? (
              <p className="text-sm text-slate-500 py-8 text-center bg-slate-50 rounded-lg border border-slate-100">
                No hay errores registrados.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Código</th>
                      <th className="px-4 py-3 font-semibold text-right">Penalidad (S/)</th>
                      <th className="px-4 py-3 font-semibold">Estado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {childrenContracts.filter(c => c.type === 'ERROR').map((child) => (
                      <tr key={child.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-3 font-semibold text-slate-900">{child.code}</td>
                        <td className="px-4 py-3 font-medium text-red-600 text-right">
                          - S/ {child.allocated_pen?.toLocaleString('en-US', { minimumFractionDigits: 2 }) || '0.00'}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-1 rounded-full text-[10px] font-semibold ${child.status === 'ACTIVO' ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-700'}`}>
                            {child.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {activeTab === 'finanzas' && (
          <div>
            <h3 className="text-sm font-semibold text-slate-800 mb-4">Resumen Presupuestal</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
              <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
                <span className="block text-xs font-medium text-slate-500 mb-1">Partida bruta (100%)</span>
                <span className="text-xl font-bold text-slate-800">
                  S/ {contract.allocated_pen?.toLocaleString('en-US', {minimumFractionDigits: 2}) || '0.00'}
                </span>
              </div>
              <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
                <span className="block text-xs text-blue-700">Disponible para operación (80%)</span>
                <strong className="text-xl text-[#002855]">S/ {operatingBudget(Number(contract.allocated_pen || 0)).toLocaleString('es-PE', { minimumFractionDigits: 2 })}</strong>
                <p className="text-xs text-slate-600">20% reservado para utilidad</p>
              </div>
              <div className="bg-orange-50 p-4 rounded-lg border border-orange-200">
                <span className="block text-xs font-medium text-orange-600 mb-1">Monto Reservado (En tránsito)</span>
                <span className="text-xl font-bold text-orange-700">
                  S/ {contract.reserved_pen?.toLocaleString('en-US', {minimumFractionDigits: 2}) || '0.00'}
                </span>
              </div>
              <div className="bg-emerald-50 p-4 rounded-lg border border-emerald-200">
                <span className="block text-xs font-medium text-emerald-600 mb-1">Saldo operativo disponible</span>
                <span className="text-xl font-bold text-emerald-700">
                  S/ {contract.balance_pen?.toLocaleString('en-US', {minimumFractionDigits: 2}) || '0.00'}
                </span>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'solicitudes' && (
          <div>
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-sm font-semibold text-slate-800">Solicitud de Transporte</h3>
              <button 
                onClick={() => router.push('/solicitudes')}
                className="text-sm bg-[#002855] text-white px-3 py-1.5 rounded-lg font-medium hover:bg-[#001d3d]"
              >
                Ir a Módulo de Solicitudes
              </button>
            </div>
            
            {requests.length === 0 ? (
              <p className="text-sm text-slate-500 py-8 text-center bg-slate-50 rounded-lg border border-slate-100">
                No hay solicitudes vinculadas a esta OT Madre.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-3 font-semibold">N° Solicitud</th>
                      <th className="px-4 py-3 font-semibold">Solicitante</th>
                      <th className="px-4 py-3 font-semibold">Fecha Req.</th>
                      <th className="px-4 py-3 font-semibold">Origen</th>
                      <th className="px-4 py-3 font-semibold">Estado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {requests.map((req) => (
                      <tr key={req.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-3 font-semibold text-blue-600">{req.request_number}</td>
                        <td className="px-4 py-3 text-slate-700">{req.requester_name}</td>
                        <td className="px-4 py-3 text-slate-700">{req.required_date ? req.required_date.split('T')[0] : '-'}</td>
                        <td className="px-4 py-3 text-slate-700 truncate max-w-[150px]">{req.pickup_address}</td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-1 rounded-full text-[10px] font-semibold ${req.status === 'APROBADA' ? 'bg-emerald-50 text-emerald-700' : 'bg-yellow-50 text-yellow-700'}`}>
                            {req.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {activeTab === 'gastos' && (
          <div>
            <div className="flex flex-wrap justify-between items-center gap-2 mb-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-800">Gastos de la OT, subcontratos y errores</h3>
                <p className="text-xs text-slate-500">Montacargas, grúa, estiba, fletes y otros. Cada gasto descuenta la partida de transporte.</p>
              </div>
              <Link href={`/contratos/servicios?contrato=${contract.id}`}
                className="text-sm bg-[#002855] text-white px-3 py-1.5 rounded-lg font-medium hover:bg-[#001d3d]">
                Registrar gasto a la OT
              </Link>
            </div>

            {expenses.length === 0 ? (
              <p className="text-sm text-slate-500 py-8 text-center bg-slate-50 rounded-lg border border-slate-100">
                No hay gastos registrados en esta OT ni en sus subcontratos o errores.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Fecha</th>
                      <th className="px-4 py-3 font-semibold">Contrato</th>
                      <th className="px-4 py-3 font-semibold">Tipo</th>
                      <th className="px-4 py-3 font-semibold">Detalle</th>
                      <th className="px-4 py-3 font-semibold text-right">Monto</th>
                      <th className="px-4 py-3 font-semibold">Estado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {expenses.map((exp) => (
                      <tr key={exp.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-3 text-slate-600 whitespace-nowrap">{exp.service_date ? new Date(`${exp.service_date}T12:00:00`).toLocaleDateString('es-PE') : '—'}</td>
                        <td className="px-4 py-3 font-medium text-slate-800 whitespace-nowrap">{exp.contracts?.code || '—'}
                          {exp.contracts?.type === 'SUBCONTRATO' && <span className="ml-1 rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold text-purple-800">Sub</span>}
                          {exp.contracts?.type === 'ERROR' && <span className="ml-1 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-800">Error</span>}
                        </td>
                        <td className="px-4 py-3 text-slate-700">{exp.service_type}{exp.hours ? ` · ${exp.hours} h` : ''}</td>
                        <td className="px-4 py-3 text-slate-600">
                          {exp.description || '—'}{exp.provider_name ? ` · ${exp.provider_name}` : ''}
                          {exp.status === 'ANULADO' && exp.void_reason && <span className="block text-xs text-red-600">Anulado: {exp.void_reason}</span>}
                        </td>
                        <td className={`px-4 py-3 text-right font-semibold whitespace-nowrap ${exp.status === 'ANULADO' ? 'text-slate-400 line-through' : 'text-slate-800'}`}>
                          S/ {Number(exp.amount_pen || 0).toLocaleString('es-PE', { minimumFractionDigits: 2 })}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-1 rounded-full text-[10px] font-semibold ${exp.status === 'ANULADO' ? 'bg-red-50 text-red-700' : exp.status === 'PAGADO' || exp.status === 'FACTURADO' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-700'}`}>
                            {exp.status || 'REGISTRADO'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-slate-200 bg-slate-50">
                      <td colSpan={4} className="px-4 py-2 text-right text-xs font-semibold text-slate-500">Total vigente</td>
                      <td className="px-4 py-2 text-right font-bold text-slate-800 whitespace-nowrap">
                        S/ {expenses.filter(exp => exp.status !== 'ANULADO').reduce((sum, exp) => sum + Number(exp.amount_pen || 0), 0).toLocaleString('es-PE', { minimumFractionDigits: 2 })}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      <Modal 
        isOpen={isModalOpen} 
        onClose={() => setIsModalOpen(false)} 
        title={`Nuevo ${modalType === 'SUBCONTRATO' ? 'Subcontrato' : 'Error / Penalidad'}`} 
        maxWidth="max-w-xl"
      >
        <form onSubmit={handleCreateChild} className="space-y-6">
          <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Código / Correlativo</label>
                <div className="flex border border-slate-300 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-[#002855] transition-all bg-white">
                  <div className="bg-slate-100 px-3 py-2.5 text-slate-600 font-medium border-r border-slate-300 text-sm flex items-center">
                    {contract.code}-
                  </div>
                  <input
                    type="text"
                    required
                    value={newChild.correlative}
                    onChange={(e) => setNewChild({...newChild, correlative: e.target.value})}
                    className="w-full p-2.5 outline-none text-sm"
                    placeholder={modalType === 'SUBCONTRATO' ? 'S001' : 'E001'}
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  {modalType === 'SUBCONTRATO' ? 'Partida de Transporte Inicial (S/)' : 'Monto de Penalidad (S/)'}
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={newChild.budget_pen}
                  onChange={(e) => setNewChild({...newChild, budget_pen: e.target.value})}
                  className="w-full border border-slate-300 rounded-lg p-2.5 outline-none focus:ring-2 focus:ring-[#002855] transition-all text-sm bg-white"
                  placeholder="0.00"
                />
              </div>

              {modalType === 'SUBCONTRATO' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Peso (toneladas)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max={MAX_TONS}
                      value={newChild.total_weight_kg}
                      onChange={(e) => setNewChild({...newChild, total_weight_kg: e.target.value})}
                      className="w-full border border-slate-300 rounded-lg p-2.5 outline-none focus:ring-2 focus:ring-[#002855] transition-all text-sm bg-white"
                      placeholder="Ej. 15"
                    />
                    <p className="mt-1 text-xs text-slate-500">{kgHint(newChild.total_weight_kg)}</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Volumen (M3)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={newChild.total_volume_m3}
                      onChange={(e) => setNewChild({...newChild, total_volume_m3: e.target.value})}
                      className="w-full border border-slate-300 rounded-lg p-2.5 outline-none focus:ring-2 focus:ring-[#002855] transition-all text-sm bg-white"
                      placeholder="Ej. 35.5"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
          
          <div className="flex justify-end gap-3 pt-4 border-t border-slate-200">
            <button
              type="button"
              onClick={() => setIsModalOpen(false)}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-2 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors disabled:opacity-50"
            >
              {isSubmitting ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
