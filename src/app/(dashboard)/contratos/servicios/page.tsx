"use client"
import { useState, useEffect, useCallback } from 'react'
import { Plus, Receipt, Calendar, FileText, Check, Ban, Loader2, DollarSign, Upload, Download, AlertCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { useDropzone } from 'react-dropzone'
import * as XLSX from 'xlsx'

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
  plate?: string
  driver_name?: string
  hours?: number
  provider_ruc?: string
  provider_name?: string
  category?: string
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
  
  // Bulk upload states
  const [isUploading, setIsUploading] = useState(false)

  const [newService, setNewService] = useState({
    contract_id: '',
    service_type: 'FLETE',
    description: '',
    amount_pen: '',
    service_date: new Date().toISOString().split('T')[0],
    plate: '',
    driver_name: '',
    hours: '',
    isThirdParty: false,
    provider_ruc: '',
    provider_name: '',
    category: 'Contrato'
  })

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    setLoading(true)
    try {
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

    if (newService.service_type === 'MONTACARGA' && !newService.hours) {
      toast.error('La cantidad de horas es obligatoria para Montacargas.')
      return
    }

    setIsSubmitting(true)
    try {
      const { error } = await supabase.rpc('register_contract_service', {
        p_contract_id: newService.contract_id,
        p_service_type: newService.service_type,
        p_description: newService.description,
        p_amount_pen: parseFloat(newService.amount_pen),
        p_service_date: newService.service_date,
        p_plate: newService.service_type === 'FLETE' ? newService.plate : null,
        p_driver_name: newService.service_type === 'FLETE' ? newService.driver_name : null,
        p_hours: newService.service_type === 'MONTACARGA' ? parseFloat(newService.hours) : null,
        p_provider_ruc: newService.isThirdParty ? newService.provider_ruc : null,
        p_provider_name: newService.isThirdParty ? newService.provider_name : null,
        p_category: newService.category
      })

      if (error) throw error

      toast.success('Servicio registrado exitosamente.')
      setIsModalOpen(false)
      resetForm()
      fetchData()
    } catch (error: any) {
      toast.error('Error: ' + error.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const resetForm = () => {
    setNewService({
      contract_id: '',
      service_type: 'FLETE',
      description: '',
      amount_pen: '',
      service_date: new Date().toISOString().split('T')[0],
      plate: '',
      driver_name: '',
      hours: '',
      isThirdParty: false,
      provider_ruc: '',
      provider_name: '',
      category: 'Contrato'
    })
  }

  const downloadTemplate = () => {
    window.location.href = '/api/templates/servicios'
  }

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    const file = acceptedFiles[0]
    if (!file) return

    setIsUploading(true)
    const reader = new FileReader()
    reader.onload = async (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer)
        const workbook = XLSX.read(data, { type: 'array' })
        const sheetName = workbook.SheetNames[0]
        const worksheet = workbook.Sheets[sheetName]
        const json = XLSX.utils.sheet_to_json(worksheet) as any[]

        let successCount = 0
        let errorCount = 0

        for (const row of json) {
          // Find contract by RUC (Client) - simplistic match for bulk upload
          const contract = contracts.find(c => {
             // Basic fallback: in real life we might lookup the client RUC if we joined it
             // Let's assume they provide the exact contract code in RUC_Contrato column for better accuracy 
             // or the client RUC. We will match by contract code first.
             return c.code === String(row.RUC_Contrato || row.Codigo_Contrato || '')
          })

          if (!contract) {
            errorCount++
            continue
          }

          const { error } = await supabase.rpc('register_contract_service', {
            p_contract_id: contract.id,
            p_service_type: row.Tipo_Servicio || 'OTROS',
            p_description: row.Descripcion || '',
            p_amount_pen: parseFloat(row.Monto) || 0,
            p_service_date: row.Fecha_Servicio ? new Date(row.Fecha_Servicio).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
            p_plate: row.Placa || null,
            p_driver_name: row.Conductor || null,
            p_hours: row.Horas ? parseFloat(row.Horas) : null,
            p_provider_ruc: row.Proveedor_RUC ? String(row.Proveedor_RUC) : null,
            p_provider_name: row.Proveedor_Nombre || null,
            p_category: row.Categoria || 'Contrato'
          })

          if (error) {
            errorCount++
          } else {
            successCount++
          }
        }

        toast.success(`Carga completada: ${successCount} exitosos, ${errorCount} errores.`)
        fetchData()
      } catch (err: any) {
        toast.error('Error procesando el archivo: ' + err.message)
      } finally {
        setIsUploading(false)
      }
    }
    reader.readAsArrayBuffer(file)
  }, [contracts])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/vnd.ms-excel': ['.xls']
    },
    multiple: false
  })

  return (
    <div className="space-y-6 w-full mx-auto">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Servicios de Contratos</h1>
          <p className="text-sm text-slate-500">Registro manual y masivo de gastos por servicios que descuentan de la partida del contrato.</p>
        </div>
        <div className="flex gap-3">
          <button 
            onClick={downloadTemplate}
            className="flex items-center gap-2 bg-white text-slate-700 border border-slate-300 px-4 py-2 rounded-lg font-medium hover:bg-slate-50 transition-colors shadow-sm"
          >
            <Download className="w-4 h-4" />
            Plantilla Excel
          </button>
          <button 
            onClick={() => setIsModalOpen(true)}
            className="flex items-center gap-2 bg-[#002855] text-white px-4 py-2 rounded-lg font-medium hover:bg-[#001d3d] transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" />
            Registrar Servicio
          </button>
        </div>
      </div>

      {/* Carga Masiva Dropzone */}
      <div 
        {...getRootProps()} 
        className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
          isDragActive ? 'border-[#002855] bg-blue-50' : 'border-slate-300 bg-white hover:bg-slate-50'
        }`}
      >
        <input {...getInputProps()} />
        {isUploading ? (
          <div className="flex flex-col items-center justify-center text-[#002855]">
            <Loader2 className="w-8 h-8 animate-spin mb-3" />
            <p className="font-semibold text-lg">Procesando archivo...</p>
            <p className="text-sm opacity-80 mt-1">Por favor espere mientras se registran los servicios.</p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center text-slate-500">
            <Upload className={`w-10 h-10 mb-4 ${isDragActive ? 'text-[#002855]' : 'text-slate-400'}`} />
            <p className="font-semibold text-lg text-slate-700 mb-1">
              {isDragActive ? 'Suelta el archivo aquí...' : 'Carga Masiva de Servicios'}
            </p>
            <p className="text-sm mb-4">
              Arrastra y suelta tu plantilla Excel aquí, o haz clic para seleccionar el archivo
            </p>
            <span className="text-xs font-semibold bg-slate-100 text-slate-600 px-3 py-1 rounded-full border border-slate-200">
              Soporta .XLSX, .XLS
            </span>
            <div className="mt-4 flex items-center gap-2 text-xs text-amber-600 bg-amber-50 px-3 py-2 rounded-lg border border-amber-200">
              <AlertCircle className="w-4 h-4" />
              <span>Asegúrate de usar el "Código de Contrato" en la columna RUC_Contrato para asegurar el emparejamiento.</span>
            </div>
          </div>
        )}
      </div>

      {/* Lista de Servicios */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider border-b">
              <tr>
                <th className="p-4 font-semibold">Fecha</th>
                <th className="p-4 font-semibold">Contrato / Cliente</th>
                <th className="p-4 font-semibold">Servicio</th>
                <th className="p-4 font-semibold">Detalles</th>
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
                      <div className="flex flex-col gap-1">
                        <span className="px-2 py-1 bg-slate-100 text-slate-700 rounded text-xs font-semibold w-fit">
                          {srv.service_type}
                        </span>
                        {srv.category && (
                          <span className={`px-2 py-1 rounded text-[10px] font-bold w-fit ${
                            srv.category === 'Error' ? 'bg-red-100 text-red-700' :
                            srv.category === 'Subcontrato' ? 'bg-amber-100 text-amber-700' :
                            'bg-blue-100 text-blue-700'
                          }`}>
                            {srv.category}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="p-4 text-xs text-slate-600">
                      <div className="flex flex-col gap-0.5">
                        <span className="text-slate-800">{srv.description || '-'}</span>
                        {srv.plate && <span>Placa: <span className="font-medium">{srv.plate}</span></span>}
                        {srv.driver_name && <span>Cond: <span className="font-medium">{srv.driver_name}</span></span>}
                        {srv.hours && <span>Horas: <span className="font-medium">{srv.hours}h</span></span>}
                        {srv.provider_name && <span>Prov: <span className="font-medium text-amber-700">{srv.provider_name}</span></span>}
                      </div>
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
        onClose={() => {setIsModalOpen(false); resetForm();}}
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
                <label className="block text-sm font-medium text-slate-700 mb-1">Categoría</label>
                <select
                  required
                  className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                  value={newService.category}
                  onChange={(e) => setNewService({...newService, category: e.target.value})}
                >
                  <option value="Contrato">Contrato Principal</option>
                  <option value="Subcontrato">Subcontrato</option>
                  <option value="Error">Error Operativo</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Tipo de Servicio</label>
                <select
                  required
                  className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                  value={newService.service_type}
                  onChange={(e) => setNewService({...newService, service_type: e.target.value})}
                >
                  <option value="FLETE">Flete</option>
                  <option value="MONTACARGA">Montacarga</option>
                  <option value="ESTIBA">Estiba</option>
                  <option value="MANIOBRA">Maniobra</option>
                  <option value="PEAJE">Peaje</option>
                  <option value="PENALIDAD">Penalidad</option>
                  <option value="ERROR">Error Operativo</option>
                  <option value="OTROS">Otros</option>
                </select>
              </div>
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

            {/* Dynamic Fields */}
            {newService.service_type === 'FLETE' && (
              <div className="grid grid-cols-2 gap-4 bg-slate-50 p-3 rounded-lg border border-slate-100">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Placa</label>
                  <input 
                    type="text"
                    placeholder="Ej. ABC-123"
                    className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                    value={newService.plate}
                    onChange={(e) => setNewService({...newService, plate: e.target.value})}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Conductor</label>
                  <input 
                    type="text"
                    placeholder="Nombre completo"
                    className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                    value={newService.driver_name}
                    onChange={(e) => setNewService({...newService, driver_name: e.target.value})}
                  />
                </div>
              </div>
            )}

            {newService.service_type === 'MONTACARGA' && (
              <div className="bg-slate-50 p-3 rounded-lg border border-slate-100">
                <label className="block text-sm font-medium text-slate-700 mb-1">Cantidad de Horas (Obligatorio)</label>
                <input 
                  type="number"
                  step="0.5"
                  min="0.5"
                  placeholder="Ej. 4"
                  required={newService.service_type === 'MONTACARGA'}
                  className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                  value={newService.hours}
                  onChange={(e) => setNewService({...newService, hours: e.target.value})}
                />
              </div>
            )}

            {/* Third Party Checkbox */}
            <div className="flex items-center gap-2 mt-2">
              <input 
                type="checkbox" 
                id="isThirdParty"
                className="w-4 h-4 text-[#002855] border-slate-300 rounded focus:ring-[#002855]"
                checked={newService.isThirdParty}
                onChange={(e) => setNewService({...newService, isThirdParty: e.target.checked})}
              />
              <label htmlFor="isThirdParty" className="text-sm font-medium text-slate-700 cursor-pointer">
                El servicio fue realizado por un tercero (Proveedor)
              </label>
            </div>

            {newService.isThirdParty && (
              <div className="grid grid-cols-3 gap-4 bg-amber-50/50 p-3 rounded-lg border border-amber-100">
                <div className="col-span-1">
                  <label className="block text-sm font-medium text-slate-700 mb-1">RUC Proveedor</label>
                  <input 
                    type="text"
                    placeholder="20..."
                    maxLength={11}
                    className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                    value={newService.provider_ruc}
                    onChange={(e) => setNewService({...newService, provider_ruc: e.target.value})}
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1">Razón Social</label>
                  <input 
                    type="text"
                    placeholder="Nombre del proveedor"
                    className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                    value={newService.provider_name}
                    onChange={(e) => setNewService({...newService, provider_name: e.target.value})}
                  />
                </div>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Monto Total (PEN) (Obligatorio)</label>
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
                rows={2}
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
              onClick={() => {setIsModalOpen(false); resetForm();}}
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
