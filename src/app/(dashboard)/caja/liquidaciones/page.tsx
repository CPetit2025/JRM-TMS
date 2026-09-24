"use client"
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { 
  FileText, CheckCircle2, AlertTriangle, Search, Activity, Eye
} from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { toast } from 'sonner'
import { usePermissions } from '@/hooks/usePermissions'
import Link from 'next/link'

export default function LiquidacionesPage() {
  const supabase = createClient()
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getUser().then(res => setUser(res.data.user))
  }, [])
  const [dispatches, setDispatches] = useState<any[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  
  // Detalle Modal
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [selectedDispatch, setSelectedDispatch] = useState<any>(null)
  const [expenses, setExpenses] = useState<any[]>([])
  const [loadingDetail, setLoadingDetail] = useState(false)
  
  const [observation, setObservation] = useState('')

  useEffect(() => {
    fetchDispatches()
  }, [])

  const fetchDispatches = async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('dispatches')
        .select(`
          id, dispatch_number, vehicle_plate, status, liquidation_data, created_at,
          driver:profiles!dispatches_driver_id_fkey(first_name, last_name)
        `)
        .not('liquidation_data', 'is', null)
        .order('created_at', { ascending: false })
      
      if (error) throw error
      setDispatches(data || [])
    } catch (err: any) {
      toast.error('Error al cargar liquidaciones: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const openDispatchDetail = async (dispatchData: any) => {
    setSelectedDispatch(dispatchData)
    setIsModalOpen(true)
    setLoadingDetail(true)
    try {
      const { data, error } = await supabase
        .from('dispatch_expenses')
        .select('*')
        .eq('dispatch_id', dispatchData.id)
        .order('created_at', { ascending: true })
      
      if (!error && data) setExpenses(data)
    } catch (err: any) {
      toast.error('Error al cargar detalle: ' + err.message)
    } finally {
      setLoadingDetail(false)
    }
  }

  const handleUpdateStatus = async (expenseId: string, status: string, comment: string = '') => {
    try {
      // In dispatch_expenses, status anomalies might not exist directly, 
      // but we update the status and optionally append to description if there is a comment.
      const updateData: any = { status }
      if (comment) updateData.description = comment

      const { error } = await supabase
        .from('dispatch_expenses')
        .update(updateData)
        .eq('id', expenseId)
        
      if (error) throw error
      toast.success(`Estado actualizado a ${status}`)
      
      // Update local state
      setExpenses(prev => prev.map(e => e.id === expenseId ? { ...e, status } : e))
    } catch (err: any) {
      toast.error('Error al actualizar: ' + err.message)
    }
  }

  const handleCloseDispatch = async () => {
    if (!selectedDispatch) return
    try {
      const { error } = await supabase
        .from('dispatches')
        .update({ status: 'LIQUIDADO' })
        .eq('id', selectedDispatch.id)
      
      if (error) throw error
      toast.success('Despacho liquidado correctamente')
      setIsModalOpen(false)
      fetchDispatches()
    } catch (err: any) {
      toast.error('Error al liquidar: ' + err.message)
    }
  }

  const formatMoney = (amount: number, curr: string = 'PEN') => {
    return new Intl.NumberFormat('es-PE', { style: 'currency', currency: curr }).format(amount || 0)
  }

  const filtered = dispatches.filter(d => 
    d.dispatch_number?.toLowerCase().includes(searchTerm.toLowerCase()) || 
    d.driver?.first_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    d.driver?.last_name?.toLowerCase().includes(searchTerm.toLowerCase())
  )

  const totalGastos = expenses.reduce((sum, e) => e.status !== 'RECHAZADO' && e.status !== 'ANULADO' ? sum + Number(e.amount || 0) : sum, 0)
  const driverReportedExpenses = selectedDispatch?.liquidation_data?.total_expenses || 0
  const validationDiff = driverReportedExpenses - totalGastos

  return (
    <div className="space-y-6 w-full mx-auto">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-black text-[#002855] tracking-tight">Liquidaciones y Aprobaciones</h1>
          <p className="text-sm text-slate-500 font-medium mt-1">Revisión de gastos, auditoría y cierre de fondos</p>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        <div className="p-4 border-b border-slate-200 flex gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input 
              type="text" 
              placeholder="Buscar despacho o conductor..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        {loading ? (
          <div className="p-12 flex justify-center"><Activity className="w-8 h-8 animate-spin text-blue-500" /></div>
        ) : (
          <div className="overflow-auto max-h-[calc(100vh-220px)]">
          <table className="w-full text-left text-sm text-slate-600 relative">
            <thead className="bg-slate-50 sticky top-0 z-10 shadow-[0_1px_0_0_#e2e8f0] border-slate-200">
                <tr>
                  <th className="p-4 font-semibold text-slate-900">Nº Despacho / Placa</th>
                  <th className="p-4 font-semibold text-slate-900">Conductor</th>
                  <th className="p-4 font-semibold text-slate-900 text-right">Gastos Declarados</th>
                  <th className="p-4 font-semibold text-slate-900 text-center">Estado</th>
                  <th className="p-4 font-semibold text-slate-900 text-right">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.length === 0 ? (
                  <tr><td colSpan={5} className="p-8 text-center text-slate-500">No hay liquidaciones pendientes</td></tr>
                ) : (
                  filtered.map(d => (
                    <tr key={d.id} className="hover:bg-slate-50 transition-colors">
                      <td className="p-4">
                        <div className="font-bold text-[#002855]">{d.dispatch_number}</div>
                        <div className="text-xs text-slate-500">Placa: {d.vehicle_plate}</div>
                      </td>
                      <td className="p-4">
                        <span className="font-semibold text-slate-800 block">{d.driver?.first_name} {d.driver?.last_name}</span>
                      </td>
                      <td className="p-4 text-right font-black text-slate-800">{formatMoney(d.liquidation_data?.total_expenses || 0)}</td>
                      <td className="p-4 text-center">
                        <span className={`inline-block px-3 py-1 text-xs font-bold rounded-full ${
                          d.status === 'LIQUIDADO' ? 'bg-emerald-100 text-emerald-700' :
                          (d.status === 'RETORNO_COMPLETADO' || d.status === 'COMPLETADO') ? 'bg-amber-100 text-amber-700' :
                          'bg-slate-100 text-slate-700'
                        }`}>
                          {d.status}
                        </span>
                      </td>
                      <td className="p-4 text-right">
                        <button 
                          onClick={() => openDispatchDetail(d)}
                          className="text-xs font-bold text-blue-600 hover:text-blue-800 bg-blue-50 px-3 py-1.5 rounded-lg hover:bg-blue-100 transition-colors"
                        >
                          Ver y Liquidar
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title={`Liquidación: ${selectedDispatch?.dispatch_number}`} maxWidth="max-w-4xl">
        {selectedDispatch && (
          <div className="space-y-6">
            <div className="grid grid-cols-3 gap-4 p-4 bg-slate-50 rounded-xl border border-slate-200">
              <div>
                <p className="text-xs font-medium text-slate-500 mb-1">Total Declarado por Conductor</p>
                <p className="text-xl font-black text-slate-800">{formatMoney(driverReportedExpenses)}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-slate-500 mb-1">Suma de Gastos Comprobados</p>
                <p className="text-xl font-black text-slate-800">{formatMoney(totalGastos)}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-slate-500 mb-1">Diferencia de Validación</p>
                <p className={`text-xl font-black ${validationDiff === 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {formatMoney(Math.abs(validationDiff))}
                </p>
              </div>
            </div>

            {loadingDetail ? (
              <div className="py-12 flex justify-center"><Activity className="w-8 h-8 animate-spin text-blue-500" /></div>
            ) : (
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <table className="w-full text-left text-sm text-slate-600">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="p-3 font-semibold text-slate-900">Documento / Contexto</th>
                      <th className="p-3 font-semibold text-slate-900">Categoría</th>
                      <th className="p-3 font-semibold text-slate-900 text-right">Monto</th>
                      <th className="p-3 font-semibold text-slate-900">Anomalías / Alertas</th>
                      <th className="p-3 font-semibold text-slate-900">Estado</th>
                      <th className="p-3 font-semibold text-slate-900 text-right">Auditoría</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {expenses.length === 0 ? (
                      <tr><td colSpan={6} className="p-8 text-center text-slate-500">No se han registrado gastos para este despacho</td></tr>
                    ) : (
                      expenses.map(e => (
                        <tr key={e.id} className="hover:bg-slate-50">
                          <td className="p-3">
                            <div className="font-bold text-slate-800">{e.description || 'Gasto Operativo'}</div>
                            <div className="text-xs text-slate-500">
                              {e.expense_type}
                              {e.fuel_gallons ? ` - ${e.fuel_gallons} gal (Odómetro: ${e.fuel_odometer})` : ''}
                            </div>
                            <div className="text-[10px] font-bold text-blue-600 mt-1">Viaje placa: {selectedDispatch.vehicle_plate}</div>
                          </td>
                          <td className="p-3 font-medium text-slate-700">{e.expense_type}</td>
                          <td className="p-3 font-black text-slate-800 text-right">{formatMoney(e.amount)}</td>
                          <td className="p-3">
                            {e.description && e.status === 'OBSERVADO' ? (
                              <div className="flex items-start gap-1 text-red-600 bg-red-50 p-1 rounded">
                                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                                <span className="text-[10px] leading-tight">{e.description}</span>
                              </div>
                            ) : (
                              <span className="text-xs text-slate-400">Sin alertas</span>
                            )}
                          </td>
                          <td className="p-3">
                             <span className={`inline-block px-2 py-0.5 text-[10px] font-bold rounded uppercase ${
                              e.status === 'APROBADO' ? 'bg-emerald-100 text-emerald-700' :
                              e.status === 'OBSERVADO' ? 'bg-amber-100 text-amber-700' :
                              e.status === 'RECHAZADO' ? 'bg-red-100 text-red-700' :
                              'bg-slate-100 text-slate-700'
                            }`}>
                              {e.status}
                            </span>
                          </td>
                          <td className="p-3 text-right">
                            {e.status === 'BORRADOR' || e.status === 'EN_REVISION' ? (
                              <div className="flex gap-2 justify-end">
                                <button onClick={() => handleUpdateStatus(e.id, 'APROBADO')} className="text-[10px] bg-emerald-100 text-emerald-700 px-2 py-1 rounded font-bold hover:bg-emerald-200">Aprobar</button>
                                <button onClick={() => {
                                  const c = prompt('Motivo de observación:')
                                  if (c) handleUpdateStatus(e.id, 'OBSERVADO', c)
                                }} className="text-[10px] bg-amber-100 text-amber-700 px-2 py-1 rounded font-bold hover:bg-amber-200">Observar</button>
                              </div>
                            ) : (
                              <button onClick={() => handleUpdateStatus(e.id, 'EN_REVISION')} className="text-[10px] text-blue-600 hover:underline">Revertir</button>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex justify-end gap-3 pt-4 border-t border-slate-200">
              <button type="button" onClick={() => setIsModalOpen(false)} className="px-4 py-2 text-slate-700 hover:bg-slate-100 rounded-lg font-medium">Cerrar</button>
              {selectedDispatch.status !== 'LIQUIDADO' && (
                <button 
                  type="button" 
                  onClick={handleCloseDispatch}
                  className="px-4 py-2 bg-[#002855] text-white rounded-lg font-medium hover:bg-[#003566] flex items-center gap-2"
                >
                  <CheckCircle2 className="w-4 h-4" /> Aprobar y Liquidar Despacho
                </button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
