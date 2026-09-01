"use client"
import { useState, useEffect } from 'react'
import { Plus, FileText, Search, Filter, Loader2, Edit2, Calendar, Upload, Download, UserPlus } from 'lucide-react'
import * as XLSX from 'xlsx'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { ClientFormModal, ClientData } from '@/components/forms/ClientFormModal'
import { UserFormModal, UserData } from '@/components/forms/UserFormModal'

interface WorkOrder {
  id: string
  ot_number: string
  client_id: string
  origin: string
  destination: string
  cargo_details: string
  status: string
  created_at: string
  budget_amount?: number
  parent_work_order_id?: string | null
  clients?: {
    business_name: string
    ruc: string
    tax_id?: string
  }
}

interface OTItem {
  id: string
  sku: string
  description: string
  quantity: number
  unit_weight: number
  total_weight: number
}

interface Client {
  id: string
  business_name: string
  ruc?: string
  tax_id?: string
}

interface Profile {
  id: string
  first_name: string
  last_name: string
}

interface Budget {
  id: string
  code: string
  description: string
  budget_limit: number
}

export default function OTPage() {
  const supabase = createClient()
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [budgets, setBudgets] = useState<Budget[]>([])
  const [roles, setRoles] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isExtensionModalOpen, setIsExtensionModalOpen] = useState(false)
  const [isClientModalOpen, setIsClientModalOpen] = useState(false)
  const [isAdminModalOpen, setIsAdminModalOpen] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  
  // View OT State
  const [isViewModalOpen, setIsViewModalOpen] = useState(false)
  const [selectedOTForView, setSelectedOTForView] = useState<any>(null)
  const [viewOTItems, setViewOTItems] = useState<any[]>([])
  const [isLoadingItems, setIsLoadingItems] = useState(false)
  const [selectedOTForExtension, setSelectedOTForExtension] = useState<WorkOrder | null>(null)
  
  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false)
  const [selectedOTForTransfer, setSelectedOTForTransfer] = useState<WorkOrder | null>(null)
  const [transferAdminId, setTransferAdminId] = useState('')
  const [transferReason, setTransferReason] = useState('')

  const [extensionData, setExtensionData] = useState({
    amount: '',
    reason: ''
  })
  
  const [partidaSearch, setPartidaSearch] = useState('')
  const [clientSearch, setClientSearch] = useState('')
  const [adminSearch, setAdminSearch] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  
  const initialOTState: {
    ot_number: string
    client_id: string
    contract_administrator_id: string
    budget_amount: string
    parent_work_order_id: string | null
    origin: string
    origin_department: string
    origin_province: string
    origin_district: string
    destination: string
    destination_department: string
    destination_province: string
    destination_district: string
    delivery_address: string
    cargo_details: string
    required_date: string
  } = {
    ot_number: '',
    client_id: '',
    contract_administrator_id: '',
    budget_amount: '',
    parent_work_order_id: null,
    origin: 'Planta Chilca',
    origin_department: 'LIMA',
    origin_province: 'CAÑETE',
    origin_district: 'CHILCA',
    destination: '',
    destination_department: '',
    destination_province: '',
    destination_district: '',
    delivery_address: '',
    cargo_details: '',
    required_date: ''
  }

  const [newOT, setNewOT] = useState(initialOTState)
  const [otItems, setOtItems] = useState<OTItem[]>([])

  const handleAddItem = () => {
    setOtItems([...otItems, {
      id: Math.random().toString(36).substring(7),
      sku: '',
      description: '',
      quantity: 1,
      unit_weight: 0,
      total_weight: 0
    }])
  }

  const handleRemoveItem = (id: string) => {
    setOtItems(otItems.filter(item => item.id !== id))
  }

  const handleItemChange = (id: string, field: keyof OTItem, value: any) => {
    setOtItems(otItems.map(item => {
      if (item.id === id) {
        const updatedItem = { ...item, [field]: value }
        if (field === 'quantity' || field === 'unit_weight') {
          updatedItem.total_weight = Number(updatedItem.quantity) * Number(updatedItem.unit_weight)
        }
        return updatedItem
      }
      return item
    }))
  }

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    setLoading(true)
    try {
      // Fetch OTs
      const { data: otData, error: otError } = await supabase
        .from('work_orders')
        .select('*, clients(business_name, tax_id)')
        .order('created_at', { ascending: false })

      if (otError) throw otError
      setWorkOrders(otData || [])

      // Fetch Clients for dropdown
      const { data: clientData, error: clientError } = await supabase
        .from('clients')
        .select('id, business_name, tax_id')
        .order('business_name', { ascending: true })

      if (clientError) throw clientError
      setClients(clientData || [])

      // Fetch Profiles (Contract Administrators)
      const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .select('id, first_name, last_name')
        .eq('is_active', true)

      if (profileError) throw profileError
      setProfiles(profileData || [])

      // Fetch Budgets (Partidas)
      const { data: budgetData, error: budgetError } = await supabase
        .from('transport_budgets')
        .select('id, code, description, budget_limit')
        .eq('status', 'ACTIVE')

      if (budgetError) throw budgetError
      setBudgets(budgetData || [])

      // Fetch roles for the admin creation modal
      const { data: rolesData, error: rolesError } = await supabase
        .from('roles')
        .select('id, name')
      
      if (rolesError) throw rolesError
      setRoles(rolesData || [])

    } catch (error: any) {
      toast.error('Error al cargar datos: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  const handleTransferOT = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedOTForTransfer || !transferAdminId) return
    setIsSubmitting(true)
    
    try {
      const { error } = await supabase
        .from('work_orders')
        .update({ contract_administrator_id: transferAdminId })
        .eq('id', selectedOTForTransfer.id)

      if (error) throw error

      toast.success(`OT transferida exitosamente`)
      setIsTransferModalOpen(false)
      fetchData()
    } catch (error: any) {
      toast.error('Error al transferir OT: ' + error.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCreateOT = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)

    const otNumber = newOT.ot_number.trim()
    if (!otNumber) {
      toast.error('Por favor, ingresa el número de OT')
      setIsSubmitting(false)
      return
    }

    if (otItems.length === 0) {
      toast.error('Por favor, ingresa al menos un ítem para la carga')
      setIsSubmitting(false)
      return
    }

    // Validar que si es un subcontrato, la partida no sea inferior a la OT madre
    if (newOT.parent_work_order_id && newOT.budget_amount) {
      const parentOT = workOrders.find(ot => ot.id === newOT.parent_work_order_id)
      if (parentOT && Number(newOT.budget_amount) < (parentOT.budget_amount || 0)) {
        toast.error('El presupuesto del subcontrato no puede ser menor al de la OT madre')
        setIsSubmitting(false)
        return
      }
    }

    try {
      const { data, error } = await supabase
        .from('work_orders')
        .insert([{ 
          ot_number: otNumber,
          client_id: newOT.client_id,
          contract_administrator_id: newOT.contract_administrator_id || null,
          budget_amount: newOT.budget_amount ? Number(newOT.budget_amount) : 0,
          parent_work_order_id: newOT.parent_work_order_id || null,
          origin: newOT.origin,
          origin_address: newOT.origin || 'Planta Chilca',
          origin_department: newOT.origin_department,
          origin_province: newOT.origin_province,
          origin_district: newOT.origin_district,
          destination: newOT.destination,
          destination_address: newOT.destination,
          destination_department: newOT.destination_department,
          destination_province: newOT.destination_province,
          destination_district: newOT.destination_district,
          required_date: newOT.required_date ? new Date(newOT.required_date).toISOString() : new Date().toISOString(),
          cargo_details: `OT con ${otItems.length} ítems. Peso total estimado: ${otItems.reduce((acc, item) => acc + item.total_weight, 0).toFixed(2)}`,
          status: 'GENERADA'
        }])
        .select()
        .single()
        
      if (error) throw error

      if (data && otItems.length > 0) {
        const itemsToInsert = otItems.map(item => ({
          work_order_id: data.id,
          sku: item.sku,
          description: item.description,
          quantity: item.quantity,
          unit_weight: item.unit_weight,
          total_weight: item.total_weight
        }))

        const { error: itemsError } = await supabase
          .from('work_order_items')
          .insert(itemsToInsert)

        if (itemsError) {
          console.error("Error guardando ítems:", itemsError)
          toast.error("OT creada pero hubo un error al guardar los ítems.")
        }
      }
      
      toast.success('Orden de Trabajo generada correctamente')
      setIsModalOpen(false)
      setNewOT(initialOTState)
      setOtItems([])
      setPartidaSearch('')
      fetchData()
    } catch (error: any) {
      toast.error('Error al generar OT: ' + error.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleBulkUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setIsUploading(true)
    try {
      const arrayBuffer = await file.arrayBuffer()
      const workbook = XLSX.read(arrayBuffer, { type: 'array' })
      const firstSheetName = workbook.SheetNames[0]
      const worksheet = workbook.Sheets[firstSheetName]
      if (!worksheet) throw new Error("El archivo Excel no tiene hojas de cálculo")

      const rawData: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1, blankrows: true })
      let processedCount = 0
      const otMap = new Map<string, any>()
      let currentOTNumber = ''

      let pendingItems: any[] = []
      
      // Encontrar dinámicamente la fila de inicio (después de los encabezados)
      let startIndex = 6; // Por defecto fila 7 (index 6)
      for (let i = 0; i < rawData.length; i++) {
        if (rawData[i] && rawData[i][0]) {
          const val = rawData[i][0].toString().trim();
          if (val === "Número de OT" || val === "N° de OT") {
            startIndex = i + 1;
            break;
          }
        }
      }

      for (let i = startIndex; i < rawData.length; i++) {
        const row = rawData[i]
        if (!row || row.length === 0) continue
        
        const rowOtNumber = row[0]?.toString()?.trim()
        if (rowOtNumber) {
          currentOTNumber = rowOtNumber
        }

        const skuStr = row[8]?.toString()?.trim()
        const descStr = row[9]?.toString()?.trim()
        
        // Solo procesamos si hay al menos un SKU o una descripción válida
        if (skuStr || descStr) {
           const item = {
             sku: skuStr || '',
             description: descStr || 'Ítem sin descripción',
             quantity: Number(row[10]) || 1,
             unit_weight: Number(row[11]) || 0,
             total_weight: Number(row[12]) || 0
           }
           
           if (currentOTNumber) {
             if (!otMap.has(currentOTNumber)) {
               otMap.set(currentOTNumber, {
                 ot_number: currentOTNumber,
                 client_ruc: row[1]?.toString() || '',
                 client_name: row[2]?.toString() || '',
                 admin_name: row[3]?.toString() || '',
                 budget_amount: Number(row[4]) || 0,
                 origin: row[5]?.toString() || '',
                 destination: row[6]?.toString() || '',
                 required_date: row[7]?.toString() || '',
                 items: [...pendingItems, item] // Flush pending items if any
               })
               pendingItems = []
               processedCount++
             } else {
               // Agrega items pendientes y el item actual
               if (pendingItems.length > 0) {
                 otMap.get(currentOTNumber).items.push(...pendingItems)
                 pendingItems = []
               }
               otMap.get(currentOTNumber).items.push(item)
             }
           } else {
             // Si aún no tenemos OT number, lo guardamos en pendientes
             pendingItems.push(item)
           }
        }
      }
      
      if (processedCount === 0) throw new Error("No se encontraron registros válidos a partir de la fila 7.")
      
      let insertedCount = 0
      for (const ot of otMap.values()) {
        const client = clients.find(c => c.tax_id === ot.client_ruc?.toString().trim())
        
        if (!client) {
          throw new Error(`El RUC ${ot.client_ruc} para la OT ${ot.ot_number} no está registrado en el sistema. Regístralo primero.`)
        }

        const adminStr = ot.admin_name?.toString().toLowerCase().trim()
        const admin = profiles.find(p => `${p.first_name} ${p.last_name}`.toLowerCase() === adminStr)
        
        const cargoDesc = `OT Masiva con ${ot.items.length} ítems. Peso total: ${ot.items.reduce((acc: number, item: any) => acc + item.total_weight, 0).toFixed(2)}`
        const { data: insertedOT, error: otError } = await supabase
          .from('work_orders')
          .insert([{
            ot_number: ot.ot_number,
            client_id: client.id,
            contract_administrator_id: admin?.id || null,
            budget_amount: ot.budget_amount,
            origin: ot.origin || 'Planta Chilca',
            origin_address: ot.origin || 'Planta Chilca',
            destination: ot.destination,
            destination_address: ot.destination,
            required_date: ot.required_date ? new Date(ot.required_date).toISOString() : new Date().toISOString(),
            cargo_details: cargoDesc,
            status: 'GENERADA'
          }])
          .select()
          .single()

        if (otError) {
          console.error("Error insertando OT masiva:", otError)
          throw new Error(`Error al insertar OT ${ot.ot_number}: ${otError.message}`)
        }

        if (insertedOT) {
          const itemsToInsert = ot.items.map((item: any) => ({
            work_order_id: insertedOT.id,
            sku: item.sku,
            description: item.description,
            quantity: item.quantity,
            unit_weight: item.unit_weight,
            total_weight: item.total_weight
          }))
          const { error: itemsError } = await supabase.from('work_order_items').insert(itemsToInsert)
          if (itemsError) {
            console.error("Error insertando items:", itemsError)
            throw new Error(`Error al insertar ítems de la OT ${ot.ot_number}: ${itemsError.message}`)
          }
        }
        insertedCount++
      }
      toast.success(`${insertedCount} OTs procesadas y guardadas correctamente.`)
      fetchData()
    } catch (error: any) {
      toast.error("Error en la carga masiva: " + error.message)
    } finally {
      setIsUploading(false)
      e.target.value = ''
    }
  }

  const downloadTemplate = () => {
    const link = document.createElement("a")
    link.href = "/Plantilla_Carga_Masiva_OT.xlsx"
    link.download = "Plantilla_Carga_Masiva_OT.xlsx"
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const handleRequestExtension = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedOTForExtension) return
    setIsSubmitting(true)
    try {
      const { error } = await supabase
        .from('budget_extensions')
        .insert([{
          work_order_id: selectedOTForExtension.id,
          requested_amount: parseFloat(extensionData.amount),
          reason: extensionData.reason,
          status: 'PENDIENTE',
        }])
      if (error) throw error
      toast.success('Ampliación de presupuesto solicitada correctamente')
      setIsExtensionModalOpen(false)
      setExtensionData({ amount: '', reason: '' })
      setSelectedOTForExtension(null)
    } catch (error: any) {
      toast.error('Error al solicitar ampliación: ' + error.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const formatOTRow = (ot: any, item: any | null) => {
    let adminName = ''
    if (ot.contract_administrator_id) {
       const admin = profiles.find(p => p.id === ot.contract_administrator_id)
       if (admin) adminName = `${admin.first_name} ${admin.last_name}`
    }

    return {
      'N° OT': ot.ot_number,
      'Cliente': ot.clients?.business_name || ot.client_ruc || '', // fallback a ruc si business name falta temporalmente
      'RUC': ot.clients?.tax_id || ot.client_ruc || '',
      'Admin. Contrato': adminName,
      'Origen': ot.origin,
      'Destino': ot.destination,
      'Partida (S/)': Number(ot.budget_amount || 0).toFixed(2),
      'Estado': ot.status,
      'Fecha Emisión': new Date(ot.created_at).toLocaleDateString(),
      'SKU/ID': item ? item.sku : '',
      'Descripción Ítem': item ? item.description : '',
      'Cantidad': item ? item.quantity : 0,
      'Peso Unitario': item ? item.unit_weight : 0,
      'Peso Total': item ? item.total_weight : 0
    }
  }

  const handleExportMassive = async () => {
    if (workOrders.length === 0) {
      toast.error('No hay órdenes de trabajo para exportar.')
      return
    }

    setIsExporting(true)
    try {
      const otIds = workOrders.map(ot => ot.id)

      const { data: itemsData, error: itemsError } = await supabase
        .from('work_order_items')
        .select('*')
        .in('work_order_id', otIds)

      if (itemsError) throw itemsError

      const excelData: any[] = []

      workOrders.forEach(ot => {
        const otItems = itemsData?.filter(item => item.work_order_id === ot.id) || []
        
        if (otItems.length === 0) {
          excelData.push(formatOTRow(ot, null))
        } else {
          otItems.forEach(item => {
            excelData.push(formatOTRow(ot, item))
          })
        }
      })

      const worksheet = XLSX.utils.json_to_sheet(excelData)
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Reporte_Masivo_OTs')
      const today = new Date().toISOString().split('T')[0]
      XLSX.writeFile(workbook, `Reporte_Masivo_OTs_${today}.xlsx`)
      toast.success('Reporte masivo exportado correctamente')
    } catch (error: any) {
      toast.error('Error al exportar masivo: ' + error.message)
    } finally {
      setIsExporting(false)
    }
  }

  const handleExportIndividual = async (ot: any, preloadedItems?: any[]) => {
    try {
      let items = preloadedItems;
      
      if (!items) {
        const { data, error } = await supabase
          .from('work_order_items')
          .select('*')
          .eq('work_order_id', ot.id)
        if (error) throw error
        items = data || []
      }

      const excelData: any[] = []
      
      if (items.length === 0) {
        excelData.push(formatOTRow(ot, null))
      } else {
        items.forEach(item => {
          excelData.push(formatOTRow(ot, item))
        })
      }

      const worksheet = XLSX.utils.json_to_sheet(excelData)
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, worksheet, `OT_${ot.ot_number}`)
      XLSX.writeFile(workbook, `Reporte_OT_${ot.ot_number}.xlsx`)
      
      toast.success(`Reporte de OT ${ot.ot_number} exportado`)
    } catch (error: any) {
      toast.error('Error al exportar OT: ' + error.message)
    }
  }

  const getStatusBadge = (status: string) => {
    switch(status) {
      case 'GENERADA':
        return <span className="bg-blue-100 text-blue-800 px-2 py-1 rounded text-xs font-semibold">Generada</span>
      case 'ASIGNADA':
        return <span className="bg-purple-100 text-purple-800 px-2 py-1 rounded text-xs font-semibold">Asignada</span>
      case 'EN TRANSITO':
        return <span className="bg-yellow-100 text-yellow-800 px-2 py-1 rounded text-xs font-semibold">En Tránsito</span>
      case 'COMPLETADA':
        return <span className="bg-green-100 text-green-800 px-2 py-1 rounded text-xs font-semibold">Completada</span>
      case 'CANCELADA':
        return <span className="bg-red-100 text-red-800 px-2 py-1 rounded text-xs font-semibold">Cancelada</span>
      default:
        return <span className="bg-slate-100 text-slate-800 px-2 py-1 rounded text-xs font-semibold">{status}</span>
    }
  }

  const handleViewOT = async (ot: any) => {
    setSelectedOTForView(ot)
    setIsViewModalOpen(true)
    setIsLoadingItems(true)
    try {
      const { data, error } = await supabase
        .from('work_order_items')
        .select('*')
        .eq('work_order_id', ot.id)
      
      if (error) throw error
      setViewOTItems(data || [])
    } catch (error: any) {
      toast.error("Error cargando ítems de la OT: " + error.message)
    } finally {
      setIsLoadingItems(false)
    }
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Órdenes de Trabajo (OT)</h1>
          <p className="text-sm text-slate-500">Gestión de servicios de transporte aprobados</p>
        </div>
        <div className="flex items-center gap-3">
          <button 
            onClick={downloadTemplate}
            className="flex items-center gap-2 bg-white border border-slate-200 text-slate-600 px-4 py-2 rounded-lg font-medium hover:bg-slate-50 transition-colors shadow-sm"
          >
            <Download className="w-4 h-4" />
            Plantilla
          </button>
          
          <label className="flex items-center gap-2 bg-emerald-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-emerald-700 transition-colors shadow-sm cursor-pointer">
            {isUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            Carga Masiva
            <input type="file" id="bulkUpload" className="hidden" accept=".xlsx" onChange={handleBulkUpload} disabled={isUploading} />
          </label>

          <button 
            onClick={handleExportMassive}
            disabled={isExporting}
            className="flex items-center gap-2 bg-white border border-slate-200 text-slate-600 px-4 py-2 rounded-lg font-medium hover:bg-slate-50 transition-colors shadow-sm disabled:opacity-50"
          >
            {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Exportar Lista
          </button>

          <button 
            onClick={() => {
              setNewOT(initialOTState)
              setPartidaSearch('')
              setIsModalOpen(true)
            }}
            className="flex items-center gap-2 bg-[#002855] text-white px-4 py-2 rounded-lg font-medium hover:bg-[#001d3d] transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" />
            Generar OT
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
          <div className="relative w-72">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
            <input 
              type="text" 
              placeholder="Buscar por código OT o Cliente..." 
              className="w-full pl-9 pr-4 py-2 bg-white text-slate-900 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#002855]"
            />
          </div>
          <button className="flex items-center gap-2 px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100">
            <Filter className="w-4 h-4" />
            Filtrar
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider border-b">
                <th className="p-4 font-semibold">OT</th>
                <th className="p-4 font-semibold">Cliente</th>
                <th className="p-4 font-semibold">Ruta</th>
                <th className="p-4 font-semibold">Carga</th>
                <th className="p-4 font-semibold">Partida (S/)</th>
                <th className="p-4 font-semibold">Fecha Emisión</th>
                <th className="p-4 font-semibold">Estado</th>
                <th className="p-4 font-semibold text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-slate-500">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                    Cargando órdenes de trabajo...
                  </td>
                </tr>
              ) : workOrders.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-slate-500">
                    No hay OTs registradas.
                  </td>
                </tr>
              ) : (
                workOrders.map(ot => (
                  <tr key={ot.id} className="hover:bg-slate-50 transition-colors">
                    <td className="p-4">
                      <button 
                        onClick={() => handleViewOT(ot)}
                        className="font-bold text-[#002855] hover:underline cursor-pointer flex items-center gap-1"
                        title="Ver Detalles de OT"
                      >
                        <FileText className="w-3 h-3" />
                        {ot.ot_number}
                      </button>
                    </td>
                    <td className="p-4">
                      <div className="flex flex-col">
                        <span className="font-semibold text-slate-800">{ot.clients?.business_name || 'Sin Cliente'}</span>
                        <span className="text-xs text-slate-500">RUC: {ot.clients?.tax_id || '-'}</span>
                      </div>
                    </td>
                    <td className="p-4 text-sm text-slate-600 max-w-[200px] truncate" title={`${ot.origin} -> ${ot.destination}`}>
                      <div className="font-medium truncate">A: <span className="font-normal">{ot.origin}</span></div>
                      <div className="font-medium truncate">B: <span className="font-normal">{ot.destination}</span></div>
                    </td>
                    <td className="p-4 text-sm text-slate-600 max-w-[150px] truncate" title={ot.cargo_details}>
                      {ot.cargo_details}
                    </td>
                    <td className="p-4 text-sm font-semibold text-slate-800">
                      S/ {Number(ot.budget_amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td className="p-4 text-sm text-slate-600">
                      <div className="flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        {new Date(ot.created_at).toLocaleDateString()}
                      </div>
                    </td>
                    <td className="p-4">
                      {getStatusBadge(ot.status)}
                    </td>
                    <td className="p-4 text-right">
                      <div className="flex justify-end gap-2">
                        <button 
                          onClick={() => {
                            setSelectedOTForTransfer(ot)
                            setIsTransferModalOpen(true)
                          }}
                          title="Transferir a otro Administrador"
                          className="p-2 text-slate-400 hover:text-indigo-600 transition-colors rounded hover:bg-indigo-50"
                        >
                          <UserPlus className="w-4 h-4" />
                        </button>
                        <button 
                          onClick={() => {
                            setSelectedOTForExtension(ot)
                            setIsExtensionModalOpen(true)
                          }}
                          title="Solicitar Ampliación de Partida"
                          className="p-2 text-slate-400 hover:text-yellow-600 transition-colors rounded hover:bg-yellow-50"
                        >
                          <FileText className="w-4 h-4" />
                        </button>
                        <button 
                          onClick={() => handleViewOT(ot)}
                          title="Ver / Editar Detalle"
                          className="p-2 text-slate-400 hover:text-[#002855] transition-colors rounded hover:bg-blue-50"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button 
                          onClick={() => handleExportIndividual(ot)}
                          title="Exportar a Excel"
                          className="p-2 text-slate-400 hover:text-emerald-600 transition-colors rounded hover:bg-emerald-50"
                        >
                          <Download className="w-4 h-4" />
                        </button>
                      </div>
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
        title={newOT.parent_work_order_id ? "Generar Subcontrato" : "Generar Orden de Trabajo (OT)"}
        maxWidth="max-w-4xl"
      >
        <form onSubmit={handleCreateOT} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Número de OT {newOT.parent_work_order_id && "(Anexo)"}
            </label>
            {newOT.parent_work_order_id ? (
              <div className="flex items-center gap-2">
                <span className="px-4 py-2 bg-slate-100 border border-slate-300 rounded-lg text-slate-900 font-semibold select-none">
                  {selectedOTForView?.ot_number}-
                </span>
                <input 
                  type="text" 
                  required
                  placeholder="Ej. S001"
                  className="flex-1 px-3 py-2 bg-white text-slate-900 font-medium border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none uppercase"
                  value={newOT.ot_number.split('-').pop() || ''}
                  onChange={(e) => {
                    const suffix = e.target.value.toUpperCase();
                    setNewOT({...newOT, ot_number: `${selectedOTForView?.ot_number}-${suffix}`})
                  }}
                />
              </div>
            ) : (
              <input 
                type="text" 
                required
                placeholder="Ej. OT-2023-0001"
                className="w-full px-3 py-2 bg-white text-slate-900 font-medium border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none uppercase"
                value={newOT.ot_number}
                onChange={(e) => setNewOT({...newOT, ot_number: e.target.value.toUpperCase()})}
              />
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {!newOT.parent_work_order_id && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Cliente</label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input 
                      type="text"
                      list="clients-list"
                      required
                      placeholder="Buscar o escribir cliente..."
                      className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                      value={clientSearch}
                      onChange={(e) => {
                        setClientSearch(e.target.value)
                        const match = clients.find(c => `${c.business_name} (RUC: ${c.tax_id})` === e.target.value)
                        setNewOT({...newOT, client_id: match ? match.id : ''})
                      }}
                    />
                    <datalist id="clients-list">
                      {clients.map(c => (
                        <option key={c.id} value={`${c.business_name} (RUC: ${c.tax_id})`} />
                      ))}
                    </datalist>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsClientModalOpen(true)}
                    className="px-3 py-2 bg-slate-100 border border-slate-300 text-slate-600 rounded-lg hover:bg-slate-200 transition-colors"
                    title="Registrar Nuevo Cliente"
                  >
                    <Plus className="w-5 h-5" />
                  </button>
                </div>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                {newOT.parent_work_order_id ? "Partida (Opcional - Hereda de Madre)" : "Partida (Monto S/)"}
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 font-medium">S/</span>
                <input 
                  type="number"
                  step="0.01"
                  min="0"
                  required={!newOT.parent_work_order_id}
                  placeholder="0.00"
                  className="w-full pl-8 pr-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                  value={newOT.budget_amount}
                  onChange={(e) => setNewOT({...newOT, budget_amount: e.target.value})}
                />
              </div>
            </div>
            
            {/* Si es subcontrato, la fecha requerida ocupa una celda entera si no hay admin */}
            <div className={newOT.parent_work_order_id ? "col-span-1 md:col-span-2 md:w-1/2 md:pr-2" : ""}>
              <label className="block text-sm font-medium text-slate-700 mb-1">Fecha Requerida</label>
              <input 
                type="date" 
                required
                className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                value={newOT.required_date}
                onChange={(e) => setNewOT({...newOT, required_date: e.target.value})}
              />
            </div>
          </div>

          {!newOT.parent_work_order_id && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Administrador de Contrato</label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <input 
                        type="text"
                        list="admins-list"
                        required
                        placeholder="Buscar administrador..."
                        className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                        value={adminSearch}
                        onChange={(e) => {
                          setAdminSearch(e.target.value)
                          const match = profiles.find(p => `${p.first_name} ${p.last_name}` === e.target.value)
                          setNewOT({...newOT, contract_administrator_id: match ? match.id : ''})
                        }}
                      />
                      <datalist id="admins-list">
                        {profiles.map(p => (
                          <option key={p.id} value={`${p.first_name} ${p.last_name}`} />
                        ))}
                      </datalist>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsAdminModalOpen(true)}
                      className="px-3 py-2 bg-slate-100 border border-slate-300 text-slate-600 rounded-lg hover:bg-slate-200 transition-colors"
                      title="Registrar Administrador"
                    >
                      <Plus className="w-5 h-5" />
                    </button>
                  </div>
                </div>
              </div>
              <div className="border border-slate-200 rounded-lg p-3 bg-slate-50/50 mt-4">
                <h4 className="text-sm font-semibold text-slate-800 mb-2">Origen</h4>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <div className="md:col-span-1">
                    <label className="block text-xs font-medium text-slate-700 mb-1">Punto de Origen Exacto</label>
                    <input 
                      type="text" 
                      required
                      className="w-full px-3 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                      value={newOT.origin}
                      onChange={(e) => setNewOT({...newOT, origin: e.target.value})}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Departamento</label>
                    <input 
                      type="text" 
                      placeholder="Ej. LIMA"
                      className="w-full px-3 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                      value={newOT.origin_department}
                      onChange={(e) => setNewOT({...newOT, origin_department: e.target.value.toUpperCase()})}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Provincia</label>
                    <input 
                      type="text" 
                      placeholder="Ej. CAÑETE"
                      className="w-full px-3 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                      value={newOT.origin_province}
                      onChange={(e) => setNewOT({...newOT, origin_province: e.target.value.toUpperCase()})}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Distrito</label>
                    <input 
                      type="text" 
                      placeholder="Ej. CHILCA"
                      className="w-full px-3 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                      value={newOT.origin_district}
                      onChange={(e) => setNewOT({...newOT, origin_district: e.target.value.toUpperCase()})}
                    />
                  </div>
                </div>
              </div>

              <div className="border border-slate-200 rounded-lg p-3 bg-slate-50/50 mt-4">
                <h4 className="text-sm font-semibold text-slate-800 mb-2">Destino</h4>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <div className="md:col-span-1">
                    <label className="block text-xs font-medium text-slate-700 mb-1">Punto de Destino Exacto</label>
                    <input 
                      type="text" 
                      required
                      className="w-full px-3 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                      value={newOT.destination}
                      onChange={(e) => setNewOT({...newOT, destination: e.target.value})}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Departamento</label>
                    <input 
                      type="text" 
                      placeholder="Ej. LIMA"
                      className="w-full px-3 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                      value={newOT.destination_department}
                      onChange={(e) => setNewOT({...newOT, destination_department: e.target.value.toUpperCase()})}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Provincia</label>
                    <input 
                      type="text" 
                      placeholder="Ej. LIMA"
                      className="w-full px-3 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                      value={newOT.destination_province}
                      onChange={(e) => setNewOT({...newOT, destination_province: e.target.value.toUpperCase()})}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Distrito</label>
                    <input 
                      type="text" 
                      placeholder="Ej. ATE"
                      className="w-full px-3 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                      value={newOT.destination_district}
                      onChange={(e) => setNewOT({...newOT, destination_district: e.target.value.toUpperCase()})}
                    />
                  </div>
                </div>
              </div>
            </>
          )}

          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <label className="block text-sm font-medium text-slate-700">Ítems / Detalles de la Carga</label>
              <button
                type="button"
                onClick={handleAddItem}
                className="flex items-center gap-1 text-sm bg-blue-50 text-[#002855] px-3 py-1 rounded hover:bg-blue-100 transition-colors font-medium"
              >
                <Plus className="w-4 h-4" /> Agregar Ítem
              </button>
            </div>
            
            {otItems.length === 0 ? (
              <div className="text-center p-4 border border-dashed border-slate-300 rounded-lg text-slate-500 text-sm">
                No hay ítems agregados. Haz clic en "Agregar Ítem".
              </div>
            ) : (
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <table className="w-full text-sm text-left">
                  <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                    <tr>
                      <th className="px-3 py-2 font-medium">SKU / ID</th>
                      <th className="px-3 py-2 font-medium">Descripción</th>
                      <th className="px-3 py-2 font-medium w-20">Cant.</th>
                      <th className="px-3 py-2 font-medium w-24">P. Unit</th>
                      <th className="px-3 py-2 font-medium w-24">P. Total</th>
                      <th className="px-3 py-2 font-medium w-10"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {otItems.map(item => (
                      <tr key={item.id}>
                        <td className="p-2">
                          <input 
                            type="text" 
                            className="w-full px-2 py-1 bg-white text-slate-900 font-medium border border-slate-300 rounded focus:outline-none focus:border-blue-400"
                            placeholder="SKU"
                            value={item.sku}
                            onChange={(e) => handleItemChange(item.id, 'sku', e.target.value)}
                          />
                        </td>
                        <td className="p-2">
                          <input 
                            type="text" 
                            required
                            className="w-full px-2 py-1 bg-white text-slate-900 font-medium border border-slate-300 rounded focus:outline-none focus:border-blue-400"
                            placeholder="Descripción"
                            value={item.description}
                            onChange={(e) => handleItemChange(item.id, 'description', e.target.value)}
                          />
                        </td>
                        <td className="p-2">
                          <input 
                            type="number" 
                            min="1"
                            required
                            className="w-full px-2 py-1 bg-white text-slate-900 font-medium border border-slate-300 rounded focus:outline-none focus:border-blue-400"
                            value={item.quantity}
                            onChange={(e) => handleItemChange(item.id, 'quantity', e.target.value)}
                          />
                        </td>
                        <td className="p-2">
                          <input 
                            type="number" 
                            min="0"
                            step="0.01"
                            className="w-full px-2 py-1 bg-white text-slate-900 font-medium border border-slate-300 rounded focus:outline-none focus:border-blue-400"
                            value={item.unit_weight}
                            onChange={(e) => handleItemChange(item.id, 'unit_weight', e.target.value)}
                          />
                        </td>
                        <td className="p-2">
                          <input 
                            type="number" 
                            disabled
                            className="w-full px-2 py-1 border border-slate-300 bg-slate-100 text-slate-900 font-bold rounded"
                            value={item.total_weight}
                          />
                        </td>
                        <td className="p-2 text-center">
                          <button
                            type="button"
                            onClick={() => handleRemoveItem(item.id)}
                            className="text-red-500 hover:text-red-700 p-1"
                            title="Eliminar"
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="bg-yellow-50 text-yellow-800 p-3 rounded-lg text-sm mb-4 border border-yellow-200">
            <strong>Atención:</strong> De acuerdo a políticas operativas, la OT solo puede utilizar el <strong>70%</strong> del límite de la Partida asignada. Si excedes este límite operativo, deberás solicitar una ampliación al Administrador de Contrato.
          </div>

          <div className="pt-4 flex justify-end gap-3 border-t border-slate-200 mt-4">
            <button 
              type="button" 
              onClick={() => setIsModalOpen(false)}
              className="px-4 py-2 text-slate-600 font-medium hover:bg-slate-100 rounded-lg transition-colors"
            >
              Cancelar
            </button>
            <button 
              type="submit" 
              disabled={isSubmitting || !newOT.client_id}
              className="px-4 py-2 bg-[#002855] text-white font-medium rounded-lg hover:bg-[#001d3d] transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
              Generar OT
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={isExtensionModalOpen}
        onClose={() => setIsExtensionModalOpen(false)}
        title="Solicitar Ampliación de Presupuesto"
      >
        <form onSubmit={handleRequestExtension} className="space-y-4">
          <div className="bg-blue-50 text-blue-800 p-3 rounded-lg text-sm mb-4">
            Solicitando ampliación para la OT: <strong>{selectedOTForExtension?.ot_number}</strong>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Monto Adicional Solicitado (S/)</label>
            <input 
              type="number" 
              step="0.01"
              required
              min="1"
              className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
              value={extensionData.amount}
              onChange={(e) => setExtensionData({...extensionData, amount: e.target.value})}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Motivo Operativo</label>
            <textarea 
              required
              rows={4}
              placeholder="Explica la necesidad operativa del aumento de presupuesto (ej. necesidad de transporte adicional, desvío de ruta...)"
              className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none resize-none"
              value={extensionData.reason}
              onChange={(e) => setExtensionData({...extensionData, reason: e.target.value})}
            />
          </div>
          <div className="pt-4 flex justify-end gap-3 border-t border-slate-200 mt-4">
            <button 
              type="button" 
              onClick={() => setIsExtensionModalOpen(false)}
              className="px-4 py-2 text-slate-600 font-medium hover:bg-slate-100 rounded-lg transition-colors"
            >
              Cancelar
            </button>
            <button 
              type="submit" 
              disabled={isSubmitting}
              className="px-4 py-2 bg-[#002855] text-white font-medium rounded-lg hover:bg-[#001d3d] transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
              Enviar Solicitud
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={isTransferModalOpen}
        onClose={() => setIsTransferModalOpen(false)}
        title="Transferir Orden de Trabajo"
      >
        <form onSubmit={handleTransferOT} className="space-y-4">
          <div className="bg-indigo-50 text-indigo-800 p-3 rounded-lg text-sm mb-4">
            Transfiriendo la OT: <strong>{selectedOTForTransfer?.ot_number}</strong>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Nuevo Administrador de Contrato</label>
            <div className="relative">
              <input 
                type="text"
                list="transfer-admins-list"
                required
                placeholder="Buscar administrador..."
                className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                value={adminSearch}
                onChange={(e) => {
                  setAdminSearch(e.target.value)
                  const match = profiles.find(p => `${p.first_name} ${p.last_name}` === e.target.value)
                  setTransferAdminId(match ? match.id : '')
                }}
              />
              <datalist id="transfer-admins-list">
                {profiles.map(p => (
                  <option key={p.id} value={`${p.first_name} ${p.last_name}`} />
                ))}
              </datalist>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Motivo de la Transferencia</label>
            <textarea 
              required
              rows={3}
              placeholder="Ej. Reasignación por carga laboral, vacaciones..."
              className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none resize-none"
              value={transferReason}
              onChange={(e) => setTransferReason(e.target.value)}
            />
          </div>
          <div className="pt-4 flex justify-end gap-3 border-t border-slate-200 mt-4">
            <button 
              type="button" 
              onClick={() => setIsTransferModalOpen(false)}
              className="px-4 py-2 text-slate-600 font-medium hover:bg-slate-100 rounded-lg transition-colors"
            >
              Cancelar
            </button>
            <button 
              type="submit" 
              disabled={isSubmitting || !transferAdminId}
              className="px-4 py-2 bg-[#002855] text-white font-medium rounded-lg hover:bg-[#001d3d] transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
              Transferir OT
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={isViewModalOpen}
        onClose={() => setIsViewModalOpen(false)}
        title={`Detalles de OT: ${selectedOTForView?.ot_number}`}
        maxWidth="max-w-4xl"
      >
        {selectedOTForView && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4 bg-slate-50 rounded-lg border border-slate-200 text-sm">
              <div>
                <span className="block text-slate-500 mb-1">Cliente</span>
                <strong className="text-slate-900">{selectedOTForView.clients?.business_name || '-'}</strong>
              </div>
              <div>
                <span className="block text-slate-500 mb-1">RUC</span>
                <strong className="text-slate-900">{selectedOTForView.clients?.tax_id || '-'}</strong>
              </div>
              <div>
                <span className="block text-slate-500 mb-1">Partida</span>
                <strong className="text-slate-900">{budgets.find(b => b.id === selectedOTForView.transport_budget_id)?.code || '-'}</strong>
              </div>
              <div>
                <span className="block text-slate-500 mb-1">Admin. Contrato</span>
                <strong className="text-slate-900">{profiles.find(p => p.id === selectedOTForView.contract_administrator_id)?.first_name || '-'} {profiles.find(p => p.id === selectedOTForView.contract_administrator_id)?.last_name || ''}</strong>
              </div>
              <div>
                <span className="block text-slate-500 mb-1">Estado</span>
                <strong className="text-slate-900">
                  <span className={`px-2 py-1 rounded-full text-xs font-semibold ${selectedOTForView.status === 'GENERADA' ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-800'}`}>
                    {selectedOTForView.status}
                  </span>
                </strong>
              </div>
              <div>
                <span className="block text-slate-500 mb-1">Fecha Emisión</span>
                <strong className="text-slate-900">{new Date(selectedOTForView.created_at).toLocaleDateString()}</strong>
              </div>
              <div>
                <span className="block text-slate-500 mb-1">Origen</span>
                <strong className="text-slate-900">{selectedOTForView.origin}</strong>
              </div>
              <div>
                <span className="block text-slate-500 mb-1">Destino</span>
                <strong className="text-slate-900">{selectedOTForView.destination}</strong>
              </div>
              <div className="col-span-2 md:col-span-2">
                <span className="block text-slate-500 mb-1">Resumen de Carga</span>
                <span className="text-slate-900">{selectedOTForView.cargo_details}</span>
              </div>
              <div className="col-span-2 md:col-span-2">
                <span className="block text-slate-500 mb-1">Partida (Presupuesto Asignado)</span>
                <span className="text-slate-900 font-bold bg-green-50 text-green-700 px-3 py-1 rounded inline-block">
                  S/ {Number(selectedOTForView.budget_amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            </div>

            <div>
              <h4 className="font-semibold text-[#002855] mb-3 border-b pb-2">Ítems / Productos</h4>
              {isLoadingItems ? (
                <div className="text-center p-8 text-slate-500">
                  <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                  Cargando ítems...
                </div>
              ) : viewOTItems.length === 0 ? (
                <div className="text-center p-6 bg-slate-50 text-slate-500 rounded-lg border border-slate-200">
                  No se encontraron ítems detallados para esta OT.
                </div>
              ) : (
                <div className="border border-slate-200 rounded-lg overflow-hidden">
                  <table className="w-full text-sm text-left">
                    <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                      <tr>
                        <th className="px-4 py-3 font-medium">SKU / ID</th>
                        <th className="px-4 py-3 font-medium">Descripción</th>
                        <th className="px-4 py-3 font-medium text-right">Cantidad</th>
                        <th className="px-4 py-3 font-medium text-right">Peso Unit.</th>
                        <th className="px-4 py-3 font-medium text-right">Peso Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {viewOTItems.map(item => (
                        <tr key={item.id} className="hover:bg-slate-50">
                          <td className="px-4 py-2 font-medium text-slate-900">{item.sku || '-'}</td>
                          <td className="px-4 py-2 text-slate-900">{item.description}</td>
                          <td className="px-4 py-2 text-right text-slate-900 font-medium">{item.quantity}</td>
                          <td className="px-4 py-2 text-right text-slate-900 font-medium">{Number(item.unit_weight).toFixed(2)}</td>
                          <td className="px-4 py-2 text-right font-bold text-[#002855]">{Number(item.total_weight).toFixed(2)}</td>
                        </tr>
                      ))}
                      <tr className="bg-slate-50 font-bold text-slate-900">
                        <td colSpan={2} className="px-4 py-3 text-right">TOTALES</td>
                        <td className="px-4 py-3 text-right">
                          {viewOTItems.reduce((acc, item) => acc + item.quantity, 0)}
                        </td>
                        <td className="px-4 py-3 text-right"></td>
                        <td className="px-4 py-3 text-right text-[#002855]">
                          {viewOTItems.reduce((acc, item) => acc + Number(item.total_weight), 0).toFixed(2)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Subcontracts Section */}
            {workOrders.filter(ot => ot.parent_work_order_id === selectedOTForView.id).length > 0 && (
              <div className="mt-8">
                <h4 className="font-semibold text-[#002855] mb-3 border-b pb-2 flex items-center gap-2">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3v12"/><path d="M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M15 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
                  Subcontratos Asociados
                </h4>
                <div className="grid gap-3">
                  {workOrders.filter(ot => ot.parent_work_order_id === selectedOTForView.id).map(sub => (
                    <div key={sub.id} className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex justify-between items-center hover:bg-slate-100 transition-colors cursor-pointer" onClick={() => handleViewOT(sub.id)}>
                      <div>
                        <strong className="text-[#002855]">{sub.ot_number}</strong>
                        <span className="text-slate-500 text-sm ml-2">({sub.cargo_details})</span>
                      </div>
                      <span className={`px-2 py-1 rounded-full text-xs font-semibold ${sub.status === 'GENERADA' ? 'bg-blue-100 text-blue-800' : 'bg-slate-200 text-slate-700'}`}>
                        {sub.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end gap-3 pt-4">
              <button
                type="button"
                onClick={() => handleExportIndividual(selectedOTForView, viewOTItems)}
                className="px-4 py-2 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 transition-colors flex items-center gap-2"
              >
                <Download className="w-4 h-4" />
                Exportar Excel
              </button>
              <button
                type="button"
                onClick={() => {
                  const existingSubcontracts = workOrders.filter(ot => ot.parent_work_order_id === selectedOTForView.id);
                  const nextS = String(existingSubcontracts.length + 1).padStart(3, '0');
                  const subcontractNumber = `${selectedOTForView.ot_number}-S${nextS}`;
                  
                  setNewOT({
                    client_id: selectedOTForView.client_id,
                    contract_administrator_id: selectedOTForView.contract_administrator_id || '',
                    budget_amount: selectedOTForView.budget_amount || '',
                    parent_work_order_id: selectedOTForView.id,
                    origin: selectedOTForView.origin,
                    destination: selectedOTForView.destination,
                    delivery_address: '',
                    cargo_details: '',
                    required_date: new Date().toISOString().split('T')[0],
                    ot_number: subcontractNumber // We need to add ot_number to the state
                  });
                  setOtItems([{ id: '1', sku: '', description: '', quantity: 1, unit_weight: 0, total_weight: 0 }]);
                  setIsViewModalOpen(false);
                  setIsModalOpen(true);
                }}
                className="px-4 py-2 bg-[#002855] text-white rounded-lg font-medium hover:bg-[#001d3d] transition-colors"
              >
                + Generar Subcontrato
              </button>
              <button
                type="button"
                onClick={() => setIsViewModalOpen(false)}
                className="px-4 py-2 bg-slate-100 text-slate-700 rounded-lg font-medium hover:bg-slate-200 transition-colors"
              >
                Cerrar
              </button>
            </div>
          </div>
        )}
      </Modal>

      <ClientFormModal 
        isOpen={isClientModalOpen}
        onClose={() => setIsClientModalOpen(false)}
        onSuccess={(client: any) => {
          setClients([...clients, client])
          setClientSearch(`${client.business_name} (RUC: ${client.tax_id})`)
          setNewOT({...newOT, client_id: client.id})
          setIsClientModalOpen(false)
        }}
      />

      <UserFormModal 
        isOpen={isAdminModalOpen}
        onClose={() => setIsAdminModalOpen(false)}
        roles={roles}
        onSuccess={(user: any) => {
          setProfiles([...profiles, user])
          setAdminSearch(`${user.first_name} ${user.last_name}`)
          setNewOT({...newOT, contract_administrator_id: user.id})
          setIsAdminModalOpen(false)
        }}
      />
    </div>
  )
}
