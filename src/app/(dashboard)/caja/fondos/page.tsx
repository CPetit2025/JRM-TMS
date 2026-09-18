"use client"
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { 
  Search, Plus, Wallet, FileText, Activity, 
  MapPin, CheckCircle, ArrowRight, User
} from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { toast } from 'sonner'
import { usePermissions } from '@/hooks/usePermissions'

export default function FondosPage() {
  const supabase = createClient()
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getUser().then(res => {
      setUser(res.data.user)
    })
  }, [])
  const [funds, setFunds] = useState<any[]>([])
  const [users, setUsers] = useState<any[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  
  // Modal
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [form, setForm] = useState({
    received_by: '',
    amount: '',
    currency: 'PEN',
    reason: '',
    status: 'ENTREGADO'
  })

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    setLoading(true)
    try {
      // Fetch funds
      const { data: fData, error: fError } = await supabase
        .from('cash_funds')
        .select(`
          *,
          received_by_profile:profiles!cash_funds_received_by_fkey(first_name, last_name)
        `)
        .order('created_at', { ascending: false })
      
      if (fError) throw fError
      setFunds(fData || [])

      // Fetch possible receivers
      const { data: uData, error: uError } = await supabase
        .from('profiles')
        .select('id, first_name, last_name')
        .order('first_name')
      
      if (uError) throw uError
      setUsers(uData || [])

    } catch (err: any) {
      toast.error('Error al cargar fondos: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    
    try {
      const payload = {
        received_by: form.received_by,
        given_by: user?.id,
        amount: parseFloat(form.amount),
        currency: form.currency,
        reason: form.reason,
        status: form.status
      }

      const { error } = await supabase.from('cash_funds').insert([payload])
      if (error) throw error
      
      toast.success('Fondo registrado exitosamente')
      setIsModalOpen(false)
      fetchData()
    } catch (err: any) {
      toast.error('Error al guardar: ' + err.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const formatMoney = (amount: number, curr: string = 'PEN') => {
    return new Intl.NumberFormat('es-PE', { style: 'currency', currency: curr }).format(amount)
  }

  const filtered = funds.filter(f => 
    f.code?.toLowerCase().includes(searchTerm.toLowerCase()) || 
    f.received_by_profile?.first_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    f.received_by_profile?.last_name?.toLowerCase().includes(searchTerm.toLowerCase())
  )

  return (
    <div className="space-y-6 w-full mx-auto">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <h2 className="text-xl font-bold text-slate-800">Fondos de Caja Chica</h2>
          <p className="text-sm text-slate-500">Dinero asignado por Finanzas para la gestión del área</p>
        </div>
        <button 
          onClick={() => setIsModalOpen(true)}
          className="bg-[#002855] text-white px-4 py-2.5 rounded-xl font-bold hover:bg-[#003566] transition-colors flex items-center justify-center gap-2"
        >
          <Plus className="w-5 h-5" /> Registrar Ingreso de Fondo
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        <div className="p-4 border-b border-slate-200 flex gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input 
              type="text" 
              placeholder="Buscar por código o responsable..." 
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
                  <th className="p-4 font-semibold text-slate-900">Código / Fecha</th>
                  <th className="p-4 font-semibold text-slate-900">Responsable (Recibe)</th>
                  <th className="p-4 font-semibold text-slate-900">Motivo</th>
                  <th className="p-4 font-semibold text-slate-900 text-right text-right">Monto Entregado</th>
                  <th className="p-4 font-semibold text-slate-900 text-center">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.length === 0 ? (
                  <tr><td colSpan={5} className="p-8 text-center text-slate-500">No hay fondos registrados</td></tr>
                ) : (
                  filtered.map(f => (
                    <tr key={f.id} className="hover:bg-slate-50 transition-colors">
                      <td className="p-4">
                        <div className="font-bold text-[#002855]">{f.code || 'Borrador'}</div>
                        <div className="text-xs text-slate-400 mt-0.5">{new Date(f.date).toLocaleDateString()}</div>
                      </td>
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center border border-slate-200">
                            <User className="w-4 h-4 text-slate-500" />
                          </div>
                          <div>
                            <p className="font-medium text-slate-800">
                              {f.received_by_profile?.first_name} {f.received_by_profile?.last_name}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="p-4">
                        <span className="text-slate-600">{f.reason || '-'}</span>
                      </td>
                      <td className="p-4 text-right">
                        <div className="font-black text-lg text-slate-800">{formatMoney(f.amount, f.currency)}</div>
                      </td>
                      <td className="p-4 text-center">
                        <span className={`inline-block px-3 py-1 text-xs font-bold rounded-full ${
                          f.status === 'ENTREGADO' ? 'bg-blue-100 text-blue-700' :
                          f.status === 'LIQUIDADO' ? 'bg-emerald-100 text-emerald-700' :
                          f.status === 'PENDIENTE_LIQUIDACION' ? 'bg-amber-100 text-amber-700' :
                          'bg-slate-100 text-slate-700'
                        }`}>
                          {f.status}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title="Registrar Ingreso de Caja Chica" maxWidth="max-w-xl">
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Responsable del Fondo *</label>
            <select required value={form.received_by} onChange={e => setForm({...form, received_by: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg bg-white">
              <option value="">Seleccionar responsable de nuestra área...</option>
              {users.map(u => (
                <option key={u.id} value={u.id}>{u.first_name} {u.last_name}</option>
              ))}
            </select>
          </div>
          
          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Monto *</label>
              <input type="number" step="0.01" required value={form.amount} onChange={e => setForm({...form, amount: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg text-lg font-bold" placeholder="0.00" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Moneda</label>
              <select value={form.currency} onChange={e => setForm({...form, currency: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg bg-slate-50">
                <option value="PEN">PEN (S/)</option>
                <option value="USD">USD ($)</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Motivo / Descripción *</label>
            <textarea required value={form.reason} onChange={e => setForm({...form, reason: e.target.value})} rows={3} className="w-full p-2 border border-slate-300 rounded-lg" placeholder="Ej. Anticipo para viaje Ruta Sur (Peajes y Combustible)..." />
          </div>

          <div className="bg-amber-50 border border-amber-200 p-4 rounded-xl flex items-start gap-3 mt-4">
            <Activity className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-bold text-amber-900 text-sm">Control de Caja Chica</p>
              <p className="text-xs text-amber-800 mt-1">
                Este registro indica el monto recibido por el área de Finanzas. Todos los gastos que se registren en el módulo de Gastos se descontarán de este saldo para la futura liquidación.
              </p>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-200 mt-6">
            <button type="button" onClick={() => setIsModalOpen(false)} className="px-4 py-2 text-slate-700 hover:bg-slate-100 rounded-lg font-medium">Cancelar</button>
            <button type="submit" disabled={isSubmitting} className="px-4 py-2 bg-[#002855] text-white rounded-lg font-medium hover:bg-[#003566]">
              {isSubmitting ? 'Procesando...' : 'Registrar Fondo'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
