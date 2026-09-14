"use client"
import { useState, useEffect } from 'react'
import { Plus, Search, Layers, FileWarning, Briefcase, FilePlus2, CheckCircle2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'

interface Contract {
  id: string
  code: string
  type: 'CONTRATO' | 'SUBCONTRATO' | 'ERROR' | 'OT_INDEPENDIENTE'
  client_id: string
  parent_contract_id?: string | null
  status: string
  created_at: string
  budget?: {
    allocated_usd: number
    allocated_pen: number
    balance_pen: number
  }
}

export default function ContratosPage() {
  const supabase = createClient()
  const [contracts, setContracts] = useState<Contract[]>([])
  const [loading, setLoading] = useState(true)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  
  const [newContract, setNewContract] = useState({
    code: '',
    type: 'CONTRATO',
    client_id: '',
    parent_contract_id: '',
    budget_pen: ''
  })

  useEffect(() => {
    fetchContracts()
  }, [])

  const fetchContracts = async () => {
    setLoading(true)
    try {
      // Usaremos una query simulada por ahora hasta que se sincronicen las tablas
      const { data, error } = await supabase
        .from('contracts')
        .select(`
          *,
          contract_budgets (
            allocated_usd, allocated_pen, balance_pen
          )
        `)
        .order('created_at', { ascending: false })

      if (error) throw error

      const formatted = (data || []).map((c: any) => ({
        ...c,
        budget: c.contract_budgets && c.contract_budgets.length > 0 ? c.contract_budgets[0] : null
      }))

      setContracts(formatted)
    } catch (error: any) {
      toast.error('Error al cargar contratos: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  const handleCreateContract = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)

    try {
      // 1. Crear el contrato
      const { data: contractData, error: contractError } = await supabase
        .from('contracts')
        .insert([{
          code: newContract.code,
          type: newContract.type,
          parent_contract_id: newContract.parent_contract_id || null,
          client_id: newContract.client_id || null, // Requiere client_id real
          status: 'ACTIVO'
        }])
        .select()
        .single()

      if (contractError) throw contractError

      // 2. El trigger (creado en la migración 00029) crea la partida de transporte automáticamente
      // pero si el usuario especificó un presupuesto inicial, lo actualizamos:
      if (newContract.budget_pen && Number(newContract.budget_pen) > 0) {
        await supabase
          .from('contract_budgets')
          .update({
            allocated_pen: Number(newContract.budget_pen)
          })
          .eq('contract_id', contractData.id)
      }

      toast.success('Contrato creado exitosamente')
      setIsModalOpen(false)
      setNewContract({ code: '', type: 'CONTRATO', client_id: '', parent_contract_id: '', budget_pen: '' })
      fetchContracts()
    } catch (error: any) {
      toast.error('Error: ' + error.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const getTypeIcon = (type: string) => {
    switch(type) {
      case 'CONTRATO': return <Briefcase className="w-4 h-4 text-blue-600" />
      case 'SUBCONTRATO': return <Layers className="w-4 h-4 text-purple-600" />
      case 'ERROR': return <FileWarning className="w-4 h-4 text-red-600" />
      default: return <FilePlus2 className="w-4 h-4 text-slate-600" />
    }
  }

  const getTypeBadge = (type: string) => {
    switch(type) {
      case 'CONTRATO': return <span className="bg-blue-100 text-blue-800 px-2 py-1 rounded-md text-xs font-semibold flex items-center gap-1"><Briefcase className="w-3 h-3"/> Madre</span>
      case 'SUBCONTRATO': return <span className="bg-purple-100 text-purple-800 px-2 py-1 rounded-md text-xs font-semibold flex items-center gap-1"><Layers className="w-3 h-3"/> Sub</span>
      case 'ERROR': return <span className="bg-red-100 text-red-800 px-2 py-1 rounded-md text-xs font-semibold flex items-center gap-1"><FileWarning className="w-3 h-3"/> Error</span>
      default: return <span className="bg-slate-100 text-slate-800 px-2 py-1 rounded-md text-xs font-semibold">{type}</span>
    }
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex justify-between items-center bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Alta de Contratos</h1>
          <p className="text-sm text-slate-500 mt-1">Gestión unificada de Contratos, Subcontratos y Errores (Partidas de Transporte)</p>
        </div>
        <button
          onClick={() => setIsModalOpen(true)}
          className="flex items-center gap-2 bg-slate-900 text-white px-5 py-2.5 rounded-lg font-medium hover:bg-slate-800 transition-all shadow-md hover:shadow-lg"
        >
          <Plus className="w-4 h-4" />
          Nuevo Contrato
        </button>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-6 py-4 font-semibold">Código / Jerarquía</th>
                <th className="px-6 py-4 font-semibold">Tipo</th>
                <th className="px-6 py-4 font-semibold">Partida de Transporte (S/)</th>
                <th className="px-6 py-4 font-semibold">Saldo Disponible (S/)</th>
                <th className="px-6 py-4 font-semibold">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-slate-500">
                    Cargando contratos...
                  </td>
                </tr>
              ) : contracts.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-slate-500">
                    No hay contratos registrados.
                  </td>
                </tr>
              ) : (
                contracts.map((contract) => (
                  <tr key={contract.id} className="hover:bg-slate-50/50 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex flex-col">
                        <span className="font-semibold text-slate-900 text-base">{contract.code}</span>
                        {contract.parent_contract_id && (
                          <span className="text-xs text-slate-400 mt-0.5">↳ Derivado de otro contrato</span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      {getTypeBadge(contract.type)}
                    </td>
                    <td className="px-6 py-4 font-medium text-slate-700">
                      S/ {contract.budget?.allocated_pen?.toLocaleString('en-US', { minimumFractionDigits: 2 }) || '0.00'}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`font-semibold ${(contract.budget?.balance_pen || 0) <= 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                        S/ {contract.budget?.balance_pen?.toLocaleString('en-US', { minimumFractionDigits: 2 }) || '0.00'}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className="flex items-center gap-1.5 text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-full text-xs font-semibold w-fit">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        {contract.status}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title="Alta de Contrato / OT">
        <form onSubmit={handleCreateContract} className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Tipo de Registro</label>
            <select
              value={newContract.type}
              onChange={(e) => setNewContract({...newContract, type: e.target.value as any})}
              className="w-full border border-slate-300 rounded-lg p-2.5 outline-none focus:ring-2 focus:ring-slate-900/20 focus:border-slate-900 transition-all"
            >
              <option value="CONTRATO">Contrato Principal / OT Madre</option>
              <option value="SUBCONTRATO">Subcontrato</option>
              <option value="ERROR">Error / Reproceso</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Código (Ej. 16584)</label>
            <input
              type="text"
              required
              value={newContract.code}
              onChange={(e) => setNewContract({...newContract, code: e.target.value})}
              className="w-full border border-slate-300 rounded-lg p-2.5 outline-none focus:ring-2 focus:ring-slate-900/20 focus:border-slate-900 transition-all"
              placeholder={newContract.type === 'SUBCONTRATO' ? 'Ej. 16584-S001' : newContract.type === 'ERROR' ? 'Ej. 16584-E001' : 'Ej. 16584'}
            />
          </div>

          {(newContract.type === 'SUBCONTRATO' || newContract.type === 'ERROR') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Contrato Madre (Opcional)</label>
              <select
                value={newContract.parent_contract_id}
                onChange={(e) => setNewContract({...newContract, parent_contract_id: e.target.value})}
                className="w-full border border-slate-300 rounded-lg p-2.5 outline-none focus:ring-2 focus:ring-slate-900/20 focus:border-slate-900 transition-all"
              >
                <option value="">-- Seleccionar Contrato Padre --</option>
                {contracts.filter(c => c.type === 'CONTRATO').map(c => (
                  <option key={c.id} value={c.id}>{c.code}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Partida de Transporte (S/)</label>
            <input
              type="number"
              step="0.01"
              required
              value={newContract.budget_pen}
              onChange={(e) => setNewContract({...newContract, budget_pen: e.target.value})}
              className="w-full border border-slate-300 rounded-lg p-2.5 outline-none focus:ring-2 focus:ring-slate-900/20 focus:border-slate-900 transition-all"
              placeholder="Presupuesto asignado"
            />
            <p className="text-xs text-slate-500 mt-1">
              Esta partida se reservará y consumirá automáticamente al planificar rutas.
            </p>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setIsModalOpen(false)}
              className="px-4 py-2 text-slate-600 font-medium hover:bg-slate-100 rounded-lg transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-6 py-2 bg-slate-900 text-white font-medium rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-50 shadow-md"
            >
              {isSubmitting ? 'Guardando...' : 'Guardar Contrato'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
