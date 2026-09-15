"use client"
import { useState, useEffect } from 'react'
import { Plus, Receipt, Calendar, FileText, Check, Ban, Loader2, DollarSign } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'

interface Contract {
  id: string
  code: string
  type: string
  clients?: {
    business_name: string
  }
  contract_budgets?: Array<{
    balance_pen: number
  }>
}

interface ContractService {
  id: string
  contract_id: string
  service_type: string
  description: string
  amount_pen: number
  service_date: string
  status: string
  created_at: string
  contracts?: {
    code: string
    clients?: {
      business_name: string
    }
  }
}

export default function ContractServicesPage() {
  const supabase = createClient()
  const [services, setServices] = useState<ContractService[]>([])
  const [contracts, setContracts] = useState<Contract[]>([])
  const [loading, setLoading] = useState(true)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const [newService, setNewService] = useState({
    contract_id: '',
    service_type: 'FLETE',
    description: '',
    amount_pen: '',
    service_date: new Date().toISOString().split('T')[0]
  })

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    setLoading(true)
    try {
      // 1. Fetch services
      const { data: sData, error: sError } = await supabase
        .from('contract_services')
        .select(`
          *,
          contracts (
            code,
            clients (business_name)
          )
        `)
        .order('created_at', { ascending: false })
      
      if (sError) throw sError
      setServices((sData as any) || [])

      // 2. Fetch contracts
      const { data: cData, error: cError } = await supabase
        .from('contracts')
        .select(`
          id, code, type,
          clients(business_name),
          contract_budgets(balance_pen)
        `)
        .eq('status', 'ACTIVO')

      if (cError) throw cError
      setContracts((cData as any) || [])

    } catch (error: any) {
      toast.error('Error al cargar datos: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  const handleRegisterService = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newService.contract_id || !newService.amount_pen) {
      toast.error('Por favor complete los campos obligatorios.')
      return
    }

    setIsSubmitting(true)
    try {
      const { error } = await supabase.rpc('register_contract_service', {
        p_contract_id: newService.contract_id,
        p_service_type: newService.service_type,
        p_description: newService.description,
        p_amount_pen: parseFloat(newService.amount_pen),
        p_service_date: newService.service_date
      })

      if (error) throw error

      toast.success('Servicio registrado exitosamente.')
      setIsModalOpen(false)
      setNewService({
        contract_id: '',
        service_type: 'FLETE',
        description: '',
        amount_pen: '',
        service_date: new Date().toISOString().split('T')[0]
      })
      fetchData()
    } catch (error: any) {
      toast.error('Error: ' + error.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="space-y-6 w-full mx-auto">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Servicios de Contratos</h1>
          <p className="text-sm text-slate-500">Registro de gastos por servicios que descuentan de la partida del contrato.</p>
        </div>
        <button 
          onClick={() => setIsModalOpen(true)}
          className="flex items-center gap-2 bg-[#002855] text-white px-4 py-2 rounded-lg font-medium hover:bg-[#001d3d] transition-colors shadow-sm"
        >
          <Plus className="w-4 h-4" />
          Registrar Servicio
        </button>
      </div>

      {/* Lista de Servicios */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider border-b">
              <tr>
                <th className="p-4 font-semibold">Fecha</th>
                <th className="p-4 font-semibold">Contrato / Cliente</th>
                <th className="p-4 font-semibold">Tipo</th>
                <th className="p-4 font-semibold w-1/3">Descripción</th>
                <th className="p-4 font-semibold text-right">Monto (PEN)</th>
                <th className="p-4 font-semibold text-center">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-slate-500">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                    Cargando servicios...
                  </td>
                </tr>
              ) : services.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-slate-500">
                    No hay servicios registrados.
                  </td>
                </tr>
              ) : (
                services.map(srv => (
                  <tr key={srv.id} className="hover:bg-slate-50 transition-colors">
                    <td className="p-4 text-sm text-slate-600">
                      <div className="flex items-center gap-1">
                        <Calendar className="w-3.5 h-3.5 text-slate-400" />
                        {new Date(srv.service_date).toLocaleDateString('es-PE')}
                      </div>
                    </td>
                    <td className="p-4">
                      <div className="flex flex-col">
                        <span className="font-bold text-[#002855] text-sm">{srv.contracts?.code}</span>
                        <span className="text-xs text-slate-500">{srv.contracts?.clients?.business_name || 'Sin Cliente'}</span>
                      </div>
                    </td>
                    <td className="p-4">
                      <span className="px-2 py-1 bg-slate-100 text-slate-700 rounded text-xs font-semibold">
                        {srv.service_type}
                      </span>
                    </td>
                    <td className="p-4 text-sm text-slate-700">
                      {srv.description || '-'}
                    </td>
                    <td className="p-4 text-sm font-bold text-slate-900 text-right">
                      S/ {Number(srv.amount_pen).toLocaleString('es-PE', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="p-4 text-center">
                      <span className="px-2 py-1 bg-emerald-100 text-emerald-700 rounded-full text-[10px] font-bold">
                        {srv.status}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title="Registrar Nuevo Servicio"
        maxWidth="max-w-2xl"
      >
        <form onSubmit={handleRegisterService} className="space-y-6">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Contrato (Obligatorio)</label>
              <select
                required
                className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                value={newService.contract_id}
                onChange={(e) => setNewService({...newService, contract_id: e.target.value})}
              >
                <option value="" disabled>Seleccione un Contrato...</option>
                {contracts.map(c => {
                  const balance = c.contract_budgets?.[0]?.balance_pen || 0
                  return (
                    <option key={c.id} value={c.id}>
                      {c.code} - {c.clients?.business_name} (Saldo: S/ {balance.toLocaleString('es-PE')})
                    </option>
                  )
                })}
              </select>
              {newService.contract_id && (
                <div className={`mt-1.5 flex items-center gap-1.5 text-xs font-semibold ${(contracts.find(c => c.id === newService.contract_id)?.contract_budgets?.[0]?.balance_pen || 0) <= 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                  {(contracts.find(c => c.id === newService.contract_id)?.contract_budgets?.[0]?.balance_pen || 0) <= 0 ? (
                    <>
                      <Ban className="w-3.5 h-3.5" />
                      Partida Agotada o Negativa (S/ {(contracts.find(c => c.id === newService.contract_id)?.contract_budgets?.[0]?.balance_pen || 0).toLocaleString('es-PE', { minimumFractionDigits: 2 })})
                    </>
                  ) : (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      Partida Disponible: S/ {(contracts.find(c => c.id === newService.contract_id)?.contract_budgets?.[0]?.balance_pen || 0).toLocaleString('es-PE', { minimumFractionDigits: 2 })}
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Tipo de Servicio</label>
                <select
                  required
                  className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                  value={newService.service_type}
                  onChange={(e) => setNewService({...newService, service_type: e.target.value})}
                >
                  <option value="FLETE">Flete</option>
                  <option value="ESTIBA">Estiba</option>
                  <option value="MANIOBRA">Maniobra</option>
                  <option value="PEAJE">Peaje</option>
                  <option value="PENALIDAD">Penalidad</option>
                  <option value="ERROR">Error Operativo</option>
                  <option value="OTROS">Otros</option>
                </select>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Fecha de Servicio</label>
                <input 
                  type="date"
                  required
                  className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                  value={newService.service_date}
                  onChange={(e) => setNewService({...newService, service_date: e.target.value})}
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Monto (PEN) (Obligatorio)</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <span className="text-slate-500 font-medium">S/</span>
                </div>
                <input 
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  placeholder="0.00"
                  className="w-full pl-9 pr-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                  value={newService.amount_pen}
                  onChange={(e) => setNewService({...newService, amount_pen: e.target.value})}
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Descripción / Glosa</label>
              <textarea 
                rows={3}
                placeholder="Detalles adicionales del servicio..."
                className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none resize-none"
                value={newService.description}
                onChange={(e) => setNewService({...newService, description: e.target.value})}
              ></textarea>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setIsModalOpen(false)}
              className="px-4 py-2 text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg font-medium transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex items-center gap-2 px-6 py-2 bg-[#002855] text-white hover:bg-[#001d3d] rounded-lg font-medium transition-colors disabled:opacity-50"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Guardando...
                </>
              ) : (
                'Registrar Gasto'
              )}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
