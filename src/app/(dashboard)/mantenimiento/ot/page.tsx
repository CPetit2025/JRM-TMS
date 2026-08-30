"use client"
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Wrench, Plus, Search, Calendar, CheckCircle2, FileText, AlertCircle, DollarSign, Upload, Wand2, FileImage } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { toast } from 'sonner'

export default function MaintenanceWorkOrdersPage() {
  const supabase = createClient()
  const [ots, setOts] = useState<any[]>([])
  const [vehicles, setVehicles] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isCloseModalOpen, setIsCloseModalOpen] = useState(false)
  const [isDetailsModalOpen, setIsDetailsModalOpen] = useState(false)
  const [selectedOt, setSelectedOt] = useState<any>(null)
  const [otDetails, setOtDetails] = useState<any>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [costFile, setCostFile] = useState<File | null>(null)
  const [isExtracting, setIsExtracting] = useState(false)

  const [form, setForm] = useState({
    vehicle_id: '',
    source_type: 'MANUAL',
    priority: 'NORMAL',
    description: '',
    workshop_name: '',
    estimated_end_date: ''
  })

  const [closeForm, setCloseForm] = useState({
    activities_performed: '',
    diagnostic: '',
    cost_amount: '',
    cost_description: 'Servicio de mantenimiento'
  })

  const [newCostForm, setNewCostForm] = useState({
    cost_type: 'REPUESTOS',
    amount: '',
    description: '',
    supplier_name: '',
    supplier_ruc: '',
    document_type: 'FACTURA',
    document_number: '',
    evidence_url: ''
  })

  useEffect(() => {
    fetchOts()
    fetchVehicles()
  }, [])

  const fetchVehicles = async () => {
    const { data } = await supabase.from('vehicles').select('id, plate').order('plate')
    setVehicles(data || [])
  }

  const fetchOts = async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('maintenance_work_orders')
        .select(`*, vehicles(plate), work_order_costs(amount)`)
        .order('created_at', { ascending: false })
      
      if (error) throw error
      setOts(data || [])
    } catch (err: any) {
      toast.error('Error al cargar OTs: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    try {
      const otCode = `MOT-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`
      
      const { error } = await supabase.from('maintenance_work_orders').insert([{
        ot_code: otCode,
        vehicle_id: form.vehicle_id,
        source_type: form.source_type,
        priority: form.priority,
        description: form.description,
        workshop_name: form.workshop_name,
        estimated_end_date: form.estimated_end_date || null,
        start_date: new Date().toISOString().split('T')[0],
        status: 'EN_PROCESO'
      }])

      if (error) throw error
      toast.success('Orden de Trabajo creada')
      setIsModalOpen(false)
      fetchOts()
    } catch (err: any) {
      toast.error('Error al crear OT: ' + err.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const openCloseModal = (ot: any) => {
    setSelectedOt(ot)
    setCloseForm({ activities_performed: '', diagnostic: '', cost_amount: '', cost_description: 'Servicio de mantenimiento' })
    setIsCloseModalOpen(true)
  }

  const openDetailsModal = async (ot: any) => {
    setOtDetails(ot)
    setIsDetailsModalOpen(true)
    fetchOtDetails(ot.id)
  }
  
  const fetchOtDetails = async (id: string) => {
    try {
      const { data, error } = await supabase
        .from('maintenance_work_orders')
        .select(`*, vehicles(plate), work_order_costs(*)`)
        .eq('id', id)
        .single()
      if (data) setOtDetails(data)
    } catch (e) {
      console.error(e)
    }
  }

  const handleFileUpload = async (file: File) => {
    try {
      const fileExt = file.name.split('.').pop()
      const fileName = `${Math.random().toString(36).substring(7)}.${fileExt}`
      const filePath = `${fileName}`
      
      const { error: uploadError } = await supabase.storage.from('evidence').upload(filePath, file)
      if (uploadError) {
        console.error('Upload Error:', uploadError)
        return null
      }
      
      const { data } = supabase.storage.from('evidence').getPublicUrl(filePath)
      return data.publicUrl
    } catch (error) {
      console.error('Error uploading file:', error)
      return null
    }
  }

  const handleAIExtraction = async (e: React.MouseEvent) => {
    e.preventDefault()
    if (!costFile) {
      toast.error('Por favor, selecciona una foto del comprobante primero.')
      return
    }
    
    setIsExtracting(true)
    const formData = new FormData()
    formData.append('file', costFile)
    
    // Leer config para las llaves de IA
    const savedConfig = localStorage.getItem('jrm_sys_config')
    let headers: any = {}
    if (savedConfig) {
      const configObj = JSON.parse(savedConfig)
      headers['x-ai-provider'] = configObj.aiProvider || 'openai'
      headers['x-ai-key'] = configObj.aiProvider === 'gemini' ? configObj.geminiKey : configObj.openAiKey
    }
    
    try {
      const res = await fetch('/api/extract-invoice', {
        method: 'POST',
        body: formData,
        headers
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Error en la extracción IA')
      }
      
      const data = await res.json()
      setNewCostForm(prev => ({
        ...prev,
        amount: data.amount ? String(data.amount) : prev.amount,
        description: data.description || prev.description,
        supplier_name: data.supplier_name || prev.supplier_name,
        supplier_ruc: data.supplier_ruc || prev.supplier_ruc,
        document_type: data.document_type || prev.document_type,
        document_number: data.document_number || prev.document_number,
      }))
      toast.success('Datos extraídos exitosamente ✨')
    } catch (error: any) {
      toast.error(error.message)
    } finally {
      setIsExtracting(false)
    }
  }

  const handleAddCost = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    try {
      let evidenceUrl = null
      if (costFile) {
        evidenceUrl = await handleFileUpload(costFile)
      }

      await supabase.from('work_order_costs').insert([{
        work_order_id: otDetails.id,
        cost_type: newCostForm.cost_type,
        amount: parseFloat(newCostForm.amount),
        description: newCostForm.description,
        supplier_name: newCostForm.supplier_name,
        supplier_ruc: newCostForm.supplier_ruc,
        document_type: newCostForm.document_type,
        document_number: newCostForm.document_number,
        evidence_url: evidenceUrl
      }])
      toast.success('Costo agregado')
      setNewCostForm({ cost_type: 'REPUESTOS', amount: '', description: '', supplier_name: '', supplier_ruc: '', document_type: 'FACTURA', document_number: '', evidence_url: '' })
      setCostFile(null)
      fetchOtDetails(otDetails.id)
      fetchOts()
    } catch (err: any) {
      toast.error('Error al agregar costo: ' + err.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCloseOT = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    try {
      // 1. Cerrar OT
      await supabase.from('maintenance_work_orders').update({
        status: 'FINALIZADA',
        actual_end_date: new Date().toISOString().split('T')[0],
        diagnostic: closeForm.diagnostic,
        activities_performed: closeForm.activities_performed
      }).eq('id', selectedOt.id)

      const costNum = parseFloat(closeForm.cost_amount)

      // 2. Insertar Costos
      if (costNum > 0) {
        await supabase.from('work_order_costs').insert([{
          work_order_id: selectedOt.id,
          cost_type: 'SERVICIO_EXTERNO',
          amount: costNum,
          description: closeForm.cost_description
        }])
      }

      // 3. Actualizar Historial del Vehículo y liberarlo
      const { data: vData } = await supabase.from('vehicles').select('id, current_mileage, accumulated_cost').eq('id', selectedOt.vehicle_id).single()
      
      if (vData) {
        const newCost = (vData.accumulated_cost || 0) + (costNum || 0)
        await supabase.from('vehicles').update({
          status: 'DISPONIBLE', // Liberar unidad
          maintenance_status: 'AL_DIA', // Resetear alertas
          last_maintenance_date: new Date().toISOString().split('T')[0],
          last_maintenance_mileage: vData.current_mileage,
          accumulated_cost: newCost
        }).eq('id', vData.id)

        // Registrar trazabilidad
        await supabase.from('vehicle_maintenance_history').insert([{
          vehicle_id: vData.id,
          action_type: 'OT_FINALIZADA',
          description: `OT ${selectedOt.ot_code} finalizada. Costo: S/ ${costNum || 0}`,
          mileage_at_time: vData.current_mileage
        }])
      }

      toast.success('Orden de Trabajo finalizada y Unidad liberada.')
      setIsCloseModalOpen(false)
      fetchOts()
    } catch (err: any) {
      toast.error('Error al cerrar OT: ' + err.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const getStatusBadge = (status: string) => {
    switch(status) {
      case 'PENDIENTE': return <span className="bg-slate-100 text-slate-700 px-2 py-1 rounded text-xs font-bold">Pendiente</span>
      case 'EN_PROCESO': return <span className="bg-blue-100 text-blue-700 px-2 py-1 rounded text-xs font-bold">En Proceso</span>
      case 'FINALIZADA': return <span className="bg-green-100 text-green-700 px-2 py-1 rounded text-xs font-bold">Finalizada</span>
      case 'CANCELADA': return <span className="bg-red-100 text-red-700 px-2 py-1 rounded text-xs font-bold">Cancelada</span>
      default: return <span>{status}</span>
    }
  }

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Órdenes de Trabajo (OT)</h1>
          <p className="text-sm text-slate-500">Gestión de mantenimientos en taller y reparaciones</p>
        </div>
        <button 
          onClick={() => setIsModalOpen(true)}
          className="bg-[#002855] text-white px-4 py-2 rounded-lg font-medium hover:bg-[#003566] transition-colors flex items-center gap-2 shadow-sm"
        >
          <Plus className="w-5 h-5" /> Nueva OT
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        {loading ? (
          <div className="p-8 text-center text-slate-500">Cargando OTs...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-600">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="p-4 font-semibold text-slate-900">Código OT</th>
                  <th className="p-4 font-semibold text-slate-900">Unidad</th>
                  <th className="p-4 font-semibold text-slate-900">Descripción</th>
                  <th className="p-4 font-semibold text-slate-900">Taller</th>
                  <th className="p-4 font-semibold text-slate-900">Fechas</th>
                  <th className="p-4 font-semibold text-slate-900">Costo (S/)</th>
                  <th className="p-4 font-semibold text-slate-900">Estado</th>
                  <th className="p-4 font-semibold text-slate-900 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {ots.map((ot) => {
                  const totalCost = ot.work_order_costs?.reduce((sum: number, c: any) => sum + Number(c.amount), 0) || 0
                  return (
                    <tr key={ot.id} className="hover:bg-slate-50">
                      <td className="p-4">
                        <button onClick={() => openDetailsModal(ot)} className="font-bold text-[#002855] hover:underline flex items-center gap-1">
                          {ot.ot_code}
                        </button>
                      </td>
                      <td className="p-4 font-semibold text-slate-900">{ot.vehicles?.plate || 'S/N'}</td>
                      <td className="p-4 max-w-xs truncate" title={ot.description}>{ot.description}</td>
                      <td className="p-4">{ot.workshop_name || 'Interno'}</td>
                      <td className="p-4 text-xs">
                        <div className="text-slate-500">Inicio: {ot.start_date ? new Date(ot.start_date).toLocaleDateString() : 'N/A'}</div>
                        <div className="text-slate-500">Fin: {ot.actual_end_date ? new Date(ot.actual_end_date).toLocaleDateString() : 'Pendiente'}</div>
                      </td>
                      <td className="p-4 font-medium text-slate-700">{totalCost > 0 ? totalCost.toFixed(2) : '-'}</td>
                      <td className="p-4">{getStatusBadge(ot.status)}</td>
                      <td className="p-4 text-right">
                        {ot.status !== 'FINALIZADA' && (
                          <button 
                            onClick={() => openCloseModal(ot)}
                            className="px-3 py-1.5 text-green-600 bg-green-50 hover:bg-green-100 rounded-lg text-xs font-semibold flex items-center gap-1 ml-auto"
                          >
                            <CheckCircle2 className="w-4 h-4" /> Finalizar OT
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal Nueva OT */}
      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title="Crear Orden de Trabajo">
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Unidad</label>
              <select required value={form.vehicle_id} onChange={e => setForm({...form, vehicle_id: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg text-slate-900">
                <option value="">Seleccione...</option>
                {vehicles.map(v => <option key={v.id} value={v.id}>{v.plate}</option>)}
              </select>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Origen</label>
              <select value={form.source_type} onChange={e => setForm({...form, source_type: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg text-slate-900">
                <option value="PREVENTIVO">Mantenimiento Preventivo</option>
                <option value="FALLA">Reporte de Falla</option>
                <option value="MANUAL">Manual / Correctivo</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Prioridad</label>
              <select value={form.priority} onChange={e => setForm({...form, priority: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg text-slate-900">
                <option value="NORMAL">Normal</option>
                <option value="ALTA">Alta (Urgente)</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Taller / Proveedor</label>
              <input type="text" value={form.workshop_name} onChange={e => setForm({...form, workshop_name: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400" placeholder="Nombre del taller (opcional)" />
            </div>

            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Descripción del Trabajo a Realizar</label>
              <textarea required value={form.description} onChange={e => setForm({...form, description: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg h-24 text-slate-900" />
            </div>
          </div>
          
          <div className="flex justify-end gap-3 pt-4 border-t border-slate-200">
            <button type="button" onClick={() => setIsModalOpen(false)} className="px-4 py-2 text-slate-700 hover:bg-slate-100 rounded-lg font-medium">Cancelar</button>
            <button type="submit" disabled={isSubmitting} className="px-4 py-2 bg-[#002855] text-white rounded-lg font-medium hover:bg-[#003566]">
              {isSubmitting ? 'Creando...' : 'Crear OT'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Modal Cerrar OT */}
      <Modal isOpen={isCloseModalOpen} onClose={() => setIsCloseModalOpen(false)} title={`Finalizar OT - ${selectedOt?.ot_code}`}>
        <form onSubmit={handleCloseOT} className="space-y-4">
          <div className="bg-blue-50 p-3 rounded-lg flex items-start gap-3 border border-blue-100 mb-4">
            <AlertCircle className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
            <p className="text-sm text-blue-800">Al cerrar esta OT, la unidad pasará automáticamente a estado <strong>DISPONIBLE</strong> y se actualizará su fecha/kilometraje de último mantenimiento.</p>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Diagnóstico Final</label>
              <textarea required value={closeForm.diagnostic} onChange={e => setCloseForm({...closeForm, diagnostic: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg h-20 text-slate-900 placeholder:text-slate-400" placeholder="¿Qué se encontró?" />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Actividades Realizadas</label>
              <textarea required value={closeForm.activities_performed} onChange={e => setCloseForm({...closeForm, activities_performed: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg h-20" placeholder="Detalle del trabajo..." />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Costo Total (S/)</label>
                <div className="relative">
                  <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input type="number" step="0.01" min="0" required value={closeForm.cost_amount} onChange={e => setCloseForm({...closeForm, cost_amount: e.target.value})} className="w-full pl-9 p-2 border border-slate-300 rounded-lg" placeholder="0.00" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Concepto de Costo</label>
                <input type="text" value={closeForm.cost_description} onChange={e => setCloseForm({...closeForm, cost_description: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg" />
              </div>
            </div>
          </div>
          
          <div className="flex justify-end gap-3 pt-4 border-t border-slate-200">
            <button type="button" onClick={() => setIsCloseModalOpen(false)} className="px-4 py-2 text-slate-700 hover:bg-slate-100 rounded-lg font-medium">Cancelar</button>
            <button type="submit" disabled={isSubmitting} className="px-4 py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700">
              {isSubmitting ? 'Finalizando...' : 'Liquidar y Liberar Unidad'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Modal Detalles y Costos OT */}
      <Modal isOpen={isDetailsModalOpen} onClose={() => setIsDetailsModalOpen(false)} title={`Detalle OT - ${otDetails?.ot_code}`} maxWidth="max-w-2xl">
        {otDetails && (
          <div className="space-y-6">
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-slate-500 block text-xs">Unidad</span>
                  <span className="font-bold text-[#002855]">{otDetails.vehicles?.plate}</span>
                </div>
                <div>
                  <span className="text-slate-500 block text-xs">Estado</span>
                  <div className="mt-1">{getStatusBadge(otDetails.status)}</div>
                </div>
                <div className="col-span-2">
                  <span className="text-slate-500 block text-xs">Descripción del Trabajo</span>
                  <p className="mt-1 font-medium text-slate-900">{otDetails.description}</p>
                </div>
              </div>
            </div>

            <div>
              <h4 className="font-bold text-slate-800 mb-3 flex items-center gap-2 border-b border-slate-200 pb-2">
                <DollarSign className="w-4 h-4 text-[#002855]" /> Costos Asociados
              </h4>
              
              {otDetails.work_order_costs && otDetails.work_order_costs.length > 0 ? (
                <div className="space-y-2 mb-4">
                  {otDetails.work_order_costs.map((cost: any) => (
                    <div key={cost.id} className="flex justify-between items-center p-3 bg-white border border-slate-200 rounded-lg text-sm">
                      <div>
                        <p className="font-bold text-slate-700">{cost.cost_type}</p>
                        <p className="text-xs text-slate-500">{cost.description}</p>
                        {cost.supplier_name && <p className="text-xs text-slate-400 mt-1">Proveedor: {cost.supplier_name} {cost.supplier_ruc ? `(${cost.supplier_ruc})` : ''}</p>}
                        {cost.document_number && <p className="text-xs text-slate-400">{cost.document_type || 'Doc.'} N°: {cost.document_number}</p>}
                      </div>
                      <div className="text-right flex flex-col items-end gap-1">
                        <span className="font-black text-[#002855]">S/ {Number(cost.amount).toFixed(2)}</span>
                        {cost.evidence_url && (
                          <a href={cost.evidence_url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline flex items-center gap-1 bg-blue-50 px-2 py-1 rounded">
                            <FileImage className="w-3 h-3" /> Ver Evidencia
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                  <div className="flex justify-between items-center p-3 bg-slate-100 rounded-lg text-sm mt-2">
                    <span className="font-bold text-slate-700">Total</span>
                    <span className="font-black text-[#002855] text-base">
                      S/ {otDetails.work_order_costs.reduce((sum: number, c: any) => sum + Number(c.amount), 0).toFixed(2)}
                    </span>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-slate-500 mb-4 italic">No hay costos registrados aún.</p>
              )}

              {otDetails.status !== 'FINALIZADA' && otDetails.status !== 'CANCELADA' && (
                <form onSubmit={handleAddCost} className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm mt-4">
                  <h5 className="font-bold text-slate-800 text-sm mb-3">Agregar Nuevo Costo</h5>
                  
                  {/* Carga de Archivo e IA */}
                  <div className="mb-4 bg-slate-50 p-3 rounded-lg border border-slate-200 flex flex-col gap-3">
                    <label className="block text-xs font-semibold text-slate-700">Evidencia Documentaria (Foto de Factura/Boleta)</label>
                    <div className="flex gap-2 items-center">
                      <input 
                        type="file" 
                        accept="image/*,.pdf"
                        onChange={e => setCostFile(e.target.files ? e.target.files[0] : null)}
                        className="text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 flex-1"
                      />
                      <button 
                        type="button" 
                        onClick={handleAIExtraction}
                        disabled={isExtracting || !costFile}
                        className="bg-purple-600 text-white px-3 py-2 rounded-lg text-xs font-bold hover:bg-purple-700 disabled:opacity-50 flex items-center gap-1 shadow-sm transition-all"
                      >
                        {isExtracting ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div> : <Wand2 className="w-4 h-4" />}
                        {isExtracting ? 'Procesando...' : 'Escanear con IA'}
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Tipo de Costo</label>
                      <select required value={newCostForm.cost_type} onChange={e => setNewCostForm({...newCostForm, cost_type: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg text-sm text-slate-900">
                        <option value="REPUESTOS">Repuestos</option>
                        <option value="MANO_DE_OBRA">Mano de Obra</option>
                        <option value="SERVICIO_EXTERNO">Servicio Externo</option>
                        <option value="OTROS">Otros</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Monto Total (S/)</label>
                      <input type="number" required min="0.01" step="0.01" value={newCostForm.amount} onChange={e => setNewCostForm({...newCostForm, amount: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg text-sm text-slate-900 font-semibold" placeholder="0.00" />
                    </div>

                    {/* Nuevos campos: Proveedor y Documento */}
                    <div className="col-span-2">
                      <label className="block text-xs font-medium text-slate-700 mb-1">Nombre / Razón Social del Proveedor</label>
                      <input type="text" value={newCostForm.supplier_name} onChange={e => setNewCostForm({...newCostForm, supplier_name: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg text-sm text-slate-900" placeholder="Ej. Repuestos El Motor SAC" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">RUC del Proveedor</label>
                      <input type="text" value={newCostForm.supplier_ruc} onChange={e => setNewCostForm({...newCostForm, supplier_ruc: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg text-sm text-slate-900" placeholder="Ej. 20123456789" />
                    </div>
                    <div className="flex gap-2">
                      <div className="w-1/3">
                        <label className="block text-xs font-medium text-slate-700 mb-1">Doc.</label>
                        <select value={newCostForm.document_type} onChange={e => setNewCostForm({...newCostForm, document_type: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg text-sm text-slate-900">
                          <option value="FACTURA">Factura</option>
                          <option value="BOLETA">Boleta</option>
                          <option value="RECIBO">Recibo</option>
                          <option value="OTRO">Otro</option>
                        </select>
                      </div>
                      <div className="w-2/3">
                        <label className="block text-xs font-medium text-slate-700 mb-1">N° Documento</label>
                        <input type="text" value={newCostForm.document_number} onChange={e => setNewCostForm({...newCostForm, document_number: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg text-sm text-slate-900" placeholder="Ej. F001-00045" />
                      </div>
                    </div>

                    <div className="col-span-2">
                      <label className="block text-xs font-medium text-slate-700 mb-1">Descripción del Ítem / Servicio</label>
                      <input type="text" required value={newCostForm.description} onChange={e => setNewCostForm({...newCostForm, description: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg text-sm text-slate-900" placeholder="Ej. Cambio de filtro de aceite" />
                    </div>
                  </div>
                  <button type="submit" disabled={isSubmitting} className="w-full bg-[#002855] text-white py-2 rounded-lg font-bold text-sm hover:bg-[#001f44] flex items-center justify-center gap-2 mt-4 transition-colors">
                    <Plus className="w-4 h-4" /> Agregar y Guardar Costo
                  </button>
                </form>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
