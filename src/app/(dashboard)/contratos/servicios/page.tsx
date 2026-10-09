"use client"
import { TransportWorkflow, TorreControlButton } from '@/components/transport/TransportWorkflow'
import { DataTable } from '@/components/ui/data-table'
import { PageHeader } from '@/components/ui/page-header'
import { InlineStatusBar } from '@/components/ui/inline-status-bar'
import { FilterToolbar, FilterField, filterControl } from '@/components/ui/filter-toolbar'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'
import { TableActions } from '@/components/ui/table-actions'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Plus, Check, Ban, Loader2, Upload, Download, AlertCircle, Search, X, ArrowUp, ArrowDown, ArrowUpDown, RefreshCw, Scale, Info, Layers, Clock, CheckCircle2, FileEdit } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { GuiaDetalleModal } from '@/components/guias/GuiaDetalleModal'
import { useDropzone } from 'react-dropzone'
import * as XLSX from 'xlsx'

interface Contract {
  id: string
  code: string
  type: string
  parent_contract_id?: string | null
  clients?: {
    business_name: string
  }
  contract_budgets?: Array<{
    balance_pen: number
    concept?: string
  }>
}

interface Dispatch {
  id: string
  dispatch_number: string
  driver_name: string
  vehicle_plate: string
  scheduled_departure: string
  status: string
  freight_cost: number
  contract_id: string
  contracts?: {
    code: string
    clients?: { business_name: string }
  }
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
  referral_guide?: string
  dispatch_id?: string | null
  void_reason?: string | null
  created_at: string
  contracts?: {
    code: string
    clients?: {
      business_name: string
    }
  }
}

interface RegistryContext { service_id: string; dispatch_number: string | null; request_numbers: string[]; operation_state: string | null; stage: 'COMPROMETIDO' | 'REALIZADO' | 'ANULADO' | 'REGISTRO_MANUAL' }
const stageLabels: Record<RegistryContext['stage'], string> = { COMPROMETIDO: 'Comprometido', REALIZADO: 'Realizado', ANULADO: 'Anulado', REGISTRO_MANUAL: 'Registro manual' }
const stageTone: Record<RegistryContext['stage'], StatusTone> = { COMPROMETIDO: 'warning', REALIZADO: 'success', ANULADO: 'danger', REGISTRO_MANUAL: 'neutral' }

type SortKey = 'fecha' | 'contrato' | 'cliente' | 'servicio' | 'placa' | 'guia' | 'ton' | 'monto' | 'traza' | 'estado'

// Peso de las guías según la SALIDA cargada en Almacén APT (tabla contract_service_peso_apt, migración 20261006130000)
interface PesoApt { service_id: string; guias: string; kg: number | null; encontradas: number; faltan: string | null; calculado_at: string }
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String((error as { message?: string } | null)?.message || error)
const fmtTon = (kg: number) => (kg / 1000).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
// TON a mostrar: el de APT si hay; si no, el KG escrito a mano en la descripción
const tonInfo = (srv: { description?: string }, p?: PesoApt): { ton: number | null; fuente: 'APT' | 'MANUAL' | null } => {
  if (p?.kg != null) return { ton: Number(p.kg) / 1000, fuente: 'APT' }
  const n = Number(srv.description)
  return srv.description && !isNaN(n) ? { ton: n / 1000, fuente: 'MANUAL' } : { ton: null, fuente: null }
}

export default function ContractServicesPage() {
  const supabase = createClient()
  // Con solo lectura (p. ej. Administrador de Contratos) se ocultan registrar, cargar, regularizar, editar y anular
  const { canWrite, isLoaded: permsLoaded } = usePermissions()
  const canEdit = permsLoaded && canWrite('contratos-servicios')
  const [services, setServices] = useState<ContractService[]>([])
  const [registryContext, setRegistryContext] = useState<Record<string, RegistryContext>>({})
  const [budgetContract, setBudgetContract] = useState('')
  const [reconcilingDispatch, setReconcilingDispatch] = useState<string | null>(null)
  const stageOf = (s: ContractService): RegistryContext['stage'] => s.status === 'ANULADO' ? 'ANULADO' : registryContext[s.id]?.stage || (s.dispatch_id ? 'COMPROMETIDO' : 'REGISTRO_MANUAL')
  const [pesoApt, setPesoApt] = useState<Record<string, PesoApt>>({})
  const [syncingPeso, setSyncingPeso] = useState(false)
  const [contracts, setContracts] = useState<Contract[]>([])
  const [orphanDispatches, setOrphanDispatches] = useState<Dispatch[]>([])
  const [loading, setLoading] = useState(true)
  const [isOrphanModalOpen, setIsOrphanModalOpen] = useState(false)
  // Guía(s) cuyo detalle de SKUs se muestra (desde la SALIDA cargada en Almacén APT)
  const [guiaAbierta, setGuiaAbierta] = useState<string | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  
  // Bulk upload states
  const [isUploading, setIsUploading] = useState(false)

  // Filters
  const [searchTerm, setSearchTerm] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'fecha', dir: 'desc' })
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')
  const [filterStatus, setFilterStatus] = useState('TODOS')

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
    category: 'Contrato',
    referral_guide: ''
  })
  
  const [viewingService, setViewingService] = useState<ContractService | null>(null)
  const [isEditingAmount, setIsEditingAmount] = useState(false)
  const [editAmountValue, setEditAmountValue] = useState('')
  const [isSavingAmount, setIsSavingAmount] = useState(false)
  const [voidReason, setVoidReason] = useState('')
  const [isVoiding, setIsVoiding] = useState(false)
  // Solo el Administrador o el Jefe de Distribución anulan; los demás necesitan su credencial
  const [canVoidDirect, setCanVoidDirect] = useState(false)
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')

  // Partida que descuenta el gasto: la del contrato o la del contrato madre más cercano que la tenga
  const partidaOf = (contractId: string) => {
    let current = contracts.find(c => c.id === contractId)
    for (let depth = 0; current && depth < 16; depth++) {
      const budget = current.contract_budgets?.find(b => (b.concept || 'PARTIDA_TRANSPORTE') === 'PARTIDA_TRANSPORTE')
      if (budget) return { balance: Number(budget.balance_pen || 0), owner: current }
      const parentId = current.parent_contract_id
      current = parentId ? contracts.find(c => c.id === parentId) : undefined
    }
    return null
  }
  const categoryOf = (type?: string) => type === 'SUBCONTRATO' ? 'Subcontrato' : type === 'ERROR' ? 'Error' : 'Contrato'
  const typeTag = (type?: string) => type === 'SUBCONTRATO' ? ' · Subcontrato' : type === 'ERROR' ? ' · Error' : ''


  // Desde la ficha de la OT: /contratos/servicios?contrato=<id> abre el registro con la OT elegida (una vez)
  const preselectDone = useRef(false)
  const applyPreselect = (list: Contract[]) => {
    if (preselectDone.current) return
    preselectDone.current = true
    const id = new URLSearchParams(window.location.search).get('contrato')
    if (!id) return
    const target = list.find(c => c.id === id)
    if (!target) { toast.error('La OT no está activa o no tiene acceso'); return }
    setNewService(prev => ({ ...prev, contract_id: target.id, category: categoryOf(target.type) }))
    setIsModalOpen(true)
  }

  const handleVoid = async () => {
    if (!viewingService) return
    if (!voidReason.trim()) { toast.error('Indique el motivo de la anulación'); return }
    if (!canVoidDirect && (!authEmail.trim() || !authPassword)) {
      toast.error('Ingrese el correo y la contraseña del Administrador o del Jefe de Distribución que autoriza')
      return
    }
    setIsVoiding(true)
    try {
      const response = await fetch('/api/contratos/anular-servicio', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId: viewingService.id, reason: voidReason.trim(),
          ...(canVoidDirect ? {} : { email: authEmail.trim(), password: authPassword }) }),
      })
      const result = await response.json().catch(() => ({})) as { success?: boolean; error?: string }
      if (!response.ok || !result.success) throw new Error(result.error || 'No se pudo anular')
      toast.success('Gasto anulado: el monto volvió a la partida')
      setViewingService({ ...viewingService, status: 'ANULADO', void_reason: voidReason.trim() })
      setVoidReason('')
      fetchData()
    } catch (error) {
      toast.error('No se pudo anular: ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setAuthPassword('')
      setIsVoiding(false)
    }
  }

    const fetchData = async () => {
    setLoading(true)
    try {
      const { data: sData, error: sError } = await supabase
        .from('contract_services')
        .select(`
          *,
          contracts!contract_id (
            code,
            clients (business_name)
          )
        `)
        .order('created_at', { ascending: false })
      
      if (sError) throw sError
      const rows = (sData as unknown as ContractService[]) || []
      const contexts: RegistryContext[] = []
      for (let offset = 0; offset < rows.length; offset += 200) {
        const { data, error } = await supabase.rpc('get_service_registry_context', { p_services: rows.slice(offset, offset + 200).map(s => s.id) })
        if (error) throw error
        contexts.push(...((data as RegistryContext[]) || []))
      }
      setRegistryContext(Object.fromEntries(contexts.map(c => [c.service_id, c])))
      setServices(rows)
      // Peso según APT (si la tabla aún no existe, la columna usa el KG manual)
      const { data: pData } = await supabase.from('contract_service_peso_apt').select('*')
      setPesoApt(Object.fromEntries(((pData as PesoApt[]) || []).map(p => [p.service_id, p])))

      const { data: cData, error: cError } = await supabase
        .from('contracts')
        .select(`
          id, code, type, parent_contract_id,
          clients(business_name),
          contract_budgets(balance_pen, concept)
        `)
        .eq('status', 'ACTIVO')
        .order('code')

      if (cError) throw cError
      setContracts((cData as unknown as Contract[]) || [])
      applyPreselect(((cData as unknown) as Contract[]) || [])
      const { data: canVoid } = await supabase.rpc('can_void_contract_service')
      setCanVoidDirect(canVoid === true)

      const { data: queue, error: queueError } = await supabase.rpc('get_dispatch_freight_reconciliation_queue')
      // Read-only roles can consult the registry without financial write access.
      setOrphanDispatches(queueError ? [] : ((queue as Dispatch[]) || []))

    } catch (error: unknown) {
      toast.error('Error al cargar datos: ' + errorMessage(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

  const handleSaveAmount = async () => {
    if (!viewingService) return
    setIsSavingAmount(true)
    try {
      const newAmount = parseFloat(editAmountValue)
      if (isNaN(newAmount) || newAmount < 0) {
        toast.error('Ingrese un monto válido')
        return
      }

      const { error } = await supabase.rpc('update_contract_service_amount', {
        p_service_id: viewingService.id,
        p_new_amount: newAmount
      })

      if (error) throw error

      toast.success('Monto actualizado correctamente')
      setIsEditingAmount(false)
      setViewingService({...viewingService, amount_pen: newAmount})
      fetchData()
    } catch (error: unknown) {
      console.error('Error updating amount:', error)
      toast.error('Error al actualizar: ' + errorMessage(error))
    } finally {
      setIsSavingAmount(false)
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
        p_category: newService.category,
        p_referral_guide: newService.referral_guide || null
      })

      if (error) throw error

      toast.success('Servicio registrado exitosamente.')
      setIsModalOpen(false)
      resetForm()
      fetchData()
    } catch (error: unknown) {
      toast.error('Error: ' + errorMessage(error))
    } finally {
      setIsSubmitting(false)
    }
  }


  const handleRegisterOrphan = async (dispatch: Dispatch) => {
    if (reconcilingDispatch) return
    setReconcilingDispatch(dispatch.id)
    try {
      const { data, error } = await supabase.rpc('reconcile_dispatch_freight', { p_dispatch: dispatch.id })
      if (error) throw error
      toast.success(data?.created ? 'Vínculo regularizado sin volver a descontar la partida' : 'El flete ya estaba vinculado')
      await fetchData()
    } catch (error: unknown) {
      toast.error('No se pudo regularizar: ' + (error instanceof Error ? error.message : String((error as { message?: string })?.message || error)))
    } finally {
      setReconcilingDispatch(null)
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
      category: 'Contrato',
      referral_guide: ''
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
        const json = XLSX.utils.sheet_to_json(worksheet) as Array<Record<string, string | number>>

        let successCount = 0
        let errorCount = 0

        for (const row of json) {
          const contractCodeUpload = String(row.Contrato || row.RUC_Contrato || row.Codigo_Contrato || '').replace(/^0+/, '');
          const contract = contracts.find(c => {
             return c.code.replace(/^0+/, '') === contractCodeUpload;
          })

          if (!contract) {
            errorCount++
            continue
          }

          let parsedDate = new Date().toISOString().split('T')[0];
          const rawDate = row.Fecha || row.Fecha_Servicio;
          if (typeof rawDate === 'number') {
            // Convert Excel serial date to JS Date
            parsedDate = new Date(Math.round((rawDate - 25569) * 86400 * 1000)).toISOString().split('T')[0];
          } else if (rawDate) {
            parsedDate = new Date(rawDate).toISOString().split('T')[0];
          }

          const { error } = await supabase.rpc('register_contract_service', {
            p_contract_id: contract.id,
            p_service_type: row.Servicio || row.Tipo_Servicio || 'OTROS',
            p_description: row.KG || row.Descripcion || '',
            p_amount_pen: parseFloat(String(row['Monto (PEN)'] || row.Monto)) || 0,
            p_service_date: parsedDate,
            p_plate: row.Placa || null,
            p_driver_name: row.Conductor || null,
            p_hours: row.Horas ? parseFloat(String(row.Horas)) : null,
            p_provider_ruc: row.Proveedor_RUC ? String(row.Proveedor_RUC) : null,
            p_provider_name: row.Proveedor_Nombre || null,
            p_category: row.Categoria || 'Contrato',
            p_referral_guide: row['Guía de Remisión'] || row.Guia_Remision || row.guia_remision || null
          })

          if (error) {
            errorCount++
          } else {
            successCount++
          }
        }

        toast.success(`Carga completada: ${successCount} exitosos, ${errorCount} errores.`)
        fetchData()
      } catch (err: unknown) {
        toast.error('Error procesando el archivo: ' + errorMessage(err))
      } finally {
        setIsUploading(false)
      }
    }
    reader.readAsArrayBuffer(file)
  }, [contracts])

  const { getRootProps, getInputProps } = useDropzone({
    onDrop,
    accept: {
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/vnd.ms-excel': ['.xls']
    },
    multiple: false
  })

  const actualizarPesoApt = async () => {
    setSyncingPeso(true)
    const { data, error } = await supabase.rpc('servicios_actualizar_peso_apt')
    setSyncingPeso(false)
    if (error || !data?.success) return toast.error(error?.message || data?.error || 'No se pudo actualizar el peso')
    const hasta = data.datos_apt_hasta ? ` · SALIDA de APT hasta ${new Date(`${String(data.datos_apt_hasta).slice(0, 10)}T12:00:00`).toLocaleDateString('es-PE')}` : ''
    toast.success(`Peso actualizado: ${data.con_peso} de ${data.con_guia} servicios con guía${data.con_guias_faltantes ? ` · ${data.con_guias_faltantes} con guías que no están en APT` : ''}${hasta}`)
    fetchData()
  }

  const filteredServices = services.filter(srv => {
    const searchString = `${srv.contracts?.code} ${srv.contracts?.clients?.business_name} ${srv.service_type} ${srv.category} ${srv.description} ${srv.plate} ${srv.driver_name} ${srv.provider_name} ${srv.provider_ruc} ${srv.referral_guide || ''}`.toLowerCase()
    const matchesSearch = searchTerm ? searchString.includes(searchTerm.toLowerCase()) : true
    
    const srvDate = new Date(srv.service_date)
    const dateFrom = filterDateFrom ? new Date(filterDateFrom) : null
    const dateTo = filterDateTo ? new Date(filterDateTo) : null
    
    // Set time to 0 to compare dates accurately
    srvDate.setUTCHours(0,0,0,0)
    if (dateFrom) dateFrom.setUTCHours(0,0,0,0)
    if (dateTo) dateTo.setUTCHours(0,0,0,0)

    const matchesDateFrom = dateFrom ? srvDate >= dateFrom : true
    const matchesDateTo = dateTo ? srvDate <= dateTo : true
    
    const matchesStatus = filterStatus === 'TODOS' ? true : stageOf(srv) === filterStatus
    
    return matchesSearch && matchesDateFrom && matchesDateTo && matchesStatus
  })

  // Orden de la tabla: por defecto fecha del servicio, más reciente primero (desempate por fecha de registro)
  const sortValue = (srv: ContractService, key: SortKey): string | number => {
    switch (key) {
      case 'fecha': return `${srv.service_date || ''} ${srv.created_at || ''}`
      case 'contrato': return srv.contracts?.code || ''
      case 'cliente': return srv.contracts?.clients?.business_name || ''
      case 'servicio': return srv.service_type || ''
      case 'placa': return srv.plate || ''
      case 'guia': return srv.referral_guide || ''
      case 'ton': return tonInfo(srv, pesoApt[srv.id]).ton ?? -1
      case 'monto': return Number(srv.amount_pen || 0)
      case 'traza': return registryContext[srv.id]?.dispatch_number || ''
      case 'estado': return stageLabels[stageOf(srv)]
    }
  }
  const sortedServices = [...filteredServices].sort((a, b) => {
    const x = sortValue(a, sort.key), y = sortValue(b, sort.key)
    const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'es', { numeric: true })
    return sort.dir === 'asc' ? cmp : -cmp
  })
  const toggleSort = (key: SortKey) =>
    setSort(prev => prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'fecha' || key === 'monto' ? 'desc' : 'asc' })
  const sortHeader = (label: string, k: SortKey, className = '') => (
    <th className={`font-semibold ${className}`} aria-sort={sort.key === k ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => toggleSort(k)} className={`inline-flex items-center gap-1 whitespace-nowrap uppercase hover:text-slate-800 ${sort.key === k ? 'text-slate-800' : ''}`}>
        {label}
        {sort.key === k ? (sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 opacity-40" />}
      </button>
    </th>
  )

  return (
    <div className="w-full mx-auto space-y-2.5">
      <PageHeader showTitle title="Registro de Servicios" description="Compromisos de transporte, servicios realizados y gastos adicionales vinculados a la OT. El cierre operativo no significa pago." actions={<>
        {canEdit && <>
          <button
            onClick={() => setIsOrphanModalOpen(true)}
            className={`flex h-10 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors ${orphanDispatches.length ? 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}
          >
            <AlertCircle className="w-4 h-4" />
            Regularizar vínculos ({orphanDispatches.length})
          </button>

          <div {...getRootProps()} className="flex cursor-pointer" title="Haga clic o arrastre aquí el Excel de la plantilla">
            <input {...getInputProps()} />
            <button
              className="pointer-events-none flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
              disabled={isUploading}
            >
              {isUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              {isUploading ? 'Procesando...' : 'Carga masiva'}
            </button>
          </div>

          <button
            onClick={() => setIsModalOpen(true)}
            className="flex h-10 items-center gap-2 rounded-lg bg-jrm-navy px-4 font-medium text-white shadow-sm transition-colors hover:bg-jrm-navy-dark"
          >
            <Plus className="w-4 h-4" />
            Registrar Servicio
          </button>
          <TableActions label="Más acciones del registro" actions={[
            { id: 'peso', label: syncingPeso ? 'Actualizando peso (APT)…' : 'Actualizar peso (APT)', icon: syncingPeso ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />, disabled: syncingPeso, onSelect: actualizarPesoApt },
            { id: 'plantilla', label: 'Descargar plantilla Excel', icon: <Download className="h-4 w-4" />, onSelect: downloadTemplate },
          ]} />
        </>}
        <TorreControlButton />
      </>} />
      <div className="flex flex-wrap items-center gap-2">
        <TransportWorkflow current="registro" torre={false} />
        <div className="ml-auto min-w-0">
          <InlineStatusBar label="Resumen por etapa (filtra la tabla)" active={filterStatus} loading={loading} onChange={setFilterStatus}
            items={([['TODOS', 'Todos', Layers, 'navy'], ['COMPROMETIDO', 'Comprometidos', Clock, 'amber'], ['REALIZADO', 'Realizados', CheckCircle2, 'emerald'], ['REGISTRO_MANUAL', 'Manuales', FileEdit, 'slate'], ['ANULADO', 'Anulados', Ban, 'rose']] as const)
              .map(([key, label, Icon, tone]) => ({ key, label, icon: <Icon />, tone, count: key === 'TODOS' ? services.length : services.filter(srv => stageOf(srv) === key).length }))} />
        </div>
      </div>

      {/* Filtros, búsqueda y saldo de partida en una fila */}
      <FilterToolbar compact label="Búsqueda y filtros de servicios" onClear={() => { setSearchTerm(''); setFilterDateFrom(''); setFilterDateTo(''); setFilterStatus('TODOS') }}>
        <label className="relative min-w-0 flex-1 basis-56">
          <span className="sr-only">Buscar servicios</span><Search aria-hidden className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" />
          <input type="search" placeholder="Buscar por contrato, cliente, placa, etc..." className={`${filterControl} pl-9`} value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
        </label>
        <FilterField inline label="Desde" className="w-48"><input type="date" className={filterControl} value={filterDateFrom} onChange={(e) => setFilterDateFrom(e.target.value)} /></FilterField>
        <FilterField inline label="Hasta" className="w-48"><input type="date" className={filterControl} value={filterDateTo} onChange={(e) => setFilterDateTo(e.target.value)} /></FilterField>
        <span className="ml-auto whitespace-nowrap text-xs text-slate-500" aria-live="polite">{loading ? '' : `${filteredServices.length} servicio(s)`}</span>
      </FilterToolbar>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-jrm border border-jrm-line bg-jrm-surface px-3 py-2 shadow-jrm-card">
        <label htmlFor="registry-budget" className="flex items-center gap-2 whitespace-nowrap text-sm font-semibold text-jrm-navy"><Scale className="h-4 w-4" aria-hidden="true" />Disponible de la partida · OT</label>
        <select id="registry-budget" value={budgetContract} onChange={e => setBudgetContract(e.target.value)} className={`${filterControl} w-full sm:w-72`}>
          <option value="">Seleccionar OT para consultar su saldo actual</option>
          {contracts.map(c => <option key={c.id} value={c.id}>{c.code}{typeTag(c.type)}</option>)}
        </select>
        {budgetContract ? (() => {
          const budget = partidaOf(budgetContract)
          return <p className="text-sm text-slate-600" title="El saldo actual considera el 80 % operativo menos reservas y consumos. No es un saldo histórico por servicio.">{budget ? <>OT que financia: <strong>{budget.owner.code}</strong> · Disponible actual: <strong>S/ {budget.balance.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</strong></> : 'Sin partida de transporte disponible'}</p>
        })() : null}
        <span className="inline-flex items-center gap-1 text-xs text-slate-500" title="El saldo actual considera el 80 % operativo menos reservas y consumos. No es un saldo histórico por servicio."><Info className="h-3.5 w-3.5" aria-hidden="true" />80 % operativo menos reservas y consumos</span>
      </div>

      {/* Lista de Servicios */}
      <div className="overflow-hidden rounded-jrm border border-jrm-line bg-jrm-surface shadow-jrm-card">
        <div className="overflow-auto max-h-[calc(100vh-250px)]">
          <DataTable dense className="relative w-full border-collapse text-left 2xl:[&_td]:!px-3 2xl:[&_th]:!px-3 [&_td]:!px-2 [&_th]:!px-2">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase sticky top-0 z-10 shadow-[0_1px_0_0_#e2e8f0]">
              <tr>
                <th className="hidden w-12 text-center font-semibold 2xl:table-cell">N°</th>
                {sortHeader('Fecha', 'fecha')}
                {sortHeader('OT', 'contrato')}
                {sortHeader('Cliente', 'cliente')}
                {sortHeader('Servicio', 'servicio')}
                {sortHeader('Placa', 'placa')}
                {sortHeader('Guía', 'guia')}
                {sortHeader('TON', 'ton', 'text-right')}
                {sortHeader('Monto S/', 'monto', 'text-right')}
                {sortHeader('Despacho', 'traza')}
                {sortHeader('Estado', 'estado', 'text-center')}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={11} className="p-8 text-center text-slate-500">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                    Cargando servicios...
                  </td>
                </tr>
              ) : filteredServices.length === 0 ? (
                <tr>
                  <td colSpan={11} className="p-8 text-center text-slate-500">
                    No hay servicios registrados o que coincidan con los filtros.
                  </td>
                </tr>
              ) : (
                sortedServices.map((srv, idx) => {
                  const stage = stageOf(srv);
                  const context = registryContext[srv.id];
                  const correlative = filteredServices.length - idx;
                  return (
                  <tr 
                    key={srv.id} 
                    onClick={() => setViewingService(srv)}
                    className={`cursor-pointer transition-colors ${srv.status === 'ANULADO' ? 'bg-slate-200/70 text-slate-400 hover:bg-slate-200 [&_td]:opacity-70' : 'hover:bg-slate-50'}`}
                    title={srv.status === 'ANULADO' ? `Anulado${srv.void_reason ? `: ${srv.void_reason}` : ''}` : undefined}
                  >
                    <td className="hidden 2xl:table-cell text-sm font-bold text-slate-400 text-center">
                      {correlative}
                    </td>
                    <td className="whitespace-nowrap text-sm text-slate-600">
                      {srv.service_date ? new Date(`${srv.service_date.slice(0, 10)}T12:00:00`).toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—'}
                    </td>
                    <td className="whitespace-nowrap text-sm font-bold text-jrm-navy">{srv.contracts?.code || '—'}</td>
                    <td className="max-w-32 truncate text-sm text-slate-700 xl:max-w-40 2xl:max-w-64" title={srv.contracts?.clients?.business_name || undefined}>{srv.contracts?.clients?.business_name || 'Sin cliente'}</td>
                    <td>
                      <span className="px-2 py-1 bg-slate-100 text-slate-700 rounded text-xs font-semibold w-fit block">
                        {srv.service_type}
                      </span>
                    </td>
                    <td className="text-sm font-medium text-slate-800">
                      {srv.plate || '-'}
                    </td>
                    <td className="text-sm text-slate-700">
                      {srv.referral_guide ? (() => {
                        const guias = srv.referral_guide.split(',').map(g => g.trim()).filter(Boolean)
                        return <span className="inline-flex items-center gap-1 whitespace-nowrap">
                          <button type="button" title="Ver los SKUs de la guía" onClick={e => { e.stopPropagation(); setGuiaAbierta(guias[0]) }}
                            className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-xs font-semibold text-blue-700 underline-offset-2 hover:bg-blue-100 hover:underline">{guias[0]}</button>
                          {guias.length > 1 && <span className="text-xs font-semibold text-slate-500" title={`Otras guías: ${guias.slice(1).join(', ')} (ver en el detalle)`}>+{guias.length - 1}</span>}
                        </span>
                      })() : <span className="text-slate-400">-</span>}
                    </td>
                    <td className="text-right text-sm font-medium text-slate-800">
                      {(() => {
                        const p = pesoApt[srv.id]
                        const t = tonInfo(srv, p)
                        if (t.fuente === 'APT') return (
                          <span className={`whitespace-nowrap font-bold ${p.faltan ? 'text-amber-700' : 'text-slate-900'}`} title={`Peso APT de ${p.encontradas} guía(s) en la SALIDA de Almacén APT${p.faltan ? ` · faltan ${p.faltan.split(',').length}: ${p.faltan}` : ''}`}>{fmtTon(Number(p.kg))}</span>
                        )
                        if (t.fuente === 'MANUAL') return (
                          <span className={`whitespace-nowrap ${p ? 'text-amber-700' : 'text-slate-700'}`} title={p ? `Manual: las guías no están en la SALIDA de APT (${p.faltan || p.guias}); se muestra el KG escrito a mano` : 'Manual: KG escrito a mano (sin guía)'}>{fmtTon(Number(srv.description))}</span>
                        )
                        return p ? <span className="text-[11px] text-amber-600" title={`No encontradas en APT: ${p.faltan || p.guias}`}>guía sin APT</span> : <span className="text-slate-400">Sin peso sustentado</span>
                      })()}
                    </td>
                    <td className={`whitespace-nowrap text-sm font-bold text-right ${srv.status === 'ANULADO' ? 'text-slate-400 line-through' : 'text-slate-900'}`}>
                      {Number(srv.amount_pen).toLocaleString('es-PE', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="text-sm">
                      {context?.dispatch_number ? <a href={`/torre-control?despacho=${srv.dispatch_id}`} onClick={e => e.stopPropagation()} title={context.request_numbers?.length ? `Solicitudes: ${context.request_numbers.join(' · ')}` : undefined} className="whitespace-nowrap font-semibold text-[#002855] underline">{context.dispatch_number}</a> : <span className="whitespace-nowrap text-slate-400">Sin despacho</span>}
                    </td>
                    <td className="text-center">
                      <span title={`Estado financiero: ${srv.status}`}><StatusBadge tone={stageTone[stage]}>{stageLabels[stage]}</StatusBadge></span>
                    </td>
                  </tr>
                )})
              )}
            </tbody>
          </DataTable>
        </div>
      </div>

      <Modal
        isOpen={isOrphanModalOpen}
        onClose={() => setIsOrphanModalOpen(false)}
        title="Regularización de vínculos de flete"
        maxWidth="max-w-4xl"
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Restablece el vínculo económico de fletes ya imputados a una partida. No vuelve a reservar ni consumir el monto. Las imputaciones inconsistentes requieren revisión y no se regularizan automáticamente.
          </p>
          <div className="overflow-auto max-h-[500px]">
            <DataTable className="w-full text-left border-collapse">
              <thead className="bg-slate-50 text-slate-500 text-xs sticky top-0 uppercase">
                <tr>
                  <th className="p-3 font-semibold">Despacho</th>
                  <th className="p-3 font-semibold">Contrato</th>
                  <th className="p-3 font-semibold">Unidad / Chofer</th>
                  <th className="p-3 font-semibold text-right">Flete Detectado</th>
                  <th className="p-3 font-semibold text-right">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {orphanDispatches.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-6 text-center text-slate-500">
                      No hay vínculos de flete pendientes de regularización.
                    </td>
                  </tr>
                ) : (
                  orphanDispatches.map(d => (
                    <tr key={d.id} className="hover:bg-slate-50">
                      <td className="p-3">
                        <span className="font-bold text-[#002855] text-sm">{d.dispatch_number}</span>
                      </td>
                      <td className="p-3 text-sm">
                        <div className="font-semibold text-slate-800">{d.contracts?.code}</div>
                        <div className="text-xs text-slate-500">{d.contracts?.clients?.business_name}</div>
                      </td>
                      <td className="p-3 text-sm">
                        <div className="font-semibold text-slate-800">{d.vehicle_plate}</div>
                        <div className="text-xs text-slate-500">{d.driver_name}</div>
                      </td>
                      <td className="p-3 text-sm font-bold text-right text-emerald-700">
                        S/ {Number(d.freight_cost || 0).toLocaleString('es-PE', { minimumFractionDigits: 2 })}
                      </td>
                      <td className="p-3 text-right">
                        <button
                          onClick={() => handleRegisterOrphan(d)}
                          disabled={reconcilingDispatch !== null || !d.freight_cost || d.freight_cost <= 0}
                          className="px-3 py-1.5 bg-[#002855] text-white rounded text-xs font-medium hover:bg-[#001d3d] disabled:opacity-50"
                        >
                          {reconcilingDispatch === d.id ? 'Regularizando…' : 'Regularizar vínculo'}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </DataTable>
          </div>
        </div>
      </Modal>

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
                onChange={(e) => {
                  const picked = contracts.find(c => c.id === e.target.value)
                  setNewService({...newService, contract_id: e.target.value, category: categoryOf(picked?.type)})
                }}
              >
                <option value="" disabled>Seleccione OT, subcontrato o error...</option>
                {contracts.map(c => {
                  const partida = partidaOf(c.id)
                  return (
                    <option key={c.id} value={c.id}>
                      {c.code}{typeTag(c.type)} - {c.clients?.business_name || 'Sin cliente'} ({partida ? `Saldo: S/ ${partida.balance.toLocaleString('es-PE')}` : 'sin partida'})
                    </option>
                  )
                })}
              </select>
              {newService.contract_id && (() => {
                const partida = partidaOf(newService.contract_id)
                const inherited = partida && partida.owner.id !== newService.contract_id
                if (!partida) return (
                  <div className="mt-1.5 flex items-center gap-1.5 text-xs font-semibold text-red-600">
                    <Ban className="w-3.5 h-3.5" />Sin partida de transporte: asígnela en el contrato madre
                  </div>
                )
                return (
                  <div className={`mt-1.5 flex items-center gap-1.5 text-xs font-semibold ${partida.balance <= 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                    {partida.balance <= 0 ? <Ban className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
                    {partida.balance <= 0 ? 'Partida agotada o negativa' : 'Partida disponible'}: S/ {partida.balance.toLocaleString('es-PE', { minimumFractionDigits: 2 })}
                    {inherited && <span className="font-normal text-slate-500">· descuenta la partida de {partida.owner.code}</span>}
                  </div>
                )
              })()}
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
                  <option value="GRUA">Grúa</option>
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
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1">Guías de Remisión (Opcional)</label>
                  <input 
                    type="text"
                    placeholder="Ej. T001-123, T001-124"
                    className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                    value={newService.referral_guide}
                    onChange={(e) => setNewService({...newService, referral_guide: e.target.value})}
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
              <label className="block text-sm font-medium text-slate-700 mb-1">KG</label>
              <textarea 
                rows={2}
                placeholder="Cantidad en KG o detalles adicionales..."
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

      <Modal
        isOpen={!!viewingService}
        onClose={() => setViewingService(null)}
        title="Detalles del Servicio Registrado"
        maxWidth="max-w-lg"
      >
        {viewingService && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-slate-50 p-3 rounded border border-slate-200">
                <span className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Contrato</span>
                <span className="font-bold text-slate-800">{viewingService.contracts?.code}</span>
              </div>
              <div className="bg-slate-50 p-3 rounded border border-slate-200">
                <span className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Tipo de Servicio</span>
                <span className="font-bold text-[#002855]">{viewingService.service_type}</span>
              </div>
              <div className="bg-slate-50 p-3 rounded border border-slate-200">
                <span className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Despacho y solicitudes</span>
                <span className="font-bold text-slate-800">{registryContext[viewingService.id]?.dispatch_number || 'Sin despacho'}</span>
                <span className="block text-xs text-slate-600">{registryContext[viewingService.id]?.request_numbers?.join(' · ') || 'Sin solicitudes vinculadas'}</span>
              </div>
              <div className="bg-slate-50 p-3 rounded border border-slate-200">
                <span className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Estado</span>
                <span className="font-bold text-slate-800">{stageLabels[stageOf(viewingService)]}</span>
                <span className="block text-xs text-slate-600">Financiero: {viewingService.status}</span>
              </div>
            </div>

            <div className="bg-white p-3 rounded border border-slate-200">
              <span className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Guías de Remisión</span>
              {viewingService.referral_guide ? (
                <div className="flex flex-wrap gap-2 mt-1">
                  {viewingService.referral_guide.split(',').map((gr: string, idx: number) => (
                    <button key={idx} type="button" onClick={() => setGuiaAbierta(gr.trim())} title="Ver los SKUs de la guía"
                      className="px-2 py-1 bg-blue-50 text-blue-700 border border-blue-200 rounded text-sm font-semibold hover:bg-blue-100 hover:underline">
                      {gr.trim()}
                    </button>
                  ))}
                  {viewingService.referral_guide.split(',').filter((x: string) => x.trim()).length > 1 && (
                    <button type="button" onClick={() => setGuiaAbierta(viewingService.referral_guide || null)}
                      className="px-2 py-1 rounded text-sm font-bold text-[#002855] hover:underline">Ver todas</button>
                  )}
                </div>
              ) : (
                <span className="text-slate-400 text-sm italic">Sin guías registradas</span>
              )}
            </div>

            <div className="bg-white p-3 rounded border border-slate-200">
              <span className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Detalle / KG</span>
              <p className="text-slate-800 text-sm whitespace-pre-wrap">{viewingService.description || '-'}</p>
            </div>

            {pesoApt[viewingService.id] && (() => {
              const p = pesoApt[viewingService.id]
              return (
                <div className={`p-3 rounded border ${p.faltan ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50'}`}>
                  <span className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-slate-500"><Scale className="h-3.5 w-3.5" />Peso según Almacén APT (SALIDA)</span>
                  <p className="text-sm text-slate-800">
                    <b>{p.kg != null ? `${fmtTon(Number(p.kg))} t` : 'Sin peso'}</b>
                    {p.kg != null && <span className="text-slate-500"> ({Number(p.kg).toLocaleString('es-PE')} kg)</span>}
                    {' · '}{p.encontradas} guía(s) encontrada(s)
                  </p>
                  {p.faltan && <p className="text-xs text-amber-800">No encontradas en la SALIDA de APT: {p.faltan}. Revise el número de guía o cargue la SALIDA que la contiene.</p>}
                  <p className="text-[11px] text-slate-500">Calculado el {new Date(p.calculado_at).toLocaleString('es-PE')}</p>
                </div>
              )
            })()}

            {(viewingService.plate || viewingService.driver_name) && (
              <div className="grid grid-cols-2 gap-4 bg-slate-50 p-3 rounded border border-slate-200">
                <div>
                  <span className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Placa</span>
                  <span className="text-slate-800 text-sm">{viewingService.plate || '-'}</span>
                </div>
                <div>
                  <span className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Conductor</span>
                  <span className="text-slate-800 text-sm">{viewingService.driver_name || '-'}</span>
                </div>
              </div>
            )}

            {(viewingService.provider_name || viewingService.provider_ruc) && (
              <div className="bg-amber-50 p-3 rounded border border-amber-200">
                <span className="block text-xs font-semibold text-amber-700 uppercase tracking-wider mb-1">Tercerizado a Proveedor</span>
                <p className="text-amber-900 font-medium text-sm">{viewingService.provider_name}</p>
                <p className="text-amber-800 text-xs">RUC: {viewingService.provider_ruc}</p>
              </div>
            )}

            <div className="flex justify-between items-center bg-emerald-50 p-3 rounded border border-emerald-200">
              <span className="block text-sm font-semibold text-emerald-800">Monto del Servicio</span>
              {isEditingAmount ? (
                <div className="flex items-center gap-2">
                  <span className="text-emerald-700 font-bold">S/</span>
                  <input
                    type="number"
                    step="0.01"
                    className="w-24 px-2 py-1 border border-emerald-300 rounded text-right font-bold text-emerald-700 outline-none focus:ring-2 focus:ring-emerald-500"
                    value={editAmountValue}
                    onChange={(e) => setEditAmountValue(e.target.value)}
                    autoFocus
                  />
                  <button 
                    onClick={handleSaveAmount}
                    disabled={isSavingAmount}
                    className="p-1.5 bg-emerald-600 text-white rounded hover:bg-emerald-700 transition-colors disabled:opacity-50"
                    title="Guardar"
                  >
                    {isSavingAmount ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  </button>
                  <button 
                    onClick={() => setIsEditingAmount(false)}
                    className="p-1.5 bg-white text-slate-500 rounded border border-slate-300 hover:bg-slate-50 transition-colors"
                    title="Cancelar"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <span className={`font-bold text-lg ${viewingService.status === 'ANULADO' ? 'text-slate-400 line-through' : 'text-emerald-700'}`}>S/ {Number(viewingService.amount_pen).toLocaleString('es-PE', { minimumFractionDigits: 2 })}</span>
                  {canEdit && viewingService.status !== 'ANULADO' && <button 
                    onClick={() => {
                      setEditAmountValue(viewingService.amount_pen.toString());
                      setIsEditingAmount(true);
                    }}
                    className="px-2 py-1 text-xs font-medium bg-emerald-100 text-emerald-700 rounded hover:bg-emerald-200 transition-colors"
                  >
                    Editar
                  </button>}
                </div>
              )}
            </div>

            {viewingService.status === 'ANULADO' ? (
              <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                <span className="font-semibold">Anulado.</span> {viewingService.void_reason || ''} El monto volvió a la partida.
              </div>
            ) : canEdit && !viewingService.dispatch_id && (
              <div className="rounded border border-slate-200 p-3">
                <span className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Anular gasto (devuelve el monto a la partida)</span>
                {!canVoidDirect && (
                  <div className="mb-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                    <p className="mb-1.5 font-semibold">Requiere autorización del Administrador o del Jefe de Distribución</p>
                    <div className="grid grid-cols-2 gap-2">
                      <input type="email" value={authEmail} onChange={e => setAuthEmail(e.target.value)} placeholder="Correo de quien autoriza"
                        autoComplete="off" className="rounded border border-amber-300 bg-white px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-amber-400" />
                      <input type="password" value={authPassword} onChange={e => setAuthPassword(e.target.value)} placeholder="Contraseña"
                        autoComplete="new-password" className="rounded border border-amber-300 bg-white px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-amber-400" />
                    </div>
                  </div>
                )}
                <div className="flex gap-2">
                  <input value={voidReason} onChange={e => setVoidReason(e.target.value)} placeholder="Motivo: duplicado, monto errado, no corresponde…"
                    className="flex-1 rounded border border-slate-300 px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-red-400" />
                  <button type="button" onClick={handleVoid} disabled={isVoiding}
                    className="inline-flex items-center gap-1 rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">
                    {isVoiding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ban className="w-4 h-4" />}Anular
                  </button>
                </div>
              </div>
            )}

            <div className="flex justify-end pt-4 border-t border-slate-100">
              <button
                onClick={() => { setViewingService(null); setIsEditingAmount(false); setVoidReason(''); setAuthPassword(''); }}
                className="px-4 py-2 bg-[#002855] text-white rounded-lg font-medium hover:bg-[#001d3d] transition-colors"
              >
                Cerrar
              </button>
            </div>
          </div>
        )}
      </Modal>

      <GuiaDetalleModal key={guiaAbierta || 'none'} guias={guiaAbierta} onClose={() => setGuiaAbierta(null)} />
    </div>
  )
}
