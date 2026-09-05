"use client"
import { useState, useEffect, useRef } from 'react'
import { Plus, Send, Check, X, Search, Filter, Loader2, Calendar, Trash2, Clock, Upload, Download, FileSpreadsheet, CalendarClock, Ban, Activity, Edit2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import * as XLSX from 'xlsx'
import ExcelJS from 'exceljs'
import { usePermissions } from '@/hooks/usePermissions'

interface TransportRequest {
  id: string
  request_number: string
  requester_name: string
  department: string
  pickup_address: string
  delivery_address: string
  required_date: string
  time_window: string
  cargo_description: string
  estimated_weight: number
  status: string
  request_type: string
  created_at: string
  ot_reference?: string
  service_cost?: number
  transport_request_items?: Array<{ weight: number, volume_m3: number, quantity: number }>
}

interface Product {
  id: string
  sku: string
  description: string
  category?: string
  weight?: number
  volume_m3?: number
  default_weight?: number
  default_volume?: number
}

interface RequestItem {
  id: string // temporary client-side id
  product_id: string
  product_description: string
  quantity: number
  weight: number
  volume_m3: number
  length_m: number
  width_m: number
  is_fragile: boolean
  needs_stowage: boolean
  needs_forklift: boolean
}

interface WorkOrder {
  id: string
  ot_number: string
  location?: string
  destination_address?: string
  budget_amount?: number
  consumed_budget?: number
}

export default function SolicitudesPage() {
  const { canWrite } = usePermissions()
  const supabase = createClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  
  const [requests, setRequests] = useState<TransportRequest[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([])
  const [loading, setLoading] = useState(true)
  
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [userRole, setUserRole] = useState<string>('')
  
  const [isRescheduleModalOpen, setIsRescheduleModalOpen] = useState(false)
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null)
  const [newRescheduleDate, setNewRescheduleDate] = useState('')
  
  const [newRequest, setNewRequest] = useState({
    requester_name: '',
    department: '',
    request_type: 'DESPACHO',
    pickup_address: 'Planta Chilca',
    pickup_department: 'LIMA',
    pickup_province: 'CAETE',
    pickup_district: 'CHILCA',
    delivery_address: '',
    delivery_department: '',
    delivery_province: '',
    delivery_district: '',
    required_date: '',
    time_window: '',
    ot_reference: '',
    notes: ''
  })
  const [requestItems, setRequestItems] = useState<RequestItem[]>([])
  const [editingRequestId, setEditingRequestId] = useState<string | null>(null)

  useEffect(() => {
    fetchRequests()
    fetchProducts()
    fetchWorkOrders()
    checkUser()
  }, [])

  const checkUser = async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('first_name, last_name, roles(name)')
        .eq('id', user.id)
        .single()
      
      if (profile) {
        setNewRequest(prev => ({...prev, requester_name: `${profile.first_name} ${profile.last_name}`}))
        const roleName = Array.isArray(profile.roles) ? profile.roles[0]?.name : (profile.roles as any)?.name
        if (roleName) {
          setUserRole(roleName.toLowerCase())
        }
      }
    }
  }

  const fetchRequests = async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('transport_requests')
        .select(`
          *,
          transport_request_items (
            weight,
            volume_m3,
            quantity
          )
        `)
        .order('created_at', { ascending: false })

      if (error) throw error
      setRequests(data || [])
    } catch (error: any) {
      toast.error('Error al cargar solicitudes: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  const fetchProducts = async () => {
    try {
      const { data, error } = await supabase
        .from('products')
        .select('id, sku, description, default_weight, default_volume')
        .eq('is_active', true)
        .order('description', { ascending: true })

      if (error) throw error
      setProducts(data || [])
    } catch (error: any) {
      console.error('Error al cargar productos:', error)
    }
  }

  const fetchWorkOrders = async () => {
    try {
      const { data, error } = await supabase
        .from('work_orders')
        .select('id, ot_number, destination_address, budget_amount')

      if (error) throw error
      
      const formatted = (data || []).map(ot => {
        return {
          id: ot.id,
          ot_number: ot.ot_number,
          destination_address: ot.destination_address,
          budget_amount: Number(ot.budget_amount) || 0,
          consumed_budget: 0 // Will compute this dynamically below using fetchRequests data
        }
      })
      setWorkOrders(formatted)
    } catch (error: any) {
      console.error('Error al cargar OTs:', error.message || error)
      toast.error('Error al cargar OTs: ' + (error.message || 'Desconocido'))
    }
  }

  // Handle OT reference change to prefill delivery address
  const handleOtReferenceChange = (val: string) => {
    setNewRequest(prev => {
      const updated = { ...prev, ot_reference: val }
      // Attempt to find matching OT
      const matchedOt = workOrders.find(ot => ot.ot_number.toLowerCase() === val.toLowerCase())
      if (matchedOt && matchedOt.destination_address) {
        updated.delivery_address = matchedOt.destination_address
      }
      return updated
    })
  }

  const handleAddItem = () => {
    setRequestItems([
      ...requestItems, 
      {
        id: Math.random().toString(36).substring(7),
        product_id: '',
        product_description: '',
        quantity: 1,
        weight: 0,
        volume_m3: 0,
        length_m: 0,
        width_m: 0,
        is_fragile: false,
        needs_stowage: false,
        needs_forklift: false
      }
    ])
  }

  const handleRemoveItem = (id: string) => {
    setRequestItems(requestItems.filter(item => item.id !== id))
  }

  const handleItemChange = (id: string, field: keyof RequestItem, value: any) => {
    setRequestItems(requestItems.map(item => {
      if (item.id === id) {
        const updatedItem = { ...item, [field]: value }
        
        // Auto-fill defaults if product is selected
        if (field === 'product_id') {
          const product = products.find(p => p.id === value)
          if (product) {
            updatedItem.product_description = product.description
            updatedItem.weight = product.weight || 0
            updatedItem.volume_m3 = product.volume_m3 || 0
          }
        }
        
        return updatedItem
      }
      return item
    }))
  }

  const downloadTemplate = async () => {
    try {
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'JRM SAC'
      workbook.created = new Date()
      
      const sheet = workbook.addWorksheet('Carga Masiva')
      
      // Añadir encabezado con título
      sheet.mergeCells('A1:E3')
      const titleCell = sheet.getCell('A1')
      titleCell.value = 'PLANTILLA DE CARGA MASIVA DE ÍTEMS - JRM'
      titleCell.font = { name: 'Arial', size: 16, bold: true, color: { argb: 'FFFFFFFF' } }
      titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF002855' } } // Azul JRM
      titleCell.alignment = { vertical: 'middle', horizontal: 'center' }

      // Subtítulo / Instrucciones
      sheet.mergeCells('A4:E4')
      const subCell = sheet.getCell('A4')
      subCell.value = 'Instrucciones: Llenar a partir de la fila 7. Puede indicar SI o NO en las columnas especiales.'
      subCell.font = { name: 'Arial', size: 10, italic: true, color: { argb: 'FF555555' } }
      
      // Filas vacías para espaciado
      sheet.getRow(5).height = 10;

      // Headers (Fila 6)
      const headers = ['SKU (Obligatorio)', 'Cantidad (Obligatorio)', 'Frágil (SI/NO)', 'Req. Estiba (SI/NO)', 'Req. Montacarga (SI/NO)']
      const headerRow = sheet.getRow(6)
      headerRow.values = headers
      
      headerRow.eachCell((cell, colNumber) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0284C7' } }
        cell.alignment = { vertical: 'middle', horizontal: 'center' }
        cell.border = {
          top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'}
        }
      })

      // Ancho de columnas
      sheet.getColumn(1).width = 25
      sheet.getColumn(2).width = 20
      sheet.getColumn(3).width = 18
      sheet.getColumn(4).width = 22
      sheet.getColumn(5).width = 25

      // Algunos datos de ejemplo
      sheet.addRow(['PROD-001', 5, 'NO', 'SI', 'NO'])
      sheet.addRow(['', '', '', '', ''])

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `Plantilla_Carga_Items_JRM.xlsx`
      a.click()
      window.URL.revokeObjectURL(url)
    } catch (error) {
      console.error(error)
      toast.error('Error al generar plantilla')
    }
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = async (evt) => {
      try {
        const bstr = evt.target?.result
        const wb = XLSX.read(bstr, { type: 'binary' })
        const wsname = wb.SheetNames[0]
        const ws = wb.Sheets[wsname]
        
        // Empezamos a leer desde la fila 4 (índice 3), ya que 1,2,3 son títulos/headers
        const rawData = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][]
        
        const newItems: RequestItem[] = []
        const missingSkus: string[] = []
        const parsedRows = []
        
        // Data empieza en la fila 7, la tabla cruda tiene index 6
        for (let i = 6; i < rawData.length; i++) {
          const row = rawData[i] as any[]
          if (!row || row.length === 0 || !row[0]) continue // Fila vacía
          
          const skuRaw = String(row[0]).trim()
          parsedRows.push({
            skuRaw,
            qtyRaw: parseFloat(row[1]),
            fragilRaw: String(row[2] || '').trim().toUpperCase(),
            estibaRaw: String(row[3] || '').trim().toUpperCase(),
            montaRaw: String(row[4] || '').trim().toUpperCase()
          })

          const product = products.find(p => p.sku.toLowerCase() === skuRaw.toLowerCase())
          if (!product && !missingSkus.includes(skuRaw)) {
            missingSkus.push(skuRaw)
          }
        }

        // Auto-registrar productos faltantes
        let newlyInsertedProducts: any[] = []
        if (missingSkus.length > 0) {
          const productsToInsert = missingSkus.map(sku => ({
            sku,
            description: 'Autoregistrado por Carga Masiva (Pendiente actualizar)'
          }))

          const { data: insertedData, error } = await supabase
            .from('products')
            .insert(productsToInsert)
            .select('id, sku, description, weight, volume_m3')
          
          if (error) {
            console.error('Error auto-registrando productos:', error)
            toast.error('Ocurrió un error al auto-registrar productos nuevos.')
          } else if (insertedData) {
            newlyInsertedProducts = insertedData
            // Actualizar estado local para futuras referencias
            setProducts(prev => [...prev, ...insertedData])
          }
        }

        // Unificar productos existentes y nuevos
        const allAvailableProducts = [...products, ...newlyInsertedProducts]

        // Construir los ítems finales
        for (const row of parsedRows) {
          const product = allAvailableProducts.find(p => p.sku.toLowerCase() === row.skuRaw.toLowerCase())
          if (!product) continue // Si por alguna razón falló la inserción

          newItems.push({
            id: Math.random().toString(36).substring(7),
            product_id: product.id,
            product_description: product.description,
            quantity: isNaN(row.qtyRaw) || row.qtyRaw <= 0 ? 1 : row.qtyRaw,
            weight: product.weight || 0,
            volume_m3: product.volume_m3 || 0,
            length_m: 0,
            width_m: 0,
            is_fragile: row.fragilRaw === 'SI' || row.fragilRaw === 'S',
            needs_stowage: row.estibaRaw === 'SI' || row.estibaRaw === 'S',
            needs_forklift: row.montaRaw === 'SI' || row.montaRaw === 'S'
          })
        }
        
        if (newItems.length > 0) {
          setRequestItems(prev => [...prev, ...newItems])
          toast.success(`Se cargaron ${newItems.length} ítems correctamente.`)
        }
        
        if (missingSkus.length > 0) {
          toast.warning(
            `ATENCIÓN: Se auto-registraron ${missingSkus.length} productos faltantes. ` +
            `Por favor, complete sus pesos y dimensiones en el Maestro de Productos para garantizar cálculos correctos.`,
            { duration: 10000 }
          )
        }

      } catch (err) {
        console.error(err)
        toast.error('Error al procesar el archivo Excel.')
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = ''
      }
    }
    reader.readAsBinaryString(file)
  }

  const openEditModal = async (request: TransportRequest) => {
    // Extract notes from cargo_description (Format is "Ítems: ...\nNotas: {notes}")
    let extractedNotes = ''
    if (request.cargo_description.includes('Notas: ')) {
      extractedNotes = request.cargo_description.split('Notas: ')[1] || ''
    }

    setNewRequest({
      requester_name: request.requester_name,
      department: request.department,
      request_type: request.request_type,
      pickup_address: request.pickup_address,
      pickup_department: (request as any).pickup_department || '',
      pickup_province: (request as any).pickup_province || '',
      pickup_district: (request as any).pickup_district || '',
      delivery_address: request.delivery_address,
      delivery_department: (request as any).delivery_department || '',
      delivery_province: (request as any).delivery_province || '',
      delivery_district: (request as any).delivery_district || '',
      required_date: request.required_date ? request.required_date.split('T')[0] : '',
      time_window: request.time_window || '',
      ot_reference: request.ot_reference || '',
      notes: extractedNotes
    })

    // Transform items
    const formattedItems = (request.transport_request_items || []).map((i: any) => ({
      id: Math.random().toString(36).substring(7),
      product_id: i.product_id || '',
      product_description: i.description || 'Producto Editado',
      quantity: i.quantity,
      weight: i.weight,
      volume_m3: i.volume_m3,
      length_m: i.length_m || 0,
      width_m: i.width_m || 0,
      is_fragile: i.is_fragile || false,
      needs_stowage: i.needs_stowage || false,
      needs_forklift: i.needs_forklift || false
    }))
    setRequestItems(formattedItems)
    setEditingRequestId(request.id)
    setIsModalOpen(true)
  }

  const handleCreateRequest = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (requestItems.length === 0) {
      toast.error('Debes añadir al menos un producto a la solicitud.')
      return
    }

    const isOTDepartment = newRequest.department === 'OT (Administración de Contratos)' || newRequest.department.startsWith('OT -');

    if (isOTDepartment) {
      if (!newRequest.ot_reference) {
        toast.error('Para este departamento, es OBLIGATORIO seleccionar una OT registrada.')
        return
      }
    } else {
      if (requestItems.some(i => !i.product_description || !i.product_description.trim())) {
        toast.error('Debes ingresar la glosa o seleccionar un producto para todas las filas.')
        return
      }
    }

    setIsSubmitting(true)
    const requestNumber = `SOL-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`

    try {
      const finalDepartment = newRequest.department === 'OT (Administración de Contratos)' && newRequest.ot_reference
        ? `OT - ${newRequest.ot_reference}`
        : newRequest.department;

      // Calcular totales invisibles en la UI pero persistidos en BD
      const totalWeight = requestItems.reduce((acc, item) => acc + (item.weight * item.quantity), 0)
      
      // Construir descripción consolidada (Legacy display)
      const productsList = requestItems.map(i => `${i.quantity}x ${i.product_description}`).join(', ')
      const compiledDescription = `Ítems: ${productsList}\nNotas: ${newRequest.notes}`

      let targetRequestId = editingRequestId

      if (editingRequestId) {
        // UPDATE
        const { error: updateError } = await supabase
          .from('transport_requests')
          .update({
            requester_name: newRequest.requester_name,
            department: finalDepartment,
            pickup_address: newRequest.pickup_address,
            pickup_department: newRequest.pickup_department,
            pickup_province: newRequest.pickup_province,
            pickup_district: newRequest.pickup_district,
            delivery_address: newRequest.delivery_address,
            delivery_department: newRequest.delivery_department,
            delivery_province: newRequest.delivery_province,
            delivery_district: newRequest.delivery_district,
            required_date: newRequest.required_date,
            time_window: newRequest.time_window,
            cargo_description: compiledDescription,
            estimated_weight: totalWeight,
            request_type: newRequest.request_type,
            ot_reference: newRequest.ot_reference || null
          })
          .eq('id', editingRequestId)
          
        if (updateError) throw updateError
        
        // Delete old items and insert new ones
        await supabase.from('transport_request_items').delete().eq('transport_request_id', editingRequestId)
      } else {
        // INSERT
        const { data: requestData, error: requestError } = await supabase
          .from('transport_requests')
          .insert([{ 
            request_number: requestNumber,
            requester_name: newRequest.requester_name,
            department: finalDepartment,
            pickup_address: newRequest.pickup_address,
            pickup_department: newRequest.pickup_department,
            pickup_province: newRequest.pickup_province,
            pickup_district: newRequest.pickup_district,
            delivery_address: newRequest.delivery_address,
            delivery_department: newRequest.delivery_department,
            delivery_province: newRequest.delivery_province,
            delivery_district: newRequest.delivery_district,
            required_date: newRequest.required_date,
            time_window: newRequest.time_window,
            cargo_description: compiledDescription,
            estimated_weight: totalWeight,
            request_type: newRequest.request_type,
            ot_reference: newRequest.ot_reference || null,
            status: 'PENDIENTE DE APROBACIÓN'
          }])
          .select()
          .single()

        if (requestError) throw requestError
        targetRequestId = requestData.id
      }

      // Insert Items
      if (targetRequestId && requestItems.length > 0) {
        const itemsToInsert = requestItems.map(item => {
          const product = products.find(p => p.id === item.product_id)
          return {
            transport_request_id: targetRequestId,
            product_id: item.product_id || null,
            sku: product?.sku || null,
            description: item.product_description,
            quantity: item.quantity,
            weight: item.weight,
            volume_m3: item.volume_m3,
            length_m: item.length_m,
            width_m: item.width_m,
            is_fragile: item.is_fragile,
            needs_stowage: item.needs_stowage,
            needs_forklift: item.needs_forklift
          }
        })

        const { error: itemsError } = await supabase
          .from('transport_request_items')
          .insert(itemsToInsert)

        if (itemsError) throw itemsError
      }

      toast.success('Solicitud enviada correctamente')
      setIsModalOpen(false)
      setNewRequest(prev => ({
        ...prev, 
        department: '',
        pickup_address: 'Planta Chilca',
        pickup_department: 'LIMA',
        pickup_province: 'CAÑETE',
        pickup_district: 'CHILCA',
        delivery_address: '',
        delivery_department: '',
        delivery_province: '',
        delivery_district: '',
        required_date: '',
        time_window: '',
        ot_reference: '',
        notes: ''
      }))
      setRequestItems([])
      fetchRequests()
    } catch (error: any) {
      toast.error('Error al enviar solicitud: ' + error.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const updateStatus = async (id: string, newStatus: string) => {
    try {
      const { error } = await supabase
        .from('transport_requests')
        .update({ status: newStatus })
        .eq('id', id)

      if (error) throw error
      
      toast.success(`Solicitud ${newStatus.toLowerCase()}`)
      fetchRequests()
    } catch (error: any) {
      toast.error('Error al actualizar estado: ' + error.message)
    }
  }

  const handleCancelRequest = async (id: string) => {
    if (!confirm('¿Estás seguro de cancelar esta solicitud? Si ya estaba en un despacho, será retirada.')) return;
    try {
      // 1. Remove from dispatch_requests if it was there
      await supabase.from('dispatch_requests').delete().eq('transport_request_id', id);
      
      // 2. Update status
      const { error } = await supabase.from('transport_requests').update({ status: 'CANCELADA' }).eq('id', id);
      if (error) throw error;
      
      toast.success('Solicitud cancelada exitosamente.');
      fetchRequests();
    } catch (err: any) {
      toast.error('Error al cancelar: ' + err.message);
    }
  }

  const handleRescheduleRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRequestId || !newRescheduleDate) return;
    
    try {
      setIsSubmitting(true);
      const { error } = await supabase
        .from('transport_requests')
        .update({ 
          status: 'REPROGRAMADA', 
          required_date: newRescheduleDate 
        })
        .eq('id', selectedRequestId);
        
      if (error) throw error;
      
      toast.success('Solicitud reprogramada exitosamente.');
      setIsRescheduleModalOpen(false);
      fetchRequests();
    } catch (err: any) {
      toast.error('Error al reprogramar: ' + err.message);
    } finally {
      setIsSubmitting(false);
    }
  }

  const getStatusBadge = (status: string) => {
    switch(status) {
      case 'PENDIENTE DE APROBACIÓN':
      case 'PENDIENTE':
        return <span className="bg-yellow-100 text-yellow-800 px-2 py-1 rounded text-xs font-semibold">Pendiente de Aprobación</span>
      case 'APROBADA':
      case 'APROBADO':
        return <span className="bg-green-100 text-green-800 px-2 py-1 rounded text-xs font-semibold">Aprobada</span>
      case 'RECHAZADA':
        return <span className="bg-red-100 text-red-800 px-2 py-1 rounded text-xs font-semibold">Rechazada</span>
      case 'CANCELADA':
        return <span className="bg-slate-200 text-slate-600 px-2 py-1 rounded text-xs font-semibold line-through">Cancelada</span>
      case 'REPROGRAMADA':
        return <span className="bg-orange-100 text-orange-800 px-2 py-1 rounded text-xs font-semibold">Reprogramada</span>
      default:
        return <span className="bg-slate-100 text-slate-800 px-2 py-1 rounded text-xs font-semibold">{status}</span>
    }
  }

  // Computed values for OT budget check
  const selectedOt = workOrders.find(ot => ot.ot_number.toLowerCase() === newRequest.ot_reference.toLowerCase())
  const hasOtSelected = !!selectedOt
  const hasBudgetLimit = hasOtSelected && (selectedOt.budget_amount || 0) > 0
  
  // Calculate consumed budget using the already fetched `requests` array
  const dynamicConsumedBudget = hasOtSelected 
    ? requests
        .filter(r => r.status !== 'CANCELADA' && r.ot_reference === selectedOt.ot_number)
        .reduce((sum, r) => sum + (Number(r.service_cost) || 0), 0)
    : 0

  const availableBudget = hasOtSelected ? (selectedOt.budget_amount || 0) - dynamicConsumedBudget : 0
  const isBudgetExhausted = hasBudgetLimit && availableBudget <= 0

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Solicitudes de Transporte</h1>
          <p className="text-sm text-slate-500">Gestión de requerimientos internos de servicio</p>
        </div>
        {canWrite('solicitudes') && (
          <button 
            onClick={() => {
              if (products.length === 0) fetchProducts()
              if (workOrders.length === 0) fetchWorkOrders()
              setEditingRequestId(null)
              setNewRequest({
                requester_name: '',
                department: '',
                request_type: 'DESPACHO',
                pickup_address: 'Planta Chilca',
                pickup_department: 'LIMA',
                pickup_province: 'CAETE',
                pickup_district: 'CHILCA',
                delivery_address: '',
                delivery_department: '',
                delivery_province: '',
                delivery_district: '',
                required_date: '',
                time_window: '',
                ot_reference: '',
                notes: ''
              })
              setRequestItems([])
              setIsModalOpen(true)
            }}
            className="flex items-center gap-2 bg-[#002855] text-white px-4 py-2 rounded-lg font-medium hover:bg-[#001d3d] transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" />
            Nueva Solicitud
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase">Total (Mes)</p>
            <p className="text-2xl font-bold text-[#002855]">{requests.length}</p>
          </div>
          <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center">
            <Activity className="w-5 h-5 text-blue-500" />
          </div>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase">Aprobadas</p>
            <p className="text-2xl font-bold text-green-600">{requests.filter(r => r.status === 'APROBADA' || r.status === 'EN_TRANSITO').length}</p>
          </div>
          <div className="w-10 h-10 rounded-full bg-green-50 flex items-center justify-center">
            <Check className="w-5 h-5 text-green-500" />
          </div>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase">Reprogramadas</p>
            <p className="text-2xl font-bold text-orange-600">{requests.filter(r => r.status === 'REPROGRAMADA').length}</p>
          </div>
          <div className="w-10 h-10 rounded-full bg-orange-50 flex items-center justify-center">
            <CalendarClock className="w-5 h-5 text-orange-500" />
          </div>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase">Canceladas</p>
            <p className="text-2xl font-bold text-slate-600">{requests.filter(r => r.status === 'CANCELADA').length}</p>
          </div>
          <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center">
            <Ban className="w-5 h-5 text-slate-500" />
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
          <div className="relative w-72">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
            <input 
              type="text" 
              placeholder="Buscar por código o solicitante..." 
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
                <th className="p-4 font-semibold">Código</th>
                <th className="p-4 font-semibold">Solicitante</th>
                <th className="p-4 font-semibold">Ruta (Origen - Destino)</th>
                <th className="p-4 font-semibold">Fecha Req.</th>
                <th className="p-4 font-semibold">Estado</th>
                <th className="p-4 font-semibold text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-slate-500">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                    Cargando solicitudes...
                  </td>
                </tr>
              ) : requests.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-slate-500">
                    No hay solicitudes registradas.
                  </td>
                </tr>
              ) : (
                requests.map(req => (
                  <tr key={req.id} className="hover:bg-slate-50 transition-colors">
                    <td className="p-4">
                      <span className="font-bold text-[#002855] text-sm">{req.request_number}</span>
                    </td>
                    <td className="p-4">
                      <div className="flex flex-col">
                        <span className="font-medium text-slate-800 text-sm">{req.requester_name}</span>
                        {req.department.startsWith('OT -') ? (
                          <span className="text-[10px] font-semibold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full w-fit mt-1 border border-blue-100">
                            {req.department}
                          </span>
                        ) : (
                          <span className="text-xs text-slate-500 mt-0.5">{req.department}</span>
                        )}
                      </div>
                    </td>
                    <td className="p-4 text-sm max-w-[200px]">
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-1.5 text-slate-700 font-medium truncate" title={`${req.pickup_address} → ${req.delivery_address}`}>
                          <span className="truncate max-w-[120px]" title={req.pickup_address}>{req.pickup_address || '-'}</span>
                          <span className="text-slate-300">→</span>
                          <span className="truncate max-w-[120px]" title={req.delivery_address}>{req.delivery_address || '-'}</span>
                        </div>
                        {req.transport_request_items && (
                          <div className="text-[10px] text-slate-400 font-medium">
                            {(req.transport_request_items.reduce((sum: number, item: any) => sum + ((item.weight || 0) * (item.quantity || 1)), 0)).toFixed(2)} KG • {(req.transport_request_items.reduce((sum: number, item: any) => sum + ((item.volume_m3 || 0) * (item.quantity || 1)), 0)).toFixed(2)} M³
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="p-4 text-sm text-slate-600">
                      <div className="flex flex-col">
                        <span className="flex items-center gap-1 font-medium">
                          <Calendar className="w-3 h-3 text-slate-400" />
                          {new Date(req.required_date).toLocaleDateString()}
                        </span>
                        {req.time_window && (
                          <span className="flex items-center gap-1 text-xs text-slate-500 mt-0.5">
                            <Clock className="w-3 h-3" />
                            {req.time_window}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="p-4">
                      {getStatusBadge(req.status)}
                    </td>
                    <td className="p-4 text-right">
                      {(req.status === 'PENDIENTE DE APROBACIÓN' || req.status === 'PENDIENTE') && (userRole.includes('admin') || userRole.includes('supervisor') || userRole.includes('despacho') || userRole.includes('transporte')) && (
                        <div className="flex justify-end gap-2 mb-2">
                          <button 
                            onClick={() => updateStatus(req.id, 'APROBADA')}
                            title="Aprobar"
                            className="p-1.5 text-green-600 bg-green-50 hover:bg-green-100 transition-colors rounded border border-green-200"
                          >
                            <Check className="w-4 h-4" />
                          </button>
                          <button 
                            onClick={() => updateStatus(req.id, 'RECHAZADA')}
                            title="Rechazar"
                            className="p-1.5 text-red-600 bg-red-50 hover:bg-red-100 transition-colors rounded border border-red-200"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                      {canWrite('solicitudes') && (req.status === 'PENDIENTE DE APROBACIÓN' || req.status === 'PENDIENTE' || req.status === 'APROBADA') && (
                        <div className="flex justify-end gap-2 mt-1">
                          <button 
                            onClick={() => openEditModal(req)}
                            title="Editar Solicitud"
                            className="p-1.5 text-blue-600 bg-blue-50 hover:bg-blue-100 transition-colors rounded border border-blue-200"
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          <button 
                            onClick={() => {
                              setSelectedRequestId(req.id)
                              setNewRescheduleDate(req.required_date.split('T')[0] || '')
                              setIsRescheduleModalOpen(true)
                            }}
                            title="Reprogramar Fecha"
                            className="p-1.5 text-orange-600 bg-orange-50 hover:bg-orange-100 transition-colors rounded border border-orange-200"
                          >
                            <CalendarClock className="w-4 h-4" />
                          </button>
                          <button 
                            onClick={() => handleCancelRequest(req.id)}
                            title="Cancelar Solicitud"
                            className="p-1.5 text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors rounded border border-slate-300"
                          >
                            <Ban className="w-4 h-4" />
                          </button>
                        </div>
                      )}
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
        title="Crear Nueva Solicitud"
        maxWidth="max-w-5xl"
      >
        <form onSubmit={handleCreateRequest} className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Solicitante</label>
              <input 
                type="text" 
                required
                disabled={userRole !== 'admin'}
                placeholder="Nombre completo"
                className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none disabled:bg-slate-100 disabled:text-slate-500"
                value={newRequest.requester_name}
                onChange={(e) => setNewRequest({...newRequest, requester_name: e.target.value})}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Área / Departamento</label>
              <select
                required
                className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                value={newRequest.department}
                onChange={(e) => {
                  setNewRequest({...newRequest, department: e.target.value, ot_reference: ''})
                }}
              >
                <option value="" disabled>Seleccionar Área...</option>
                <option value="OT (Administración de Contratos)">OT (Administración de Contratos)</option>
                <option value="Recursos Humanos">Recursos Humanos</option>
                <option value="Logística">Logística</option>
                <option value="Gerencia">Gerencia</option>
                <option value="Producción">Producción</option>
                <option value="Almacén">Almacén</option>
                <option value="Otros">Otros</option>
              </select>
            </div>
            
            {newRequest.department === 'OT (Administración de Contratos)' && (
              <div className="col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Número de OT Asociada (Obligatorio)</label>
                <select
                  required
                  className="w-full px-3 py-2 bg-yellow-50 text-slate-900 border border-yellow-300 rounded-lg focus:ring-2 focus:ring-yellow-500 outline-none"
                  value={newRequest.ot_reference}
                  onChange={(e) => handleOtReferenceChange(e.target.value)}
                >
                  <option value="" disabled>Seleccione una OT registrada...</option>
                  {workOrders.map(ot => (
                    <option key={ot.id} value={ot.ot_number}>{ot.ot_number} - {ot.destination_address || 'Sin destino'}</option>
                  ))}
                </select>
                {hasBudgetLimit && (
                  <div className={`mt-1.5 flex items-center gap-1.5 text-xs font-semibold ${isBudgetExhausted ? 'text-red-600' : 'text-emerald-600'}`}>
                    {isBudgetExhausted ? (
                      <>
                        <Ban className="w-3.5 h-3.5" />
                        Partida Agotada (S/ {availableBudget.toLocaleString('en-US', { minimumFractionDigits: 2 })})
                      </>
                    ) : (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        Partida Disponible: S/ {availableBudget.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
            {newRequest.department !== 'OT (Administración de Contratos)' && (
              <div className="col-span-2 mt-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">¿Asociar a Número de OT? (Opcional)</label>
                <select
                  className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                  value={newRequest.ot_reference}
                  onChange={(e) => handleOtReferenceChange(e.target.value)}
                >
                  <option value="">Sin asociar a OT</option>
                  {workOrders.map(ot => (
                    <option key={ot.id} value={ot.ot_number}>{ot.ot_number} - {ot.destination_address || 'Sin destino'}</option>
                  ))}
                </select>
                {hasBudgetLimit && (
                  <div className={`mt-1.5 flex items-center gap-1.5 text-xs font-semibold ${isBudgetExhausted ? 'text-red-600' : 'text-emerald-600'}`}>
                    {isBudgetExhausted ? (
                      <>
                        <Ban className="w-3.5 h-3.5" />
                        Partida Agotada (S/ {availableBudget.toLocaleString('en-US', { minimumFractionDigits: 2 })})
                      </>
                    ) : (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        Partida Disponible: S/ {availableBudget.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="bg-slate-50 p-4 rounded-lg border border-slate-200 mt-4">
            <label className="block text-sm font-semibold text-slate-800 mb-3">Tipo de Solicitud</label>
            <div className="flex gap-6">
              <label className="flex items-center gap-2 cursor-pointer">
                <input 
                  type="radio" 
                  name="request_type" 
                  value="DESPACHO"
                  checked={newRequest.request_type === 'DESPACHO'}
                  onChange={(e) => setNewRequest({...newRequest, request_type: e.target.value, pickup_address: 'Planta Chilca', delivery_address: ''})}
                  className="w-4 h-4 text-[#002855] focus:ring-[#002855]"
                />
                <span className="text-sm font-medium text-slate-700">Despacho (Salida de Planta)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input 
                  type="radio" 
                  name="request_type" 
                  value="RECOJO"
                  checked={newRequest.request_type === 'RECOJO'}
                  onChange={(e) => setNewRequest({...newRequest, request_type: e.target.value, pickup_address: '', delivery_address: 'Planta Chilca'})}
                  className="w-4 h-4 text-[#002855] focus:ring-[#002855]"
                />
                <span className="text-sm font-medium text-slate-700">Recojo (Retorno a Planta)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input 
                  type="radio" 
                  name="request_type" 
                  value="TRASLADO"
                  checked={newRequest.request_type === 'TRASLADO'}
                  onChange={(e) => setNewRequest({...newRequest, request_type: e.target.value, pickup_address: '', delivery_address: ''})}
                  className="w-4 h-4 text-[#002855] focus:ring-[#002855]"
                />
                <span className="text-sm font-medium text-slate-700">Traslado (Punto a Punto)</span>
              </label>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
            <div className="col-span-2 md:col-span-2 border border-slate-200 rounded-lg p-3 bg-slate-50/50">
              <h4 className="text-sm font-semibold text-slate-800 mb-2">Origen de Carga</h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="md:col-span-3">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Dirección Exacta</label>
                  <input 
                    type="text" 
                    required
                    className="w-full px-3 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                    value={newRequest.pickup_address}
                    onChange={(e) => setNewRequest({...newRequest, pickup_address: e.target.value})}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Departamento</label>
                  <input 
                    type="text" 
                    placeholder="Ej. LIMA"
                    className="w-full px-3 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                    value={newRequest.pickup_department}
                    onChange={(e) => setNewRequest({...newRequest, pickup_department: e.target.value.toUpperCase()})}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Provincia</label>
                  <input 
                    type="text" 
                    placeholder="Ej. CAÑETE"
                    className="w-full px-3 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                    value={newRequest.pickup_province}
                    onChange={(e) => setNewRequest({...newRequest, pickup_province: e.target.value.toUpperCase()})}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Distrito *</label>
                  <input 
                    type="text" 
                    required
                    placeholder="Ej. CHILCA"
                    className="w-full px-3 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                    value={newRequest.pickup_district}
                    onChange={(e) => setNewRequest({...newRequest, pickup_district: e.target.value.toUpperCase()})}
                  />
                </div>
              </div>
            </div>
            
            <div className="col-span-2 md:col-span-2 border border-slate-200 rounded-lg p-3 bg-slate-50/50">
              <h4 className="text-sm font-semibold text-slate-800 mb-2">Destino de Carga</h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="md:col-span-3">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Dirección Exacta</label>
                  <input 
                    type="text" 
                    required
                    className="w-full px-3 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                    value={newRequest.delivery_address}
                    onChange={(e) => setNewRequest({...newRequest, delivery_address: e.target.value})}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Departamento</label>
                  <input 
                    type="text" 
                    placeholder="Ej. LIMA"
                    className="w-full px-3 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                    value={newRequest.delivery_department}
                    onChange={(e) => setNewRequest({...newRequest, delivery_department: e.target.value.toUpperCase()})}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Provincia</label>
                  <input 
                    type="text" 
                    placeholder="Ej. LIMA"
                    className="w-full px-3 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                    value={newRequest.delivery_province}
                    onChange={(e) => setNewRequest({...newRequest, delivery_province: e.target.value.toUpperCase()})}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Distrito *</label>
                  <input 
                    type="text" 
                    required
                    placeholder="Ej. ATE"
                    className="w-full px-3 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                    value={newRequest.delivery_district}
                    onChange={(e) => setNewRequest({...newRequest, delivery_district: e.target.value.toUpperCase()})}
                  />
                </div>
              </div>
            </div>
            <div className="col-span-2 md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Fecha Requerida</label>
              <input 
                type="date" 
                required
                className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                value={newRequest.required_date}
                onChange={(e) => setNewRequest({...newRequest, required_date: e.target.value})}
              />
            </div>
            <div className="col-span-2 md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Ventana Horaria (Opcional)</label>
              <input 
                type="text" 
                placeholder="Ej. 08:00 AM - 12:00 PM"
                className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                value={newRequest.time_window}
                onChange={(e) => setNewRequest({...newRequest, time_window: e.target.value})}
              />
            </div>
          </div>

          {/* Tabla Dinámica de Productos y Carga Masiva */}
          <div className="mt-6 border-t border-slate-200 pt-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold text-slate-800">Detalle de la Carga</h3>
              
              <div className="flex gap-2">
                {/* Oculto input para archivo */}
                <input 
                  type="file" 
                  ref={fileInputRef} 
                  onChange={handleFileUpload} 
                  accept=".xlsx, .xls"
                  className="hidden" 
                />
                <button 
                  type="button" 
                  onClick={downloadTemplate}
                  className="flex items-center gap-1.5 text-xs bg-white text-slate-600 border border-slate-300 px-3 py-1.5 rounded-lg hover:bg-slate-50 transition-colors font-medium"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" />
                  Plantilla
                </button>
                <button 
                  type="button" 
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-1.5 text-xs bg-white text-green-700 border border-green-300 px-3 py-1.5 rounded-lg hover:bg-green-50 transition-colors font-medium"
                >
                  <Upload className="w-3.5 h-3.5" />
                  Carga Masiva
                </button>
                <div className="w-px h-6 bg-slate-300 mx-1 self-center"></div>
                <button 
                  type="button" 
                  onClick={handleAddItem}
                  className="flex items-center gap-2 text-sm bg-slate-100 text-[#002855] px-3 py-1.5 rounded-lg hover:bg-slate-200 transition-colors font-medium"
                >
                  <Plus className="w-4 h-4" />
                  Añadir Producto
                </button>
              </div>
            </div>
            
            <div className="bg-slate-50 border border-slate-200 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="bg-slate-100 border-b border-slate-200 text-xs text-slate-600 font-medium">
                    <tr>
                      <th className="p-3 w-64">Producto o Glosa</th>
                      <th className="p-3 w-24">Cant.</th>
                      <th className="p-3 w-24 text-center">Peso Tot.</th>
                      <th className="p-3 w-24 text-center">Vol. Tot.</th>
                      <th className="p-3">Req. Especiales (Opcional)</th>
                      <th className="p-3 w-12 text-center"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 bg-white">
                    {requestItems.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="p-8 text-center text-slate-500 text-sm">
                          Añade productos manualmente o usa la Carga Masiva. Los pesos y volúmenes se calculan automáticamente.
                        </td>
                      </tr>
                    ) : (
                      requestItems.map((item, index) => {
                        const isOT = newRequest.department === 'OT (Administración de Contratos)' || newRequest.department.startsWith('OT -')
                        return (
                        <tr key={item.id} className="text-sm">
                          <td className="p-3">
                            {isOT ? (
                              <select
                                required
                                className="w-full px-2 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm focus:ring-1 focus:ring-[#002855]"
                                value={item.product_id}
                                onChange={(e) => handleItemChange(item.id, 'product_id', e.target.value)}
                              >
                                <option value="" disabled>Seleccionar de Maestro...</option>
                                {products.map(p => (
                                  <option key={p.id} value={p.id}>{p.sku} - {p.description}</option>
                                ))}
                              </select>
                            ) : (
                              <input
                                type="text"
                                required
                                placeholder="Descripción del ítem..."
                                className="w-full px-2 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm focus:ring-1 focus:ring-[#002855]"
                                value={item.product_description || ''}
                                onChange={(e) => handleItemChange(item.id, 'product_description', e.target.value)}
                              />
                            )}
                          </td>
                          <td className="p-3">
                            <input
                              type="number"
                              min="1"
                              step="1"
                              required
                              className="w-full px-2 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm text-center"
                              value={item.quantity}
                              onChange={(e) => handleItemChange(item.id, 'quantity', parseFloat(e.target.value) || 1)}
                            />
                          </td>
                          <td className="p-3 text-center align-middle">
                            {isOT ? (
                              <span className="text-xs font-semibold text-slate-700 bg-slate-100 px-2 py-1 rounded block w-full">
                                {(() => {
                                  const prod = products.find(p => p.id === item.product_id);
                                  return prod ? ((prod.weight || 0) * item.quantity).toFixed(2) : '0.00';
                                })()} kg
                              </span>
                            ) : (
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                placeholder="Peso un."
                                className="w-full px-2 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm text-center"
                                value={item.weight || 0}
                                onChange={(e) => handleItemChange(item.id, 'weight', parseFloat(e.target.value) || 0)}
                                title="Peso unitario en kg"
                              />
                            )}
                          </td>
                          <td className="p-3 text-center align-middle">
                            {isOT ? (
                              <span className="text-xs font-semibold text-slate-700 bg-slate-100 px-2 py-1 rounded block w-full">
                                {(() => {
                                  const prod = products.find(p => p.id === item.product_id);
                                  return prod ? ((prod.volume_m3 || 0) * item.quantity).toFixed(4) : '0.0000';
                                })()} m³
                              </span>
                            ) : (
                              <input
                                type="number"
                                min="0"
                                step="0.001"
                                placeholder="Vol. un."
                                className="w-full px-2 py-1.5 bg-white text-slate-900 border border-slate-300 rounded text-sm text-center"
                                value={item.volume_m3 || 0}
                                onChange={(e) => handleItemChange(item.id, 'volume_m3', parseFloat(e.target.value) || 0)}
                                title="Volumen unitario en m3"
                              />
                            )}
                          </td>
                          <td className="p-3">
                            <div className="flex gap-4 justify-start items-center flex-wrap">
                              <label className="flex items-center gap-1.5 text-xs cursor-pointer text-slate-600 font-medium hover:text-slate-800 transition-colors">
                                <input 
                                  type="checkbox" 
                                  className="rounded border-slate-300 text-[#002855] focus:ring-[#002855] cursor-pointer"
                                  checked={item.is_fragile}
                                  onChange={(e) => handleItemChange(item.id, 'is_fragile', e.target.checked)}
                                /> 
                                Frágil
                              </label>
                              <label className="flex items-center gap-1.5 text-xs cursor-pointer text-slate-600 font-medium hover:text-slate-800 transition-colors">
                                <input 
                                  type="checkbox" 
                                  className="rounded border-slate-300 text-[#002855] focus:ring-[#002855] cursor-pointer"
                                  checked={item.needs_stowage}
                                  onChange={(e) => handleItemChange(item.id, 'needs_stowage', e.target.checked)}
                                /> 
                                Req. Estiba
                              </label>
                              <label className="flex items-center gap-1.5 text-xs cursor-pointer text-slate-600 font-medium hover:text-slate-800 transition-colors">
                                <input 
                                  type="checkbox" 
                                  className="rounded border-slate-300 text-[#002855] focus:ring-[#002855] cursor-pointer"
                                  checked={item.needs_forklift}
                                  onChange={(e) => handleItemChange(item.id, 'needs_forklift', e.target.checked)}
                                /> 
                                Req. Montacarga
                              </label>
                            </div>
                          </td>
                          <td className="p-3 text-center">
                            <button 
                              type="button" 
                              onClick={() => handleRemoveItem(item.id)}
                              className="text-slate-400 hover:text-red-500 hover:bg-red-50 p-1.5 rounded transition-colors"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      )
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Notas / Referencias Generales</label>
            <textarea 
              rows={2}
              placeholder="Cualquier información adicional sobre la entrega..."
              className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none resize-none"
              value={newRequest.notes}
              onChange={(e) => setNewRequest({...newRequest, notes: e.target.value})}
            />
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
              disabled={isSubmitting || isBudgetExhausted}
              className="px-4 py-2 bg-[#002855] text-white font-medium rounded-lg hover:bg-[#001d3d] transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Enviar Solicitud
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={isRescheduleModalOpen}
        onClose={() => setIsRescheduleModalOpen(false)}
        title="Reprogramar Solicitud"
        maxWidth="max-w-md"
      >
        <form onSubmit={handleRescheduleRequest} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Nueva Fecha Requerida</label>
            <input 
              type="date" 
              required
              min={new Date().toISOString().split('T')[0]}
              className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
              value={newRescheduleDate}
              onChange={(e) => setNewRescheduleDate(e.target.value)}
            />
          </div>
          <div className="pt-4 flex justify-end gap-3 border-t border-slate-200">
            <button 
              type="button" 
              onClick={() => setIsRescheduleModalOpen(false)}
              className="px-4 py-2 text-slate-600 font-medium hover:bg-slate-100 rounded-lg transition-colors"
            >
              Cancelar
            </button>
            <button 
              type="submit" 
              disabled={isSubmitting}
              className="px-4 py-2 bg-orange-600 text-white font-medium rounded-lg hover:bg-orange-700 transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarClock className="w-4 h-4" />}
              Confirmar
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
