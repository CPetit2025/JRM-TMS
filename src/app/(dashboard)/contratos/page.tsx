"use client"
import { useState, useEffect, useRef } from 'react'
import { Plus, Search, Layers, FileWarning, Briefcase, FilePlus2, CheckCircle2, Upload, Download } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import * as XLSX from 'xlsx'

interface Contract {
  id: string
  code: string
  type: 'CONTRATO' | 'SUBCONTRATO' | 'ERROR' | 'OT_INDEPENDIENTE'
  client_id: string
  parent_contract_id?: string | null
  status: string
  created_at: string
  total_weight_kg?: number
  total_volume_m3?: number
  destination_department?: string
  destination_province?: string
  destination_district?: string
  destination_address?: string
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
  
  // Bulk upload
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isUploading, setIsUploading] = useState(false)

  const [newContract, setNewContract] = useState({
    correlative: '',
    type: 'CONTRATO',
    client_id: '',
    parent_contract_id: '',
    budget_pen: '',
    total_weight_kg: '',
    total_volume_m3: '',
    destination_department: '',
    destination_province: '',
    destination_district: '',
    destination_address: ''
  })

  useEffect(() => {
    fetchContracts()
  }, [])

  const fetchContracts = async () => {
    setLoading(true)
    try {
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
      let finalCode = newContract.correlative.trim()
      
      // Si es Subcontrato o Error, prefijamos con el código del contrato madre
      if (newContract.type === 'SUBCONTRATO' || newContract.type === 'ERROR') {
        if (!newContract.parent_contract_id) {
          throw new Error('Debe seleccionar un Contrato Madre')
        }
        const parentContract = contracts.find(c => c.id === newContract.parent_contract_id)
        if (parentContract) {
          finalCode = `${parentContract.code}-${finalCode}`
        }
      }

      const { data: contractData, error: contractError } = await supabase
        .from('contracts')
        .insert([{
          code: finalCode,
          type: newContract.type,
          parent_contract_id: newContract.parent_contract_id || null,
          client_id: newContract.client_id || null,
          status: 'ACTIVO',
          total_weight_kg: newContract.total_weight_kg ? Number(newContract.total_weight_kg) : 0,
          total_volume_m3: newContract.total_volume_m3 ? Number(newContract.total_volume_m3) : 0,
          destination_department: newContract.destination_department,
          destination_province: newContract.destination_province,
          destination_district: newContract.destination_district,
          destination_address: newContract.destination_address
        }])
        .select()
        .single()

      if (contractError) {
        if (contractError.code === '23505') {
          throw new Error(`El código "${finalCode}" ya está en uso. No se permiten duplicados.`)
        }
        throw contractError
      }

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
      setNewContract({ correlative: '', type: 'CONTRATO', client_id: '', parent_contract_id: '', budget_pen: '', total_weight_kg: '', total_volume_m3: '', destination_department: '', destination_province: '', destination_district: '', destination_address: '' })
      fetchContracts()
    } catch (error: any) {
      toast.error(error.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const downloadTemplate = () => {
    window.open('/api/templates/contratos', '_blank')
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setIsUploading(true)
    const reader = new FileReader()
    reader.onload = async (evt) => {
      try {
        const bstr = evt.target?.result
        const wb = XLSX.read(bstr, { type: 'binary' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const data = XLSX.utils.sheet_to_json(ws) as any[]

        let successCount = 0
        let errorCount = 0

        // Traemos contratos de la BD para mapear CodigoMadre -> UUID en memoria
        const { data: dbContracts } = await supabase.from('contracts').select('id, code, destination_department, destination_province, destination_district, destination_address')
        const contractMap = new Map(dbContracts?.map(c => [c.code, c]))

        for (const row of data) {
          try {
            const tipo = row.Tipo?.toUpperCase()
            let codigo = String(row.Codigo || '').trim()
            const codigoMadre = String(row.CodigoMadre || '').trim()
            const presupuesto = Number(row.Presupuesto_Soles || row.Presupuesto || 0)
            const peso = Number(row.Peso_Total_KG || 0)
            const volumen = Number(row.Volumen_Total_M3 || 0)
            let dep = String(row.Destino_Departamento || '').trim().toUpperCase()
            let prov = String(row.Destino_Provincia || '').trim().toUpperCase()
            let dist = String(row.Destino_Distrito || '').trim().toUpperCase()
            let dir = String(row.Destino_Direccion || '').trim()

            if (!codigo) continue

            let parentId = null
            let finalCode = codigo

            if (tipo === 'SUBCONTRATO' || tipo === 'ERROR') {
              if (codigoMadre && contractMap.has(codigoMadre)) {
                const parent = contractMap.get(codigoMadre)
                if (parent) {
                  parentId = parent.id
                  finalCode = `${codigoMadre}-${codigo}`

                  // Heredar destino si los campos están vacíos
                  if (tipo === 'SUBCONTRATO' || tipo === 'ERROR') {
                    if (!dep) dep = parent.destination_department || ''
                    if (!prov) prov = parent.destination_province || ''
                    if (!dist) dist = parent.destination_district || ''
                    if (!dir) dir = parent.destination_address || ''
                  }
                } else {
                  throw new Error(`Contrato Madre "${codigoMadre}" no existe en base de datos.`)
                }
              } else {
                throw new Error(`Contrato Madre "${codigoMadre}" no existe en base de datos.`)
              }
            } else if (tipo === 'CONTRATO') {
              if (!dep || !prov || !dist || !dir) {
                throw new Error(`Los campos de destino (Departamento, Provincia, Distrito, Dirección) son obligatorios para un CONTRATO principal.`)
              }
            }

            // Insert contract
            const { data: insertedContract, error: insertError } = await supabase
              .from('contracts')
              .insert([{
                code: finalCode,
                type: tipo,
                parent_contract_id: parentId,
                status: 'ACTIVO',
                total_weight_kg: peso,
                total_volume_m3: volumen,
                destination_department: dep || null,
                destination_province: prov || null,
                destination_district: dist || null,
                destination_address: dir || null
              }])
              .select()
              .single()

            if (insertError) {
              if (insertError.code === '23505') throw new Error(`El código "${finalCode}" ya existe.`)
              throw insertError
            }
            
            // Register memory map just in case a sub-contract references it in the same file
            contractMap.set(finalCode, insertedContract)

            // Update Budget
            if (presupuesto > 0) {
              await supabase
                .from('contract_budgets')
                .update({ allocated_pen: presupuesto })
                .eq('contract_id', insertedContract.id)
            }
            successCount++
          } catch (err: any) {
            console.error(err)
            errorCount++
          }
        }

        toast.success(`Carga Masiva completada. Éxitos: ${successCount}, Errores: ${errorCount}`)
        fetchContracts()
      } catch (error: any) {
        toast.error('Error al procesar el archivo: ' + error.message)
      } finally {
        setIsUploading(false)
        if (fileInputRef.current) fileInputRef.current.value = ''
      }
    }
    reader.readAsBinaryString(file)
  }

  const getTypeBadge = (type: string) => {
    switch(type) {
      case 'CONTRATO': return <span className="bg-blue-100 text-blue-800 px-2 py-1 rounded-md text-xs font-semibold flex items-center gap-1"><Briefcase className="w-3 h-3"/> Madre</span>
      case 'SUBCONTRATO': return <span className="bg-purple-100 text-purple-800 px-2 py-1 rounded-md text-xs font-semibold flex items-center gap-1"><Layers className="w-3 h-3"/> Sub</span>
      case 'ERROR': return <span className="bg-red-100 text-red-800 px-2 py-1 rounded-md text-xs font-semibold flex items-center gap-1"><FileWarning className="w-3 h-3"/> Error</span>
      default: return <span className="bg-slate-100 text-slate-800 px-2 py-1 rounded-md text-xs font-semibold">{type}</span>
    }
  }

  // Helper
  const getSelectedParentCode = () => {
    if (!newContract.parent_contract_id) return ''
    const p = contracts.find(c => c.id === newContract.parent_contract_id)
    return p ? p.code + '-' : ''
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex justify-between items-center bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Alta de Contratos</h1>
          <p className="text-sm text-slate-500 mt-1">Gestión unificada de Contratos, Subcontratos y Errores (Partidas de Transporte)</p>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="file"
            accept=".xlsx, .xls"
            className="hidden"
            ref={fileInputRef}
            onChange={handleFileUpload}
          />
          <button
            onClick={downloadTemplate}
            className="flex items-center gap-2 bg-white text-slate-700 border border-slate-300 px-4 py-2.5 rounded-lg font-medium hover:bg-slate-50 transition-all text-sm"
          >
            <Download className="w-4 h-4" />
            Plantilla Excel
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className="flex items-center gap-2 bg-emerald-600 text-white px-4 py-2.5 rounded-lg font-medium hover:bg-emerald-700 transition-all text-sm disabled:opacity-50"
          >
            <Upload className="w-4 h-4" />
            {isUploading ? 'Procesando...' : 'Carga Masiva'}
          </button>

          <button
            onClick={() => setIsModalOpen(true)}
            className="flex items-center gap-2 bg-slate-900 text-white px-5 py-2.5 rounded-lg font-medium hover:bg-slate-800 transition-all shadow-md hover:shadow-lg text-sm"
          >
            <Plus className="w-4 h-4" />
            Nuevo Contrato
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-6 py-4 font-semibold">Código / Jerarquía</th>
                <th className="px-6 py-4 font-semibold">Tipo</th>
                <th className="px-6 py-4 font-semibold">Carga</th>
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
                      <div className="flex flex-col gap-1">
                        {getTypeBadge(contract.type)}
                        {contract.destination_district && (
                          <span className="text-[10px] text-slate-500 font-medium">
                            📍 {contract.destination_district}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-xs text-slate-500">
                      {contract.total_weight_kg ? `${contract.total_weight_kg} KG` : '0 KG'}<br/>
                      {contract.total_volume_m3 ? `${contract.total_volume_m3} M3` : '0 M3'}
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

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title="Alta de Contrato / OT" maxWidth="max-w-4xl">
        <form onSubmit={handleCreateContract} className="space-y-6">
          <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
            <h3 className="text-sm font-semibold text-slate-800 mb-4 border-b border-slate-200 pb-2">Información Básica</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Tipo de Registro</label>
                <select
                  value={newContract.type}
                  onChange={(e) => setNewContract({...newContract, type: e.target.value as any})}
                  className="w-full border border-slate-300 rounded-lg p-2.5 outline-none focus:ring-2 focus:ring-[#002855] focus:border-[#002855] transition-all text-sm bg-white"
                >
                  <option value="CONTRATO">Contrato Principal / OT Madre</option>
                  <option value="SUBCONTRATO">Subcontrato</option>
                  <option value="ERROR">Error / Reproceso</option>
                </select>
              </div>

              {(newContract.type === 'SUBCONTRATO' || newContract.type === 'ERROR') && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Contrato Madre <span className="text-red-500">*</span></label>
                  <select
                    required
                    value={newContract.parent_contract_id}
                    onChange={(e) => {
                      const parentId = e.target.value
                      const parent = contracts.find(c => c.id === parentId)
                      setNewContract({
                        ...newContract,
                        parent_contract_id: parentId,
                        ...(parent && (newContract.type === 'SUBCONTRATO' || newContract.type === 'ERROR') ? {
                          destination_department: parent.destination_department || '',
                          destination_province: parent.destination_province || '',
                          destination_district: parent.destination_district || '',
                          destination_address: parent.destination_address || ''
                        } : {})
                      })
                    }}
                    className="w-full border border-slate-300 rounded-lg p-2.5 outline-none focus:ring-2 focus:ring-[#002855] focus:border-[#002855] transition-all text-sm bg-white"
                  >
                    <option value="">-- Seleccionar Contrato Padre --</option>
                    {contracts.filter(c => c.type === 'CONTRATO').map(c => (
                      <option key={c.id} value={c.id}>{c.code}</option>
                    ))}
                  </select>
                </div>
              )}

              <div className={(newContract.type === 'SUBCONTRATO' || newContract.type === 'ERROR') ? "md:col-span-2" : ""}>
                <label className="block text-sm font-medium text-slate-700 mb-1">Código o Correlativo</label>
                <div className="flex border border-slate-300 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-[#002855] focus-within:border-[#002855] transition-all bg-white">
                  {getSelectedParentCode() && (
                    <div className="bg-slate-100 px-3 py-2.5 text-slate-600 font-medium border-r border-slate-300 text-sm flex items-center">
                      {getSelectedParentCode()}
                    </div>
                  )}
                  <input
                    type="text"
                    required
                    value={newContract.correlative}
                    onChange={(e) => setNewContract({...newContract, correlative: e.target.value})}
                    className="w-full p-2.5 outline-none text-sm"
                    placeholder={newContract.type === 'SUBCONTRATO' ? 'S001' : newContract.type === 'ERROR' ? 'E001' : '16584'}
                  />
                </div>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-white p-4 rounded-lg border border-slate-200 shadow-sm">
              <h3 className="text-sm font-semibold text-slate-800 mb-4 border-b border-slate-100 pb-2">Presupuesto y Carga</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Partida de Transporte Inicial (S/)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={newContract.budget_pen}
                    onChange={(e) => setNewContract({...newContract, budget_pen: e.target.value})}
                    className="w-full border border-slate-300 rounded-lg p-2.5 outline-none focus:ring-2 focus:ring-[#002855] focus:border-[#002855] transition-all text-sm"
                    placeholder="0.00 (Opcional)"
                  />
                  <p className="text-[10px] text-slate-500 mt-1 leading-tight">
                    Esta partida se reservará y consumirá automáticamente al planificar rutas.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Peso (KG)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={newContract.total_weight_kg}
                      onChange={(e) => setNewContract({...newContract, total_weight_kg: e.target.value})}
                      className="w-full border border-slate-300 rounded-lg p-2.5 outline-none focus:ring-2 focus:ring-[#002855] focus:border-[#002855] transition-all text-sm"
                      placeholder="Ej. 15000"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Volumen (M3)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={newContract.total_volume_m3}
                      onChange={(e) => setNewContract({...newContract, total_volume_m3: e.target.value})}
                      className="w-full border border-slate-300 rounded-lg p-2.5 outline-none focus:ring-2 focus:ring-[#002855] focus:border-[#002855] transition-all text-sm"
                      placeholder="Ej. 35.5"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-white p-4 rounded-lg border border-slate-200 shadow-sm">
              <h3 className="text-sm font-semibold text-slate-800 mb-4 border-b border-slate-100 pb-2">Destino / Proyecto</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Dirección Exacta <span className="text-red-500">*</span></label>
                  <input
                    type="text"
                    required
                    value={newContract.destination_address}
                    onChange={(e) => setNewContract({...newContract, destination_address: e.target.value})}
                    className="w-full border border-slate-300 rounded-lg p-2.5 outline-none focus:ring-2 focus:ring-[#002855] focus:border-[#002855] transition-all text-sm bg-slate-50"
                    placeholder="Ej. Av. Industrial 123"
                  />
                </div>
                <div className="grid grid-cols-1 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Departamento <span className="text-red-500">*</span></label>
                  <input
                    type="text"
                    required
                    value={newContract.destination_department}
                    onChange={(e) => setNewContract({...newContract, destination_department: e.target.value.toUpperCase()})}
                    className="w-full border border-slate-300 rounded-lg p-2.5 outline-none focus:ring-2 focus:ring-[#002855] focus:border-[#002855] transition-all text-sm bg-slate-50"
                    placeholder="Ej. LIMA"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Provincia <span className="text-red-500">*</span></label>
                  <input
                    type="text"
                    required
                    value={newContract.destination_province}
                    onChange={(e) => setNewContract({...newContract, destination_province: e.target.value.toUpperCase()})}
                    className="w-full border border-slate-300 rounded-lg p-2.5 outline-none focus:ring-2 focus:ring-[#002855] focus:border-[#002855] transition-all text-sm bg-slate-50"
                    placeholder="Ej. LIMA"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Distrito <span className="text-red-500">*</span></label>
                  <input
                    type="text"
                    required
                    value={newContract.destination_district}
                    onChange={(e) => setNewContract({...newContract, destination_district: e.target.value.toUpperCase()})}
                    className="w-full border border-slate-300 rounded-lg p-2.5 outline-none focus:ring-2 focus:ring-[#002855] focus:border-[#002855] transition-all text-sm bg-slate-50"
                    placeholder="Ej. ATE"
                  />
                </div>
                </div>
              </div>
            </div>
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
              className="px-6 py-2 bg-[#002855] text-white font-medium rounded-lg hover:bg-[#001d3d] transition-colors disabled:opacity-50 shadow-md"
            >
              {isSubmitting ? 'Guardando...' : 'Guardar Registro'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
