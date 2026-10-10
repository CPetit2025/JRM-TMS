"use client"
import { PageHeader } from '@/components/ui/page-header'
import { DataTable } from '@/components/ui/data-table'

import { operatingBudget } from '@/lib/transport-budget'
import { useState, useEffect, useRef } from 'react'
import { Plus, Search, Layers, FileWarning, Briefcase, CheckCircle2, Upload, Download, Edit2, Filter, MapPin, UserCog, ChevronRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { SearchableSelect } from '@/components/ui/SearchableSelect'
import * as XLSX from 'xlsx'
import { useRouter } from 'next/navigation'
import { usePermissions } from '@/hooks/usePermissions'
import { MAX_TONS, checkVolume, kgHint, tonsToKg } from '@/lib/contract-weight'
import { ContractQuickView } from '@/components/contratos/ContractQuickView'
import { ClaimContractsModal } from '@/components/contratos/ClaimContractsModal'

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
  clients?: {
    id: string
    business_name: string
  }
  subcontracts_count?: number
  errors_count?: number
  requests_count?: number
  budget?: {
    allocated_usd: number
    allocated_pen: number
    own_allocated_pen: number
    balance_pen: number
  }
}

export default function ContratosPage() {
  const router = useRouter()
  const [quickView, setQuickView] = useState<Contract | null>(null)
  const supabase = createClient()
  const { role } = usePermissions()
  const [contracts, setContracts] = useState<Contract[]>([])
  const [contractAdmins, setContractAdmins] = useState<Array<{ id: string, name: string }>>([])
  const [profileNames, setProfileNames] = useState<Record<string, string>>({})
  const [assignments, setAssignments] = useState<Array<{ id: string, contract_id: string, user_id: string, role: string, active: boolean, assigned_at: string, ended_at: string | null, assigned_by: string | null }>>([])
  const [assignmentTarget, setAssignmentTarget] = useState<Contract | null>(null)
  const [selectedAdminId, setSelectedAdminId] = useState('')
  const [assignmentReason, setAssignmentReason] = useState('')
  const [isAssigning, setIsAssigning] = useState(false)
  const [clients, setClients] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  
  // Bulk upload
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [editingContract, setEditingContract] = useState<Contract | null>(null)
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)
  const [editFormData, setEditFormData] = useState({
    budget_pen: '',
    total_weight_kg: '',
    total_volume_m3: '',
    destination_department: '',
    destination_province: '',
    destination_district: '',
    destination_address: ''
  })

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


  const [searchTerm, setSearchTerm] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [filterStatus, setFilterStatus] = useState('TODOS')
  const [filterType, setFilterType] = useState('TODOS')

  const filteredContracts = contracts.filter(c => {
    const matchesSearch = searchTerm === '' || 
      c.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (c.clients?.business_name || '').toLowerCase().includes(searchTerm.toLowerCase());
      
    const matchesStatus = filterStatus === 'TODOS' || c.status === filterStatus;
    const matchesType = filterType === 'TODOS' || c.type === filterType;

    return matchesSearch && matchesStatus && matchesType;
  });

  useEffect(() => {
    fetchContracts()
    fetchClients()
  }, [])

  useEffect(() => {
    if (role === 'admin') void fetchAssignmentData()
  }, [role])

  // Administrador de Contratos: elige sus OT como Responsable de OT; sin ninguna asignada se le pide al entrar.
  const isContractAdmin = role === 'administrador de contratos'
  const [claimOpen, setClaimOpen] = useState(false)
  const [claimFirstTime, setClaimFirstTime] = useState(false)
  useEffect(() => {
    if (!isContractAdmin) return
    void (async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { count } = await supabase.from('contract_user_assignments').select('id', { count: 'exact', head: true })
        .eq('user_id', user.id).eq('role', 'ADMIN_CONTRATO').eq('active', true)
      if ((count ?? 0) === 0) { setClaimFirstTime(true); setClaimOpen(true) }
    })()
  }, [isContractAdmin])

  const fetchAssignmentData = async () => {
    const [profilesResult, assignmentsResult] = await Promise.all([
      supabase.from('profiles').select('id, first_name, last_name, is_active, roles(name)'),
      supabase.from('contract_user_assignments').select('id, contract_id, user_id, role, active, assigned_at, ended_at, assigned_by').order('assigned_at', { ascending: false }),
    ])
    if (profilesResult.error || assignmentsResult.error) {
      toast.error('No se pudieron cargar los responsables de OT')
      return
    }
    setProfileNames(Object.fromEntries((profilesResult.data || []).map(profile => [
      profile.id, `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || profile.id,
    ])))
    setContractAdmins((profilesResult.data || []).filter(profile => {
      const linkedRole = Array.isArray(profile.roles) ? profile.roles[0] : profile.roles
      return profile.is_active && linkedRole?.name === 'Administrador de Contratos'
    }).map(profile => ({ id: profile.id, name: `${profile.first_name || ''} ${profile.last_name || ''}`.trim() })))
    setAssignments(assignmentsResult.data || [])
  }

  const openAssignment = (contract: Contract) => {
    const current = assignments.find(item => item.contract_id === contract.id && item.role === 'ADMIN_CONTRATO' && item.active)
    setAssignmentTarget(contract)
    setSelectedAdminId(current?.user_id || '')
    setAssignmentReason('')
  }

  const saveAssignment = async () => {
    if (!assignmentTarget || role !== 'admin') return
    setIsAssigning(true)
    try {
      const { error } = await supabase.rpc('reassign_contract_administrator', {
        p_contract_id: assignmentTarget.id,
        p_user_id: selectedAdminId || null,
        p_reason: assignmentReason.trim() || null,
      })
      if (error) throw error
      await fetchAssignmentData()
      setAssignmentTarget(null)
      toast.success('Responsable actualizado; el historial se conservó')
    } catch (error: any) {
      toast.error('No se pudo reasignar la OT: ' + error.message)
    } finally {
      setIsAssigning(false)
    }
  }

  const fetchClients = async () => {
    try {
      const { data, error } = await supabase.from('clients').select('id, business_name, tax_id').eq('is_active', true)
      if (!error && data) setClients(data)
    } catch (e) {
      console.error('Error fetching clients', e)
    }
  }

  const fetchContracts = async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('vw_contracts_dashboard')
        .select('*')
        .is('parent_contract_id', null)
        .order('created_at', { ascending: false })

      if (error) throw error

      const formatted = (data || []).map((c: any) => ({
        ...c,
        clients: c.client_id ? { id: c.client_id, business_name: c.client_name } : undefined,
        budget: {
          allocated_usd: c.allocated_usd,
          allocated_pen: c.allocated_pen,
          own_allocated_pen: c.own_allocated_pen,
          balance_pen: c.balance_pen
        }
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

      const payload = {
          code: finalCode,
          type: newContract.type,
          parent_contract_id: newContract.parent_contract_id || null,
          client_id: newContract.client_id || null,
          status: 'ACTIVO',
          total_weight_kg: tonsToKg(newContract.total_weight_kg),
          total_volume_m3: checkVolume(newContract.total_volume_m3),
          destination_department: newContract.destination_department,
          destination_province: newContract.destination_province,
          destination_district: newContract.destination_district,
          destination_address: newContract.destination_address
      }
      // Alta en el servidor: permisos, sede, jerarquía, duplicados y partida en una sola operación
      const { data, error } = await supabase.rpc('create_contract', {
        p_payload: payload,
        p_budget_pen: Number(newContract.budget_pen) || 0,
      })
      if (error) throw new Error(error.message)
      const result = data as { success?: boolean; error?: string } | null
      if (!result?.success) throw new Error(result?.error || 'No se pudo registrar el contrato')

      toast.success('Contrato creado exitosamente')
      setIsModalOpen(false)
      setNewContract({ correlative: '', type: 'CONTRATO', client_id: '', parent_contract_id: '', budget_pen: '', total_weight_kg: '', total_volume_m3: '', destination_department: '', destination_province: '', destination_district: '', destination_address: '' })
      fetchContracts()
    } catch (error: any) {
      toast.error('No se pudo registrar el contrato: ' + (error?.message || 'error desconocido'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleEditClick = (contract: Contract) => {
    window.dispatchEvent(new CustomEvent('jrm:context', { detail: { contractId: contract.id } }))
    setEditingContract(contract)
    setEditFormData({
      budget_pen: contract.budget?.own_allocated_pen?.toString() || '',
      total_weight_kg: contract.total_weight_kg ? (Number(contract.total_weight_kg) / 1000).toString() : '',
      total_volume_m3: contract.total_volume_m3?.toString() || '',
      destination_department: contract.destination_department || '',
      destination_province: contract.destination_province || '',
      destination_district: contract.destination_district || '',
      destination_address: contract.destination_address || ''
    })
    setIsEditModalOpen(true)
  }

  const handleUpdateContract = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editingContract) return
    setIsSubmitting(true)

    try {
      // 1. Datos de la OT. Si la RLS no permite editarla (p. ej. OT fuera de la cartera) no se actualiza ninguna fila:
      //    se informa en lugar de mostrar un "actualizado" falso.
      const { data: updated, error: contractError } = await supabase
        .from('contracts')
        .update({
          total_weight_kg: tonsToKg(editFormData.total_weight_kg),
          total_volume_m3: checkVolume(editFormData.total_volume_m3),
          destination_department: editFormData.destination_department,
          destination_province: editFormData.destination_province,
          destination_district: editFormData.destination_district,
          destination_address: editFormData.destination_address
        })
        .eq('id', editingContract.id)
        .select('id')

      if (contractError) throw contractError
      if (!updated?.length) throw new Error('No tiene permiso para editar esta OT o ya no existe')

      // 2. Partida de transporte: en el servidor (permisos, cartera, sede, OT raíz) y se crea si la OT no la tenía.
      //    Antes se hacía un UPDATE directo que, sin fila de partida, no guardaba nada y aun así mostraba "actualizado".
      const rawBudget = editFormData.budget_pen.trim()
      if (rawBudget !== '') {
        const newBudget = Number(rawBudget)
        if (!Number.isFinite(newBudget) || newBudget < 0) throw new Error('La partida debe ser un monto válido (cero o mayor)')
        const current = editingContract.budget?.own_allocated_pen
        if (current == null || Number(current) !== newBudget) {
          const { error: budgetError } = await supabase.rpc('set_contract_transport_budget', {
            p_contract_id: editingContract.id,
            p_amount: newBudget,
            p_reason: 'Edición de OT en Contratos',
          })
          if (budgetError) throw new Error('Los datos de la OT se guardaron, pero la partida no: ' + budgetError.message)
        }
      }

      toast.success('Contrato actualizado exitosamente')
      setIsEditModalOpen(false)
      setEditingContract(null)
      fetchContracts()
    } catch (error: any) {
      toast.error('Error al actualizar: ' + error.message)
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
        const errorDetails: string[] = []

        // Traemos contratos de la BD para mapear CodigoMadre -> UUID en memoria
        const { data: dbContracts } = await supabase.from('contracts').select('id, code, destination_department, destination_province, destination_district, destination_address')
        const contractMap = new Map(dbContracts?.map(c => [c.code, c]))

        // Traemos clientes para mapear por RUC o por nombre
        const { data: dbClients } = await supabase.from('clients').select('id, tax_id, business_name')
        // Mapa por RUC (exacto)
        const clientMapByRuc = new Map(dbClients?.map(c => [c.tax_id?.trim(), c.id]))
        // Mapa por nombre (normalizado a mayúsculas para comparación flexible)
        const clientMapByName = new Map(dbClients?.map(c => [c.business_name?.trim().toUpperCase(), c.id]))

        for (const row of data) {
          try {
            const tipo = (row.Tipo || '').toString().trim().toUpperCase()
            if (!tipo) continue

            // En el Excel: para CONTRATO el código está en CodigoMadre,
            // para SUBCONTRATO/ERROR el código propio está en Codigo y el padre en CodigoMadre
            const codigoMadreRaw = String(row.CodigoMadre || '').trim()
            const codigoPropio = String(row.Codigo || '').trim()

            // El código del contrato que vamos a registrar:
            // - CONTRATO: usa CodigoMadre como su propio código
            // - SUBCONTRATO/ERROR: usa Codigo como sufijo y CodigoMadre como padre
            let codigo = tipo === 'CONTRATO' ? codigoMadreRaw : codigoPropio
            const codigoMadre = tipo === 'CONTRATO' ? '' : codigoMadreRaw

            const presupuesto = Number(row.Presupuesto_Soles || row.Presupuesto || 0)
            const peso = Number(row.Peso_Total_KG || 0)
            const volumen = Number(row.Volumen_Total_M3 || 0)
            let dep = String(row.Destino_Departamento || '').trim().toUpperCase()
            let prov = String(row.Destino_Provincia || '').trim().toUpperCase()
            let dist = String(row.Destino_Distrito || '').trim().toUpperCase()
            let dir = String(row.Destino_Direccion || '').trim()
            
            const clienteRaw = String(row.Cliente_RUC || row.RUC || row.Cliente || '').trim()
            let clientId = null
            if (clienteRaw) {
              // Intentar primero por RUC (solo dígitos)
              const esRuc = /^\d{8,11}$/.test(clienteRaw)
              if (esRuc && clientMapByRuc.has(clienteRaw)) {
                clientId = clientMapByRuc.get(clienteRaw)
              } else {
                // Buscar por nombre (case-insensitive)
                const nombreNorm = clienteRaw.toUpperCase()
                if (clientMapByName.has(nombreNorm)) {
                  clientId = clientMapByName.get(nombreNorm)
                } else {
                  // Búsqueda parcial: ver si algún nombre del DB está contenido en el valor del Excel o viceversa
                  for (const [nombre, id] of clientMapByName.entries()) {
                    if (nombreNorm.includes(nombre) || nombre.includes(nombreNorm)) {
                      clientId = id
                      break
                    }
                  }
                }
              }
            }

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
                  if (!dep) dep = parent.destination_department || ''
                  if (!prov) prov = parent.destination_province || ''
                  if (!dist) dist = parent.destination_district || ''
                  if (!dir) dir = parent.destination_address || ''
                } else {
                  throw new Error(`Contrato Madre "${codigoMadre}" no existe en base de datos.`)
                }
              } else {
                throw new Error(`Contrato Madre "${codigoMadre}" no existe en base de datos.`)
              }
            } else if (tipo === 'CONTRATO') {
              if (!dep || !prov || !dist || !dir) {
                throw new Error(`Los campos de destino son obligatorios para el CONTRATO "${codigo}". Verifique Departamento, Provincia, Distrito y Dirección.`)
              }
            }


            const payload = {
                code: finalCode,
                type: tipo,
                parent_contract_id: parentId,
                client_id: clientId,
                status: 'ACTIVO',
                total_weight_kg: peso,
                total_volume_m3: volumen,
                destination_department: dep || null,
                destination_province: prov || null,
                destination_district: dist || null,
                destination_address: dir || null
            }
            const { data: created, error } = await supabase.rpc('create_contract', {
              p_payload: payload,
              p_budget_pen: presupuesto,
            })
            if (error) throw new Error(error.message)
            const result = created as { success?: boolean; error?: string; id?: string } | null
            if (!result?.success || !result.id) throw new Error(result?.error || `No se pudo registrar ${finalCode}`)
            const insertedContract = { id: result.id, code: finalCode, destination_department: dep || null,
              destination_province: prov || null, destination_district: dist || null, destination_address: dir || null }

            // Register memory map just in case a sub-contract references it in the same file
            contractMap.set(finalCode, insertedContract)
            successCount++
          } catch (err: any) {
            console.error(err)
            errorCount++
            if (errorDetails.length < 3) errorDetails.push(err?.message || 'error desconocido')
          }
        }

        if (errorCount) toast.warning(`Carga masiva: ${successCount} registrados, ${errorCount} con error. ${errorDetails.join(' · ')}`)
        else toast.success(`Carga masiva completada: ${successCount} registrados`)
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

  const STATUS_STYLE: Record<string, string> = {
    ACTIVO: 'bg-emerald-50 text-emerald-700', CERRADO: 'bg-slate-100 text-slate-600', SUSPENDIDO: 'bg-amber-50 text-amber-700',
  }
  const money = (n: number) => n.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const getTypeBadge = (type: string) => {
    switch(type) {
      case 'CONTRATO': return <span className="bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded text-[11px] font-semibold inline-flex items-center gap-1"><Briefcase className="w-3 h-3"/> Madre</span>
      case 'SUBCONTRATO': return <span className="bg-purple-100 text-purple-800 px-1.5 py-0.5 rounded text-[11px] font-semibold inline-flex items-center gap-1"><Layers className="w-3 h-3"/> Sub</span>
      case 'ERROR': return <span className="bg-red-100 text-red-800 px-1.5 py-0.5 rounded text-[11px] font-semibold inline-flex items-center gap-1"><FileWarning className="w-3 h-3"/> Error</span>
      default: return <span className="bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded text-[11px] font-semibold">{type === 'OT_INDEPENDIENTE' ? 'OT indep.' : type}</span>
    }
  }

  // Helper
  const getSelectedParentCode = () => {
    if (!newContract.parent_contract_id) return ''
    const p = contracts.find(c => c.id === newContract.parent_contract_id)
    return p ? p.code + '-' : ''
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-3 mx-auto">
      <PageHeader showTitle title="Alta de Contratos" description="Gestión unificada de Contratos, Subcontratos y Errores (Partidas de Transporte)" actions={<>
<div className="flex flex-wrap items-center gap-3">
          {isContractAdmin && (
            <button type="button" onClick={() => { setClaimFirstTime(false); setClaimOpen(true) }}
              className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-[#002855] px-3 text-sm font-semibold text-[#002855] hover:bg-slate-50">
              <UserCog className="h-4 w-4" /> Mis contratos
            </button>
          )}
          <input
            type="file"
            accept=".xlsx, .xls"
            className="hidden"
            ref={fileInputRef}
            onChange={handleFileUpload}
          />
          <button
            onClick={downloadTemplate}
            className="flex items-center gap-2 bg-white text-slate-700 border border-slate-300 px-4 py-2 rounded-lg font-medium hover:bg-slate-50 transition-colors shadow-sm"
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
</>} />

      {/* Buscador y Filtros */}
      <div className="flex flex-col md:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="Buscar por código de contrato, empresa..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
          />
        </div>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`flex items-center gap-2 px-4 py-2 border rounded-lg text-sm font-medium transition-colors ${
            showFilters 
              ? 'bg-blue-50 border-blue-200 text-blue-700' 
              : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
          }`}
        >
          <Filter className="w-4 h-4" />
          Filtros Avanzados
        </button>
      </div>

      {/* Panel de Filtros Avanzados */}
      {showFilters && (
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Estado</label>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="TODOS">Todos</option>
              <option value="ACTIVO">Activo</option>
              <option value="CERRADO">Cerrado</option>
              <option value="SUSPENDIDO">Suspendido</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Tipo</label>
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="TODOS">Todos</option>
              <option value="CONTRATO">Contrato Madre</option>
              <option value="SUBCONTRATO">Subcontrato</option>
              <option value="ERROR">Error</option>
              <option value="OT_INDEPENDIENTE">OT Independiente</option>
            </select>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div role="region" aria-label="Tabla de contratos" tabIndex={0} className="h-full overflow-auto">
          <DataTable className="relative w-full min-w-[720px] table-fixed text-left text-sm">
            <colgroup>
              <col className="w-[19%]" />
              <col />
              <col className="hidden lg:table-column w-[10%]" />
              <col className="hidden md:table-column w-[9%]" />
              <col className="w-[20%]" />
              <col className="w-[10%]" />
              {role === 'admin' && <col className="hidden xl:table-column w-[12%]" />}
              <col className={role === 'admin' ? 'w-[92px]' : 'w-[56px]'} />
            </colgroup>
            <thead className="sticky top-0 z-30 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 shadow-[0_1px_0_0_#e2e8f0]">
              <tr>
                <th className="px-4 py-3 font-semibold">Contrato</th>
                <th className="px-4 py-3 font-semibold">Cliente y destino</th>
                <th className="hidden px-4 py-3 text-right font-semibold lg:table-cell">Carga</th>
                <th className="hidden px-4 py-3 font-semibold md:table-cell">Alta</th>
                <th className="px-4 py-3 font-semibold">Partida consolidada</th>
                <th className="px-4 py-3 font-semibold">Estado</th>
                {role === 'admin' && <th className="hidden px-4 py-3 font-semibold xl:table-cell">Responsable</th>}
                <th className="sticky right-0 z-40 bg-slate-50 px-2 py-3"><span className="sr-only">Acciones</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={role === 'admin' ? 8 : 7} className="px-6 py-10 text-center text-slate-500">Cargando contratos...</td>
                </tr>
              ) : filteredContracts.length === 0 ? (
                <tr>
                  <td colSpan={role === 'admin' ? 8 : 7} className="px-6 py-10 text-center text-slate-500">
                    {contracts.length === 0 ? 'No hay contratos en tu cartera.' : 'Ningún contrato coincide con la búsqueda o los filtros.'}
                  </td>
                </tr>
              ) : (
                filteredContracts.map((contract) => {
                  const allocated = Number(contract.budget?.allocated_pen || 0)
                  const balance = Number(contract.budget?.balance_pen || 0)
                  const operating = operatingBudget(allocated)
                  const used = Math.max(operating - balance, 0)
                  const usedPct = operating > 0 ? Math.min(100, (used / operating) * 100) : (balance < 0 ? 100 : 0)
                  const tone = balance < 0 ? 'red' : operating > 0 && balance / operating < 0.15 ? 'amber' : allocated > 0 ? 'emerald' : 'slate'
                  const toneText = { red: 'text-red-600', amber: 'text-amber-600', emerald: 'text-emerald-700', slate: 'text-slate-500' }[tone]
                  const toneBar = { red: 'bg-red-500', amber: 'bg-amber-500', emerald: 'bg-emerald-500', slate: 'bg-slate-300' }[tone]
                  const responsible = profileNames[assignments.find(item => item.contract_id === contract.id && item.role === 'ADMIN_CONTRATO' && item.active)?.user_id || '']
                  const destination = [contract.destination_district, contract.destination_address].filter(Boolean).join(' · ')
                  return (
                  <tr key={contract.id} onClick={() => setQuickView(contract)} className="group cursor-pointer align-top transition-colors hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[15px] font-bold text-slate-900">{contract.code}</span>
                        {getTypeBadge(contract.type)}
                      </div>
                      {contract.parent_contract_id && <div className="mt-1 text-xs text-slate-400">↳ Derivado de otro contrato</div>}
                      {(Number(contract.subcontracts_count) > 0 || Number(contract.errors_count) > 0 || Number(contract.requests_count) > 0) && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {Number(contract.subcontracts_count) > 0 && <span className="rounded bg-purple-50 px-1.5 py-0.5 text-[10px] font-medium text-purple-700">{contract.subcontracts_count} sub</span>}
                          {Number(contract.errors_count) > 0 && <span className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700">{contract.errors_count} errores</span>}
                          {Number(contract.requests_count) > 0 && <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">{contract.requests_count} {Number(contract.requests_count) === 1 ? 'solicitud' : 'solicitudes'}</span>}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="truncate font-medium text-[#002855]" title={contract.clients?.business_name || ''}>
                        {contract.clients?.business_name || <span className="text-xs font-normal text-slate-400">Sin cliente</span>}
                      </div>
                      {destination && (
                        <div className="mt-0.5 flex items-center gap-1 text-xs text-slate-500" title={destination}>
                          <MapPin className="h-3 w-3 shrink-0 text-slate-400" />
                          <span className="truncate">{destination}</span>
                        </div>
                      )}
                    </td>
                    <td className="hidden px-4 py-3 text-right tabular-nums text-slate-700 lg:table-cell">
                      {Number(contract.total_weight_kg || 0).toLocaleString('es-PE')} <span className="text-xs text-slate-400">kg</span>
                    </td>
                    <td className="hidden px-4 py-3 text-xs text-slate-600 md:table-cell">
                      {contract.created_at ? new Date(contract.created_at).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className={`font-semibold tabular-nums ${toneText}`}>S/ {money(balance)}</span>
                        <span className="text-[11px] text-slate-400">{balance < 0 ? 'excedido' : 'saldo'}</span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100" title={`Consumido/reservado ${usedPct.toFixed(0)}%`}>
                        <div className={`h-full rounded-full ${toneBar}`} style={{ width: `${usedPct}%` }} />
                      </div>
                      <div className="mt-1 text-[11px] text-slate-500 tabular-nums">
                        {allocated > 0 ? `Bruto S/ ${money(allocated)} · Operación 80% S/ ${money(operatingBudget(allocated))}` : 'Sin partida asignada'}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[contract.status] || 'bg-slate-100 text-slate-600'}`}>
                        {contract.status === 'ACTIVO' && <CheckCircle2 className="h-3 w-3" />}
                        {contract.status}
                      </span>
                    </td>
                    {role === 'admin' && <td className="hidden px-4 py-3 text-xs xl:table-cell">
                      {responsible ? <span className="text-slate-700">{responsible}</span> : <span className="text-slate-400">Sin asignar</span>}
                    </td>}
                    <td className="sticky right-0 z-[1] bg-white px-2 py-3 group-hover:bg-slate-50">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleEditClick(contract); }}
                          className="rounded-lg p-1.5 text-slate-500 hover:bg-blue-50 hover:text-[#002855]"
                          title="Editar contrato y partida" aria-label="Editar contrato y partida"
                        >
                          <Edit2 className="h-4 w-4" />
                        </button>
                        {role === 'admin' && <button
                          type="button"
                          onClick={e => { e.preventDefault(); e.stopPropagation(); openAssignment(contract) }}
                          className="rounded-lg p-1.5 text-slate-500 hover:bg-blue-50 hover:text-[#002855]"
                          title="Asignar Administrador de Contrato" aria-label="Asignar Administrador de Contrato"
                        >
                          <UserCog className="h-4 w-4" />
                        </button>}
                        <ChevronRight className="h-4 w-4 text-slate-300 group-hover:text-slate-500" aria-hidden />
                      </div>
                    </td>
                  </tr>
                  )
                })
              )}
            </tbody>
          </DataTable>
        </div>
      </div>

      <ContractQuickView
        contract={quickView}
        isAdmin={role === 'admin'}
        responsible={quickView ? profileNames[assignments.find(item => item.contract_id === quickView.id && item.role === 'ADMIN_CONTRATO' && item.active)?.user_id || ''] : undefined}
        onClose={() => setQuickView(null)}
        onEdit={() => { const c = quickView; setQuickView(null); if (c) handleEditClick(c) }}
        onAssign={() => { const c = quickView; setQuickView(null); if (c) openAssignment(c) }}
        onOpen={() => { const c = quickView; setQuickView(null); if (c) router.push(`/contratos/${c.id}`) }}
      />

      {claimOpen && <ClaimContractsModal open firstTime={claimFirstTime} onClose={() => setClaimOpen(false)} onClaimed={() => { void fetchContracts() }} />}

      <Modal isOpen={!!assignmentTarget} onClose={() => setAssignmentTarget(null)}
        title={`Responsable de OT ${assignmentTarget?.code || ''}`} maxWidth="max-w-xl">
        <div className="space-y-4">
          <label className="block text-sm font-medium text-slate-700">Administrador de Contrato
            <select value={selectedAdminId} onChange={e => setSelectedAdminId(e.target.value)}
              className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2">
              <option value="">Sin responsable</option>
              {contractAdmins.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>
          </label>
          <label className="block text-sm font-medium text-slate-700">Motivo de la reasignación
            <input value={assignmentReason} onChange={e => setAssignmentReason(e.target.value)}
              className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2"
              placeholder="Opcional" maxLength={250} />
          </label>
          <button type="button" onClick={saveAssignment} disabled={isAssigning}
            className="bg-[#002855] text-white rounded-lg px-4 py-2 disabled:opacity-50">
            {isAssigning ? 'Guardando...' : 'Guardar responsable'}
          </button>
          <div className="border-t pt-3">
            <p className="text-sm font-semibold text-slate-700 mb-2">Historial de responsabilidad</p>
            {assignments.filter(item => item.contract_id === assignmentTarget?.id && item.role === 'ADMIN_CONTRATO').map(item =>
              <p key={item.id} className="text-xs text-slate-600 py-1">
                {profileNames[item.user_id] || item.user_id} ·
                {' '}{new Date(item.assigned_at).toLocaleDateString('es-PE')} —
                {' '}{item.ended_at ? new Date(item.ended_at).toLocaleDateString('es-PE') : 'Actual'}
                {' · Asignado por: '}{profileNames[item.assigned_by || ''] || 'Sistema'}
              </p>)}
          </div>
        </div>
      </Modal>

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

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Cliente</label>
                <SearchableSelect
                  value={newContract.client_id}
                  onChange={(val) => setNewContract({...newContract, client_id: val})}
                  options={clients.map(c => ({ value: c.id, label: `${c.business_name} (${c.tax_id})` }))}
                  placeholder="-- Seleccionar Cliente (Opcional) --"
                />
              </div>

              {(newContract.type === 'SUBCONTRATO' || newContract.type === 'ERROR') && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Contrato Madre <span className="text-red-500">*</span></label>
                  <SearchableSelect
                    value={newContract.parent_contract_id}
                    onChange={(val) => {
                      const parentId = val
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
                    options={contracts.filter(c => c.type === 'CONTRATO').map(c => ({ value: c.id, label: c.code }))}
                    placeholder="-- Seleccionar Contrato Padre --"
                  />
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
                  <label className="block text-sm font-medium text-slate-700 mb-1">Partida propia de este registro (S/) · 80% para operación</label>
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
                    <label className="block text-sm font-medium text-slate-700 mb-1">Peso (toneladas)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max={MAX_TONS}
                      value={newContract.total_weight_kg}
                      onChange={(e) => setNewContract({...newContract, total_weight_kg: e.target.value})}
                      className="w-full border border-slate-300 rounded-lg p-2.5 outline-none focus:ring-2 focus:ring-[#002855] focus:border-[#002855] transition-all text-sm"
                      placeholder="Ej. 15"
                    />
                    <p className="mt-1 text-xs text-slate-500">{kgHint(newContract.total_weight_kg)}</p>
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

      {/* Edit Modal */}
      <Modal isOpen={isEditModalOpen} onClose={() => setIsEditModalOpen(false)} title={`Editar Contrato: ${editingContract?.code}`} maxWidth="max-w-4xl">
        <form onSubmit={handleUpdateContract} className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-white p-4 rounded-lg border border-slate-200 shadow-sm">
              <h3 className="text-sm font-semibold text-slate-800 mb-4 border-b border-slate-100 pb-2">Presupuesto y Carga</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Partida propia de este registro (S/) · 80% para operación</label>
                  <input
                    type="number"
                    step="0.01"
                    value={editFormData.budget_pen}
                    onChange={(e) => setEditFormData({...editFormData, budget_pen: e.target.value})}
                    className="w-full border border-slate-300 rounded-lg p-2.5 outline-none focus:ring-2 focus:ring-[#002855] focus:border-[#002855] transition-all text-sm"
                    placeholder="0.00"
                  />
                  <p className="text-[10px] text-slate-500 mt-1 leading-tight">
                    Este monto es la partida principal reservada para servicios. Si ya hay servicios consumidos, se recalculará el saldo disponible automáticamente.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Peso (toneladas)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max={MAX_TONS}
                      placeholder="Ej. 15"
                      value={editFormData.total_weight_kg}
                      onChange={(e) => setEditFormData({...editFormData, total_weight_kg: e.target.value})}
                      className="w-full border border-slate-300 rounded-lg p-2.5 outline-none focus:ring-2 focus:ring-[#002855] focus:border-[#002855] transition-all text-sm"
                    />
                    <p className="mt-1 text-xs text-slate-500">{kgHint(editFormData.total_weight_kg)}</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Volumen (M3)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={editFormData.total_volume_m3}
                      onChange={(e) => setEditFormData({...editFormData, total_volume_m3: e.target.value})}
                      className="w-full border border-slate-300 rounded-lg p-2.5 outline-none focus:ring-2 focus:ring-[#002855] focus:border-[#002855] transition-all text-sm"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-white p-4 rounded-lg border border-slate-200 shadow-sm">
              <h3 className="text-sm font-semibold text-slate-800 mb-4 border-b border-slate-100 pb-2">Destino / Proyecto</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Dirección Exacta</label>
                  <input
                    type="text"
                    value={editFormData.destination_address}
                    onChange={(e) => setEditFormData({...editFormData, destination_address: e.target.value})}
                    className="w-full border border-slate-300 rounded-lg p-2.5 outline-none focus:ring-2 focus:ring-[#002855] focus:border-[#002855] transition-all text-sm bg-slate-50"
                  />
                </div>
                <div className="grid grid-cols-1 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Departamento</label>
                    <input
                      type="text"
                      value={editFormData.destination_department}
                      onChange={(e) => setEditFormData({...editFormData, destination_department: e.target.value.toUpperCase()})}
                      className="w-full border border-slate-300 rounded-lg p-2.5 outline-none focus:ring-2 focus:ring-[#002855] focus:border-[#002855] transition-all text-sm bg-slate-50"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Provincia</label>
                    <input
                      type="text"
                      value={editFormData.destination_province}
                      onChange={(e) => setEditFormData({...editFormData, destination_province: e.target.value.toUpperCase()})}
                      className="w-full border border-slate-300 rounded-lg p-2.5 outline-none focus:ring-2 focus:ring-[#002855] focus:border-[#002855] transition-all text-sm bg-slate-50"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Distrito</label>
                    <input
                      type="text"
                      value={editFormData.destination_district}
                      onChange={(e) => setEditFormData({...editFormData, destination_district: e.target.value.toUpperCase()})}
                      className="w-full border border-slate-300 rounded-lg p-2.5 outline-none focus:ring-2 focus:ring-[#002855] focus:border-[#002855] transition-all text-sm bg-slate-50"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setIsEditModalOpen(false)}
              className="px-4 py-2 text-slate-600 font-medium hover:bg-slate-100 rounded-lg transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-6 py-2 bg-[#002855] text-white font-medium rounded-lg hover:bg-[#001d3d] transition-colors disabled:opacity-50 shadow-md"
            >
              {isSubmitting ? 'Guardando...' : 'Guardar Cambios'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}


