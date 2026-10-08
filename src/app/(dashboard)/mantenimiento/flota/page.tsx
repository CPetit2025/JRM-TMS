"use client"
import { PageHeader } from '@/components/ui/page-header'
import { DataTable } from '@/components/ui/data-table'
import { TableActions } from '@/components/ui/table-actions'

import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Truck, Users, Plus, Edit2, Trash2, Search, AlertCircle, Loader2, Filter, Upload, Ban, Download, KeyRound, Eye, EyeOff, ShieldCheck, Wrench, Lock } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import * as XLSX from 'xlsx'
import { usePermissions } from '@/hooks/usePermissions'
import { emptyFleetFilters, filterFleetVehicles, filterFleetDrivers, type FleetFilters } from '@/lib/fleet-filters'
import { limaDay } from '@/lib/preuse'

// Estados y tipos canónicos de activos (migraciones 20260924133100 y 20260926200000).
// El estado solo cambia vía transition_vehicle_status: la BD rechaza updates directos.
const VEHICLE_STATUSES = ['DISPONIBLE', 'ASIGNADA', 'EN_OPERACION', 'OBSERVADA', 'MANTENIMIENTO', 'BLOQUEADA', 'FUERA_DE_SERVICIO']
const VEHICLE_TYPES: Record<string, string> = {
  CAMION: 'Camión', CAMIONETA: 'Camioneta', FURGON: 'Furgón', TRAILER: 'Tráiler', TRACTO: 'Tracto',
  SEMIRREMOLQUE: 'Semirremolque', MONTACARGAS: 'Montacargas', APILADOR: 'Apilador', TRANSPALETA: 'Transpaleta', OTRO: 'Otro equipo',
}
const STATUS_BADGE: Record<string, string> = {
  DISPONIBLE: 'bg-emerald-100 text-emerald-700',
  ASIGNADA: 'bg-sky-100 text-sky-700',
  EN_OPERACION: 'bg-blue-100 text-blue-700',
  OBSERVADA: 'bg-yellow-100 text-yellow-800',
  MANTENIMIENTO: 'bg-amber-100 text-amber-700',
  BLOQUEADA: 'bg-red-100 text-red-700',
  FUERA_DE_SERVICIO: 'bg-slate-200 text-slate-600',
}

function normalizeVehicleType(raw: unknown): string {
  const value = String(raw ?? '').trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  return value in VEHICLE_TYPES ? value : 'OTRO'
}

export default function FlotaPage() {
  const supabase = createClient()
  const router = useRouter()
  const { role } = usePermissions()
  const [activeTab, setActiveTab] = useState<'vehicles' | 'drivers'>('vehicles')
  
  // Data states
  const [vehicles, setVehicles] = useState<any[]>([])
  const [drivers, setDrivers] = useState<any[]>([])
  const [carriers, setCarriers] = useState<any[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Modals & Edit States
  const [isVehicleModalOpen, setIsVehicleModalOpen] = useState(false)
  const [isDriverModalOpen, setIsDriverModalOpen] = useState(false)
  const [editingVehicleId, setEditingVehicleId] = useState<string | null>(null)
  const [editingDriverId, setEditingDriverId] = useState<string | null>(null)
  // Vencimientos al abrir la edición: si cambian se registran como documento (renovación o corrección)
  const [originalDocs, setOriginalDocs] = useState({ soat: '', rt: '' })
  const [nextCode, setNextCode] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [vehicleFilters, setVehicleFilters] = useState<FleetFilters>({ ...emptyFleetFilters })
  const [driverFilters, setDriverFilters] = useState<FleetFilters>({ ...emptyFleetFilters })
  const filters = activeTab === 'vehicles' ? vehicleFilters : driverFilters
  const setFilters = activeTab === 'vehicles' ? setVehicleFilters : setDriverFilters
  const updateFilter = (key: keyof FleetFilters, value: string) => setFilters(current => ({ ...current, [key]: value }))
  const activeFilterCount = Object.values(filters).filter(Boolean).length
  const [showFilters, setShowFilters] = useState(false)
  
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isImporting, setIsImporting] = useState(false)
  const [accessDriver, setAccessDriver] = useState<any | null>(null)
  const [accessPassword, setAccessPassword] = useState('')
  const [showAccessPassword, setShowAccessPassword] = useState(false)
  const [isSavingAccess, setIsSavingAccess] = useState(false)
  
  const filteredVehicles = filterFleetVehicles(vehicles, drivers, carriers, vehicleFilters, limaDay())
  const filteredDrivers = filterFleetDrivers(drivers, vehicles, carriers, driverFilters)

  // Forms
  const [newVehicle, setNewVehicle] = useState({
    plate: '',
    carrier_id: '',
    type: 'CAMION',
    brand: '',
    model: '',
    year: new Date().getFullYear(),
    weight_capacity: 0,
    volume_capacity: 0,
    status: 'DISPONIBLE',
    soat_expiration: '',
    technical_review_expiration: '',
    internal_code: '',
    serial_number: '',
    criticality: 'MEDIA',
    ownership_status: 'PROPIO',
    current_hours: 0,
    responsible_id: '',
    assigned_driver_id: '',
    current_location: ''
  })
  // Código que se asignará automáticamente según el tipo de unidad
  useEffect(() => {
    if (!isVehicleModalOpen || editingVehicleId) return
    let alive = true
    supabase.rpc('next_vehicle_internal_code', { p_type: newVehicle.type }).then(({ data }) => { if (alive) setNextCode(typeof data === 'string' ? data : '') })
    return () => { alive = false }
  }, [isVehicleModalOpen, editingVehicleId, newVehicle.type])  // eslint-disable-line react-hooks/exhaustive-deps

  const [newDriver, setNewDriver] = useState({
    document_number: '',
    carrier_id: '',
    first_name: '',
    last_name: '',
    phone: '',
    license_number: '',
    license_category: 'A-I',
    license_expiration: '',
    is_active: true
  })

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    setIsLoading(true)
    try {
      // 1. Fetch carriers (Transportistas)
      const { data: carriersData, error: carrierError } = await supabase
        .from('carriers')
        .select('*')
        .order('business_name')
      
      if (carrierError) throw carrierError
      setCarriers(carriersData || [])

      // Set default carrier_id for forms if available
      const defaultCarrier = carriersData?.find(c => c.type === 'PROPIO') || carriersData?.[0]
      if (defaultCarrier) {
        setNewVehicle(prev => ({ ...prev, carrier_id: defaultCarrier.id }))
        setNewDriver(prev => ({ ...prev, carrier_id: defaultCarrier.id }))
      }

      // 2. Fetch vehicles
      const { data: vehiclesData, error: vehiclesError } = await supabase
        .from('vehicles')
        .select('*, carriers(business_name)')
        .order('created_at', { ascending: false })
      if (vehiclesError) throw vehiclesError
      setVehicles(vehiclesData || [])

      // 3. Fetch drivers
      const { data: driversData, error: driversError } = await supabase
        .from('drivers')
        .select('*, carriers(business_name)')
        .order('created_at', { ascending: false })
      if (driversError) throw driversError
      setDrivers(driversData || [])

    } catch (err: any) {
      console.error('Error fetching flota data:', err)
      setError('Error al cargar los datos de flota')
    } finally {
      setIsLoading(false)
    }
  }

  const handleSaveVehicle = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    try {
      let error;
      
      // El estado no se edita desde el formulario: lo gobierna el motor de elegibilidad
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { status: _status, ...vehicleFields } = newVehicle
      const payload = {
        ...vehicleFields,
        internal_code: newVehicle.internal_code.trim() || null,
        soat_expiration: newVehicle.soat_expiration || null,
        technical_review_expiration: newVehicle.technical_review_expiration || null,
        responsible_id: newVehicle.responsible_id || null,
        assigned_driver_id: newVehicle.assigned_driver_id || null
      }

      if (editingVehicleId) {
        // SOAT y RT se guardan como documento de la unidad (el vehículo refleja el vigente)
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { soat_expiration: _soat, technical_review_expiration: _rt, ...editable } = payload
        const { error: updateError } = await supabase
          .from('vehicles')
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          .update(editable.internal_code ? editable : (({ internal_code: _code, ...rest }) => rest)(editable))
          .eq('id', editingVehicleId)
          .select('id')
          .single()
        error = updateError
        const soat = newVehicle.soat_expiration !== originalDocs.soat ? newVehicle.soat_expiration || null : null
        const rt = newVehicle.technical_review_expiration !== originalDocs.rt ? newVehicle.technical_review_expiration || null : null
        if (!error && (soat || rt)) {
          const { data: docs, error: docsError } = await supabase.rpc('update_vehicle_compliance_dates', { p_vehicle_id: editingVehicleId, p_soat: soat, p_rt: rt })
          if (docsError || !docs?.success) {
            toast.error(`Datos guardados, pero no se actualizaron SOAT/RT: ${docsError?.message || docs?.error}`)
          } else {
            toast.success('Vencimientos actualizados y registrados en Cumplimiento → Documentos')
          }
        }
      } else {
        const { error: insertError } = await supabase
          .from('vehicles')
          .insert([payload])
        error = insertError
      }

      if (error) throw error

      if (editingVehicleId) toast.success('Vehículo guardado. La asignación se actualizará automáticamente en el app.')
      const assigned = drivers.find(d => d.id === newVehicle.assigned_driver_id)
      if (assigned && !assigned.profile_id) toast.warning('Conductor asignado sin cuenta de app. Habilite su acceso desde la pestaña Conductores.')
      if (!editingVehicleId) {
        toast.success('Vehículo registrado como OBSERVADA. Libérelo cuando cumpla los requisitos de elegibilidad.')
      }
      setIsVehicleModalOpen(false)
      fetchData()
    } catch (err: any) {
      toast.error(`No se pudo guardar el vehículo: ${err?.message || 'Verifique la placa y los datos.'}`)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleEditVehicle = (v: any) => {
    setEditingVehicleId(v.id)
    setOriginalDocs({ soat: v.soat_expiration || '', rt: v.technical_review_expiration || '' })
    setNewVehicle({
      plate: v.plate,
      carrier_id: v.carrier_id,
      type: v.type,
      brand: v.brand || '',
      model: v.model || '',
      year: v.year,
      weight_capacity: v.weight_capacity,
      volume_capacity: v.volume_capacity,
      status: v.status,
      soat_expiration: v.soat_expiration || '',
      technical_review_expiration: v.technical_review_expiration || '',
      internal_code: v.internal_code || '',
      serial_number: v.serial_number || '',
      criticality: v.criticality || 'MEDIA',
      ownership_status: v.ownership_status || 'PROPIO',
      current_hours: v.current_hours || 0,
      responsible_id: v.responsible_id || '',
      assigned_driver_id: v.assigned_driver_id || '',
      current_location: v.current_location || ''
    })
    setIsVehicleModalOpen(true)
  }

  const handleSaveDriver = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    try {
      let error;
      
      const driverPayload = {
        ...newDriver
      }

      if (editingDriverId) {
        const { error: updateError } = await supabase
          .from('drivers')
          .update(driverPayload)
          .eq('id', editingDriverId)
        error = updateError
      } else {
        const { error: insertError } = await supabase
          .from('drivers')
          .insert([driverPayload])
        error = insertError
      }

      if (error) throw error

      setIsDriverModalOpen(false)
      fetchData()
    } catch (err: any) {
      toast.error('Error al guardar conductor. Verifique los datos o si el documento ya existe.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleEditDriver = (d: any) => {
    setEditingDriverId(d.id)
    setNewDriver({
      document_number: d.document_number,
      carrier_id: d.carrier_id,
      first_name: d.first_name,
      last_name: d.last_name,
      phone: d.phone || '',
      license_number: d.license_number,
      license_category: d.license_category,
      license_expiration: d.license_expiration || '',
      is_active: d.is_active
    })
    setIsDriverModalOpen(true)
  }

  const handleDeleteVehicle = async (id: string) => {
    if (!confirm('¿Está seguro de eliminar este vehículo?')) return
    try {
      const { error } = await supabase.from('vehicles').delete().eq('id', id)
      if (error) throw error
      toast.success('Vehículo eliminado')
      fetchData()
    } catch (err: any) {
      // Un activo con historial operativo no se elimina (trg_guard_vehicle_delete): se da de baja
      toast.error(err?.message || 'Error al eliminar vehículo.')
    }
  }

  const handleTransitionVehicle = async (plate: string, newStatus: string, confirmText: string) => {
    if (!confirm(confirmText)) return
    const reason = prompt('Motivo del cambio de estado:') || null
    const { data, error } = await supabase.rpc('transition_vehicle_status', {
      p_vehicle_plate: plate,
      p_new_status: newStatus,
      p_reason: reason,
    })
    if (error || !data?.success) {
      toast.error(error?.message || data?.error || 'No se pudo cambiar el estado del vehículo')
      return
    }
    toast.success(`Vehículo ${plate}: ${data.previous_status ?? ''} → ${newStatus}`)
    fetchData()
  }

  const handleAdministrativeBlock = async (plate: string, blocked: boolean) => {
    let reason: string | null = null
    if (blocked) {
      reason = prompt('Motivo del bloqueo administrativo (obligatorio):')
      if (!reason?.trim()) return
    } else if (!confirm(`¿Quitar el bloqueo administrativo de ${plate}? La unidad seguirá BLOQUEADA hasta que se libere.`)) {
      return
    }
    const { data, error } = await supabase.rpc('set_vehicle_administrative_block', {
      p_vehicle_plate: plate,
      p_blocked: blocked,
      p_reason: reason,
    })
    if (error || !data?.success) {
      toast.error(error?.message || data?.error || 'No se pudo actualizar el bloqueo administrativo')
      return
    }
    toast.success(blocked ? `Bloqueo administrativo aplicado a ${plate}` : `Bloqueo administrativo retirado de ${plate}`)
    fetchData()
  }

  const handleMassUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setIsImporting(true)
    
    const reader = new FileReader()
    reader.onload = async (event) => {
      try {
        const data = new Uint8Array(event.target?.result as ArrayBuffer)
        const workbook = XLSX.read(data, { type: 'array' })
        const firstSheetName = workbook.SheetNames[0]
        const worksheet = workbook.Sheets[firstSheetName]
        const json = XLSX.utils.sheet_to_json(worksheet)
        
        const payload = []
        for (const row of json as any[]) {
          const plate = row['Placa'] || row['placa'] || row['PLACA']
          if (!plate) continue

          payload.push({
            plate: String(plate).trim().toUpperCase(),
            carrier_id: newVehicle.carrier_id, 
            type: normalizeVehicleType(row['Tipo'] || row['tipo'] || row['TIPO'] || 'CAMION'),
            brand: String(row['Marca'] || row['marca'] || row['MARCA'] || '').trim().toUpperCase(),
            model: String(row['Modelo'] || row['modelo'] || row['MODELO'] || '').trim().toUpperCase(),
            year: parseInt(row['Año'] || row['año'] || row['AÑO']) || new Date().getFullYear(),
            weight_capacity: parseFloat(row['Peso_kg'] || row['Peso'] || row['peso'] || 0),
            volume_capacity: parseFloat(row['Volumen_m3'] || row['Volumen'] || row['volumen'] || 0),
          })
        }
        
        if (payload.length === 0) throw new Error('No se encontraron datos válidos')

        const { error } = await supabase.from('vehicles').insert(payload)
        if (error) throw error
        
        toast.success(`${payload.length} vehículos importados exitosamente`)
        fetchData()
      } catch (err: any) {
        toast.error('Error al importar CSV: ' + err.message)
      } finally {
        setIsImporting(false)
        if (fileInputRef.current) fileInputRef.current.value = ''
      }
    }
    reader.readAsArrayBuffer(file)
  }

  const handleDownloadTemplate = () => {
    const ws = XLSX.utils.json_to_sheet([{
      Placa: 'ABC-123',
      Tipo: 'CAMION',
      Marca: 'VOLVO',
      Modelo: 'FH16',
      Año: 2023,
      Peso_kg: 25000,
      Volumen_m3: 40
    }])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Plantilla')
    XLSX.writeFile(wb, 'plantilla_vehiculos.xlsx')
  }

  const handleDeleteDriver = async (id: string) => {
    if (!confirm('¿Está seguro de eliminar este conductor?')) return
    try {
      const { error } = await supabase.from('drivers').delete().eq('id', id)
      if (error) throw error
      toast.success('Conductor eliminado')
      fetchData()
    } catch (err: any) {
      toast.error('Error al eliminar conductor. Puede que tenga registros asociados.')
    }
  }

  const openDriverAccess = (driver: any) => {
    setAccessDriver(driver)
    setAccessPassword('')
    setShowAccessPassword(false)
  }

  const handleSaveDriverAccess = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!accessDriver || accessPassword.length < 8) {
      toast.error('La contraseña debe tener al menos 8 caracteres')
      return
    }
    setIsSavingAccess(true)
    try {
      const response = await fetch('/api/drivers/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ driverId: accessDriver.id, password: accessPassword }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'No se pudo configurar el acceso')
      toast.success(`Acceso habilitado. Usuario: ${result.username}`)
      setAccessDriver(null)
      setAccessPassword('')
      await fetchData()
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'No se pudo configurar el acceso')
    } finally {
      setIsSavingAccess(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-[#002855]" />
      </div>
    )
  }

  return (
    <div className="flex flex-col min-h-[calc(100vh-theme(spacing.16))] md:h-[calc(100vh-theme(spacing.16))] bg-slate-50">
      <PageHeader showTitle title="Maestro de Unidades y Conductores" description="Gestión de unidades de transporte y conductores registrados." actions={<>
<div className="flex flex-wrap items-center gap-2">
          {activeTab === 'vehicles' ? (
            <>
              <button 
                onClick={() => {
                  setEditingVehicleId(null)
                  const defaultCarrier = carriers?.find(c => c.type === 'PROPIO') || carriers?.[0]
                  setNewVehicle({
                    plate: '',
                    carrier_id: defaultCarrier?.id || '',
                    type: 'CAMION',
                    brand: '',
                    model: '',
                    year: new Date().getFullYear(),
                    weight_capacity: 0,
                    volume_capacity: 0,
                    status: 'DISPONIBLE',
                    soat_expiration: '',
                    technical_review_expiration: '',
                    internal_code: '',
                    serial_number: '',
                    criticality: 'MEDIA',
                    ownership_status: 'PROPIO',
                    current_hours: 0,
                    responsible_id: '',
                    assigned_driver_id: '',
                    current_location: ''
                  })
                  setIsVehicleModalOpen(true)
                }}
                className="px-4 py-2 bg-[#002855] text-white rounded-lg font-medium hover:bg-[#003875] transition-colors flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                Alta de Vehículo
              </button>
              <input 
                type="file" 
                accept=".xlsx, .xls" 
                className="hidden" 
                ref={fileInputRef} 
                onChange={handleMassUpload} 
              />
              <button 
                onClick={() => fileInputRef.current?.click()}
                disabled={isImporting || !newVehicle.carrier_id}
                title={!newVehicle.carrier_id ? "Espere a que cargue el transportista por defecto" : "Subir plantilla Excel"}
                className="px-4 py-2 bg-slate-100 text-[#002855] border border-[#002855]/20 rounded-lg font-medium hover:bg-slate-200 transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                {isImporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                Carga Masiva
              </button>
              <button 
                onClick={handleDownloadTemplate}
                className="px-4 py-2 bg-slate-100 text-[#002855] border border-[#002855]/20 rounded-lg font-medium hover:bg-slate-200 transition-colors flex items-center gap-2"
                title="Descargar plantilla Excel"
              >
                <Download className="w-4 h-4" />
                Plantilla
              </button>
            </>
          ) : (
            <button 
              onClick={() => {
                setEditingDriverId(null)
                const defaultCarrier = carriers?.find(c => c.type === 'PROPIO') || carriers?.[0]
                setNewDriver({
                  document_number: '',
                  carrier_id: defaultCarrier?.id || '',
                  first_name: '',
                  last_name: '',
                  phone: '',
                  license_number: '',
                  license_category: 'A-I',
                  license_expiration: '',
                  is_active: true
                })
                setIsDriverModalOpen(true)
              }}
              className="px-4 py-2 bg-[#002855] text-white rounded-lg font-medium hover:bg-[#003875] transition-colors flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              Alta de Conductor
            </button>
          )}
        </div>
</>} />

      <div className="flex min-h-0 flex-1 flex-col overflow-visible md:overflow-hidden">
        {/* Tabs */}
        <div className="bg-white border-b border-slate-200 px-6">
          <div className="flex gap-6">
            <button
              onClick={() => setActiveTab('vehicles')}
              className={`flex items-center gap-2 py-4 border-b-2 font-medium transition-colors ${
                activeTab === 'vehicles' 
                  ? 'border-[#002855] text-[#002855]' 
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              <Truck className="w-4 h-4" />
              Vehículos ({vehicles.length})
            </button>
            <button
              onClick={() => setActiveTab('drivers')}
              className={`flex items-center gap-2 py-4 border-b-2 font-medium transition-colors ${
                activeTab === 'drivers' 
                  ? 'border-[#002855] text-[#002855]' 
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              <Users className="w-4 h-4" />
              Conductores ({drivers.length})
            </button>
          </div>
        </div>

        {/* Filtros y Búsqueda */}
        <div className="px-6 mt-4">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
          <div className="flex flex-col md:flex-row gap-4 justify-between items-center">
            <div className="relative w-full md:w-96">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Search className="h-4 w-4 text-slate-400" />
              </div>
              <input
                type="text"
                aria-label="Buscar en Flota"
                placeholder={activeTab === 'vehicles' ? 'Placa, código, marca o conductor...' : 'Nombre, DNI, licencia o placa...'}
                className="block w-full pl-10 pr-3 py-2 border border-slate-300 rounded-lg bg-slate-50 focus:bg-white focus:ring-2 focus:ring-[#002855] focus:border-transparent transition-colors sm:text-sm"
                value={filters.search}
                onChange={(e) => updateFilter('search', e.target.value)}
              />
            </div>
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors border ${showFilters ? 'bg-slate-100 border-slate-300 text-slate-800' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}
            >
              <Filter className="w-4 h-4" />
              Filtros Avanzados {activeFilterCount > 0 && <span className="rounded-full bg-[#002855] px-2 text-xs text-white">{activeFilterCount}</span>}
            </button>
          </div>
          {showFilters && <div className="mt-4 grid grid-cols-1 gap-4 border-t border-slate-100 pt-4 sm:grid-cols-2 xl:grid-cols-4">
            {([
              ['status','Estado', activeTab === 'vehicles' ? VEHICLE_STATUSES.map(value => [value,value.replace(/_/g,' ')]) : [['ACTIVO','Activo'],['INACTIVO','Inactivo']]],
              ['carrier','Transportista',carriers.map(c => [c.id,c.business_name])],
              ['assignment',activeTab === 'vehicles' ? 'Conductor asignado' : 'Unidad asignada',[['ASIGNADO','Con asignación'],['SIN_ASIGNAR','Sin asignación']]],
              ...(activeTab === 'vehicles' ? [
                ['group','Clase de activo',[['TRANSPORTE','Unidades de transporte'],['EQUIPOS','Equipos de almacén']]],
                ['type','Tipo de unidad',Object.entries(VEHICLE_TYPES)],
                ['ownership','Propiedad',[['PROPIO','Propio'],['ALQUILADO','Alquilado'],['LEASING','Leasing']]],
                ['documents','SOAT y revisión técnica',[['VIGENTES','Ambos vigentes'],['VENCIDOS','Con vencimientos'],['INCOMPLETOS','Sin datos completos']]],
              ] : [['app','Acceso al app',[['VINCULADO','Cuenta vinculada'],['SIN_VINCULAR','Sin cuenta vinculada']]]]),
            ] as [keyof FleetFilters,string,string[][]][]).map(([key,label,options]) => <label key={key} className="block text-xs font-semibold text-slate-600">{label}
              <select aria-label={label} value={filters[key]} onChange={e => updateFilter(key,e.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-normal text-slate-800">
                <option value="">Todos</option>{options.map(([value,text]) => <option key={value} value={value}>{text}</option>)}
              </select>
            </label>)}
          </div>}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
            <p role="status">Mostrando {activeTab === 'vehicles' ? filteredVehicles.length : filteredDrivers.length} de {activeTab === 'vehicles' ? vehicles.length : drivers.length} {activeTab === 'vehicles' ? 'unidades · orden por tipo y placa' : 'conductores · orden por apellido'}</p>
            {activeFilterCount > 0 && <button type="button" onClick={() => setFilters({ ...emptyFleetFilters })} className="min-h-11 font-semibold text-[#002855]">Limpiar filtros</button>}
          </div>
        </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {error && (
            <div className="mb-4 bg-red-50 text-red-700 p-4 rounded-lg flex items-center gap-2 border border-red-200">
              <AlertCircle className="w-5 h-5" />
              {error}
            </div>
          )}

          {activeTab === 'vehicles' && (
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="overflow-auto max-h-[calc(100vh-220px)]">
          <DataTable className="w-full text-left border-collapse relative">
            <thead className="sticky top-0 z-10 shadow-[0_1px_0_0_#e2e8f0]">
              <tr className="bg-slate-50  border-slate-200">
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Placa</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Tipo / Marca</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Capacidad</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Transportista</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Estado</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider text-right">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredVehicles.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="p-8 text-center text-slate-500">
                          No hay vehículos registrados
                        </td>
                      </tr>
                    ) : (
                      filteredVehicles.map(v => (
                        <tr 
                          key={v.id} 
                          className="hover:bg-slate-50 transition-colors cursor-pointer group"
                          onClick={(e) => {
                            // Prevenir navegación si hace clic en el botón de editar
                            if ((e.target as HTMLElement).closest('button')) return;
                            router.push(`/mantenimiento/flota/${v.plate}`);
                          }}
                        >
                          <td className="p-4 font-bold text-[#002855] group-hover:text-blue-600 transition-colors">
                            {v.plate}
                            <div className="mt-1 text-xs font-normal text-slate-500">{v.assigned_driver_id ? (() => { const d = drivers.find(driver => driver.id === v.assigned_driver_id); return d ? `${d.first_name} ${d.last_name} · ${d.profile_id ? 'App vinculado' : 'Sin cuenta de app'}` : 'Conductor asignado' })() : 'Sin conductor asignado'}</div>
                          </td>
                          <td className="p-4">
                            <div className="text-sm font-medium text-slate-800">{v.type}</div>
                            <div className="text-xs text-slate-500">{v.brand} {v.model} ({v.year})</div>
                          </td>
                          <td className="p-4">
                            <div className="text-sm text-slate-600 font-medium">{v.weight_capacity} KG</div>
                            <div className="text-xs text-slate-500">{v.volume_capacity} M³</div>
                          </td>
                          <td className="p-4 text-sm text-slate-600">{v.carriers?.business_name || 'N/A'}</td>
                          <td className="p-4">
                            <span className={`px-2 py-1 text-xs font-semibold rounded-full ${STATUS_BADGE[v.status] || 'bg-slate-100 text-slate-700'}`}>
                              {v.status?.replace(/_/g, ' ')}
                            </span>
                            {v.is_blocked && (
                              <div className="mt-1 text-[11px] text-red-600" title={v.block_reason || ''}>Bloqueo administrativo</div>
                            )}
                          </td>
                          <td className="p-4 text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              <button type="button" onClick={e => { e.stopPropagation(); router.push(`/mantenimiento/flota/${v.plate}`) }} className="min-h-11 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-[#002855] hover:bg-slate-50">Ver ficha</button>
                              <TableActions label={`Más acciones de ${v.plate}`} actions={[
                                { id: 'edit', label: 'Editar vehículo', icon: <Edit2 className="h-4 w-4" />, onSelect: () => handleEditVehicle(v) },
                                ...(v.status !== 'DISPONIBLE' ? [{ id: 'release', label: 'Liberar unidad', icon: <ShieldCheck className="h-4 w-4" />, onSelect: () => handleTransitionVehicle(v.plate, 'DISPONIBLE', `¿Liberar ${v.plate}? Se validará su elegibilidad.`) }] : []),
                                ...(!['MANTENIMIENTO', 'FUERA_DE_SERVICIO'].includes(v.status) ? [{ id: 'maintenance', label: 'Enviar a mantenimiento', icon: <Wrench className="h-4 w-4" />, onSelect: () => handleTransitionVehicle(v.plate, 'MANTENIMIENTO', `¿Enviar ${v.plate} a MANTENIMIENTO?`) }] : []),
                                { id: 'block', label: v.is_blocked ? 'Quitar bloqueo admin.' : 'Bloqueo administrativo', icon: <Lock className="h-4 w-4" />, tone: 'danger', onSelect: () => handleAdministrativeBlock(v.plate, !v.is_blocked) },
                                ...(v.status !== 'FUERA_DE_SERVICIO' ? [{ id: 'retire', label: 'Fuera de servicio', icon: <Ban className="h-4 w-4" />, onSelect: () => handleTransitionVehicle(v.plate, 'FUERA_DE_SERVICIO', `¿Dar de baja ${v.plate} (FUERA DE SERVICIO)?`) }] : []),
                                { id: 'delete', label: 'Eliminar vehículo', icon: <Trash2 className="h-4 w-4" />, tone: 'danger', onSelect: () => handleDeleteVehicle(v.id) },
                              ]} />
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </DataTable>
              </div>
            </div>
          )}

          {activeTab === 'drivers' && (
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="overflow-auto max-h-[calc(100vh-220px)]">
          <DataTable className="w-full text-left border-collapse relative">
            <thead className="sticky top-0 z-10 shadow-[0_1px_0_0_#e2e8f0]">
              <tr className="bg-slate-50  border-slate-200">
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Nombre Completo</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Documento (DNI)</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Licencia</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Vencimiento</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Transportista</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Acceso App</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Estado</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider text-right">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredDrivers.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="p-8 text-center text-slate-500">
                          No hay conductores registrados
                        </td>
                      </tr>
                    ) : (
                      filteredDrivers.map(d => (
                        <tr key={d.id} className="hover:bg-slate-50 transition-colors">
                          <td className="p-4 font-bold text-[#002855]">{d.first_name} {d.last_name}<div className="mt-1 text-xs font-normal text-slate-500">{vehicles.find(v => v.assigned_driver_id === d.id)?.plate || 'Sin unidad asignada'}</div></td>
                          <td className="p-4 text-sm text-slate-600">{d.document_number}</td>
                          <td className="p-4">
                            <div className="text-sm font-medium text-slate-800">{d.license_number}</div>
                            <div className="text-xs font-semibold text-blue-600 bg-blue-50 px-2 py-0.5 rounded inline-block mt-1">
                              Cat. {d.license_category}
                            </div>
                          </td>
                          <td className="p-4">
                            {d.license_expiration ? (
                              (() => {
                                const expDate = new Date(d.license_expiration);
                                const today = new Date();
                                const diffDays = Math.ceil((expDate.getTime() - today.getTime()) / (1000 * 3600 * 24));
                                
                                if (diffDays < 0) return <span className="px-2 py-1 bg-red-100 text-red-700 text-xs font-bold rounded-lg flex items-center gap-1 w-max"><AlertCircle className="w-3 h-3"/> Vencido</span>;
                                if (diffDays <= 30) return <span className="px-2 py-1 bg-yellow-100 text-yellow-700 text-xs font-bold rounded-lg flex items-center gap-1 w-max"><AlertCircle className="w-3 h-3"/> {diffDays} días</span>;
                                return <span className="text-sm text-slate-600">{new Date(d.license_expiration).toLocaleDateString()}</span>;
                              })()
                            ) : (
                              <span className="text-xs text-slate-400">No reg.</span>
                            )}
                          </td>
                          <td className="p-4 text-sm text-slate-600">{d.carriers?.business_name || 'N/A'}</td>
                          <td className="p-4 text-xs text-slate-600">{d.profile_id ? 'Vinculado' : 'Sin cuenta'}</td>
                          <td className="p-4">
                            <span className={`px-2 py-1 text-xs font-semibold rounded-full ${
                              d.is_active !== false ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
                            }`}>
                              {d.is_active !== false ? 'ACTIVO' : 'INACTIVO'}
                            </span>
                          </td>
                          <td className="p-4 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <button 
                                onClick={() => handleEditDriver(d)}
                                className="p-2 text-slate-400 hover:text-[#002855] transition-colors rounded-lg hover:bg-slate-100"
                                title="Editar Conductor"
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                              {role === 'admin' && <button
                                type="button"
                                onClick={() => openDriverAccess(d)}
                                className="p-2 text-slate-400 hover:text-emerald-700 transition-colors rounded-lg hover:bg-emerald-50"
                                title={d.profile_id ? 'Restablecer contraseña de la app' : 'Crear acceso a la app'}
                              >
                                <KeyRound className="w-4 h-4" />
                              </button>}
                              <button 
                                onClick={() => handleDeleteDriver(d.id)}
                                className="p-2 text-slate-400 hover:text-red-600 transition-colors rounded-lg hover:bg-red-50"
                                title="Eliminar Conductor"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </DataTable>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Vehículo Modal */}
      <Modal 
        isOpen={isVehicleModalOpen} 
        onClose={() => setIsVehicleModalOpen(false)} 
        title={editingVehicleId ? "Editar Vehículo" : "Nuevo Vehículo"}
        maxWidth="max-w-2xl"
      >
        <form onSubmit={handleSaveVehicle} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Placa (o código si el equipo no tiene placa)</label>
              <input 
                type="text" 
                required
                disabled={!!editingVehicleId}
                title={editingVehicleId ? 'La placa es la identidad del activo y no se modifica' : undefined}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg uppercase text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none disabled:bg-slate-100"
                value={newVehicle.plate}
                onChange={(e) => setNewVehicle({...newVehicle, plate: e.target.value.toUpperCase()})}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Transportista</label>
              <select
                required
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none"
                value={newVehicle.carrier_id}
                onChange={(e) => setNewVehicle({...newVehicle, carrier_id: e.target.value})}
              >
                <option value="">Seleccionar...</option>
                {carriers.map(c => (
                  <option key={c.id} value={c.id}>{c.business_name} ({c.type})</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Tipo</label>
              <select
                required
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none"
                value={newVehicle.type}
                onChange={(e) => setNewVehicle({...newVehicle, type: e.target.value})}
              >
                {Object.entries(VEHICLE_TYPES).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Año</label>
              <input 
                type="number" 
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none"
                value={newVehicle.year}
                onChange={(e) => setNewVehicle({...newVehicle, year: Number(e.target.value)})}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Marca</label>
              <input 
                type="text" 
                className="w-full px-3 py-2 border border-slate-300 rounded-lg uppercase text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none"
                value={newVehicle.brand}
                onChange={(e) => setNewVehicle({...newVehicle, brand: e.target.value.toUpperCase()})}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Modelo</label>
              <input 
                type="text" 
                className="w-full px-3 py-2 border border-slate-300 rounded-lg uppercase text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none"
                value={newVehicle.model}
                onChange={(e) => setNewVehicle({...newVehicle, model: e.target.value.toUpperCase()})}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Capacidad Peso (Kg)</label>
              <input 
                type="number" 
                step="0.1"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-900 focus:ring-2 focus:ring-[#002855] focus:border-[#002855] outline-none"
                value={newVehicle.weight_capacity}
                onChange={(e) => setNewVehicle({...newVehicle, weight_capacity: Number(e.target.value)})}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Capacidad Volumen (m³)</label>
              <input 
                type="number" 
                step="0.1"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-900 focus:ring-2 focus:ring-[#002855] focus:border-[#002855] outline-none"
                value={newVehicle.volume_capacity}
                onChange={(e) => setNewVehicle({...newVehicle, volume_capacity: Number(e.target.value)})}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Código Interno</label>
              <input type="text" placeholder={editingVehicleId ? undefined : `Automático${nextCode ? `: ${nextCode}` : ''}`}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg uppercase text-slate-900 placeholder:normal-case placeholder:text-slate-400 focus:ring-2 focus:ring-[#002855] outline-none" value={newVehicle.internal_code} onChange={e => setNewVehicle({...newVehicle, internal_code: e.target.value.toUpperCase()})} />
              {!editingVehicleId && <p className="mt-1 text-xs text-slate-500">Déjelo vacío y se asigna por tipo de unidad.</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Número de Serie (VIN)</label>
              <input type="text" className="w-full px-3 py-2 border border-slate-300 rounded-lg uppercase text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none" value={newVehicle.serial_number} onChange={e => setNewVehicle({...newVehicle, serial_number: e.target.value.toUpperCase()})} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Criticidad</label>
              <select className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none" value={newVehicle.criticality} onChange={e => setNewVehicle({...newVehicle, criticality: e.target.value})}>
                <option value="BAJA">Baja</option>
                <option value="MEDIA">Media</option>
                <option value="ALTA">Alta</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Estado de Propiedad</label>
              <select className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none" value={newVehicle.ownership_status} onChange={e => setNewVehicle({...newVehicle, ownership_status: e.target.value})}>
                <option value="PROPIO">Propio</option>
                <option value="ALQUILADO">Alquilado</option>
                <option value="LEASING">Leasing</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Horómetro/Kilometraje Actual</label>
              <input type="number" step="1" className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none" value={newVehicle.current_hours} onChange={e => setNewVehicle({...newVehicle, current_hours: Number(e.target.value)})} />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Ubicación Actual</label>
              <input type="text" className="w-full px-3 py-2 border border-slate-300 rounded-lg uppercase text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none" value={newVehicle.current_location} onChange={e => setNewVehicle({...newVehicle, current_location: e.target.value.toUpperCase()})} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Vencimiento SOAT</label>
              {editingVehicleId && <p className="-mt-0.5 mb-1 text-[11px] text-slate-500">Una fecha posterior registra la renovación; una anterior corrige la vigente.</p>}
              <input type="date" value={newVehicle.soat_expiration} onChange={e => setNewVehicle({...newVehicle, soat_expiration: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] focus:border-[#002855] outline-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Vencimiento Rev. Técnica</label>
              <input type="date" value={newVehicle.technical_review_expiration} onChange={e => setNewVehicle({...newVehicle, technical_review_expiration: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] focus:border-[#002855] outline-none" />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Conductor asignado a la unidad</label>
              <select
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none"
                value={newVehicle.assigned_driver_id}
                onChange={(e) => setNewVehicle({...newVehicle, assigned_driver_id: e.target.value})}
              >
                <option value="">Sin asignar</option>
                {drivers.filter(d => d.is_active).map(d => (
                  <option key={d.id} value={d.id}>{d.first_name} {d.last_name}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-500">La unidad aparece automáticamente en el app del conductor, con o sin ruta. El conductor debe tener su cuenta de app vinculada. Para cambiar una pareja con ruta activa, primero reprograme desde Despacho.</p>
            </div>
          </div>
            <div className="pt-4 flex justify-end gap-2 border-t mt-4">
              <button type="button" onClick={() => setIsVehicleModalOpen(false)} className="px-4 py-2 text-slate-700 hover:bg-slate-100 border border-slate-300 rounded-lg transition-colors font-medium">Cancelar</button>
              <button type="submit" disabled={isSubmitting} className="px-4 py-2 bg-[#002855] text-white rounded-lg font-medium transition-colors hover:bg-[#001d3d]">
                {isSubmitting ? 'Guardando...' : 'Guardar Vehículo'}
              </button>
            </div>
        </form>
      </Modal>

      {/* Conductor Modal */}
      <Modal 
        isOpen={isDriverModalOpen} 
        onClose={() => setIsDriverModalOpen(false)} 
        title={editingDriverId ? "Editar Conductor" : "Nuevo Conductor"}
        maxWidth="max-w-2xl"
      >
        <form onSubmit={handleSaveDriver} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">DNI / Documento</label>
              <input 
                type="text" 
                required
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none"
                value={newDriver.document_number}
                onChange={(e) => setNewDriver({...newDriver, document_number: e.target.value})}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Transportista</label>
              <select
                required
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none"
                value={newDriver.carrier_id}
                onChange={(e) => setNewDriver({...newDriver, carrier_id: e.target.value})}
              >
                <option value="">Seleccionar...</option>
                {carriers.map(c => (
                  <option key={c.id} value={c.id}>{c.business_name} ({c.type})</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Nombres</label>
              <input 
                type="text" 
                required
                className="w-full px-3 py-2 border border-slate-300 rounded-lg uppercase text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none"
                value={newDriver.first_name}
                onChange={(e) => setNewDriver({...newDriver, first_name: e.target.value.toUpperCase()})}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Apellidos</label>
              <input 
                type="text" 
                required
                className="w-full px-3 py-2 border border-slate-300 rounded-lg uppercase text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none"
                value={newDriver.last_name}
                onChange={(e) => setNewDriver({...newDriver, last_name: e.target.value.toUpperCase()})}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Teléfono</label>
              <input 
                type="text" 
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none"
                value={newDriver.phone}
                onChange={(e) => setNewDriver({...newDriver, phone: e.target.value})}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Nº Licencia</label>
              <input 
                type="text" 
                required
                className="w-full px-3 py-2 border border-slate-300 rounded-lg uppercase text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none"
                value={newDriver.license_number}
                onChange={(e) => setNewDriver({...newDriver, license_number: e.target.value.toUpperCase()})}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Categoría Licencia</label>
              <select
                required
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none"
                value={newDriver.license_category}
                onChange={(e) => setNewDriver({...newDriver, license_category: e.target.value})}
              >
                <option value="A-I">A-I</option>
                <option value="A-IIa">A-IIa</option>
                <option value="A-IIb">A-IIb</option>
                <option value="A-IIIa">A-IIIa</option>
                <option value="A-IIIb">A-IIIb</option>
                <option value="A-IIIc">A-IIIc</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Vencimiento Licencia</label>
              <input 
                type="date" 
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none"
                value={newDriver.license_expiration}
                onChange={(e) => setNewDriver({...newDriver, license_expiration: e.target.value})}
              />
            </div>
          </div>
          <label className="flex items-center gap-3 text-sm font-medium text-slate-700 mt-4">
            <input type="checkbox" checked={newDriver.is_active}
              onChange={e => setNewDriver({ ...newDriver, is_active: e.target.checked })} />
            Conductor activo; si tiene cuenta vinculada, habilita también su acceso a la app
          </label>
            <div className="pt-4 flex justify-end gap-2 border-t mt-4">
              <button type="button" onClick={() => setIsDriverModalOpen(false)} className="px-4 py-2 text-slate-700 hover:bg-slate-100 border border-slate-300 rounded-lg transition-colors font-medium">Cancelar</button>
              <button type="submit" disabled={isSubmitting} className="px-4 py-2 bg-[#002855] text-white rounded-lg font-medium transition-colors hover:bg-[#001d3d]">
                {isSubmitting ? 'Guardando...' : 'Guardar Conductor'}
              </button>
            </div>
        </form>
      </Modal>

      <Modal
        isOpen={!!accessDriver}
        onClose={() => setAccessDriver(null)}
        title={accessDriver?.profile_id ? 'Restablecer acceso del conductor' : 'Crear acceso del conductor'}
        maxWidth="max-w-lg"
      >
        <form onSubmit={handleSaveDriverAccess} className="space-y-5">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="font-semibold text-slate-800">{accessDriver?.first_name} {accessDriver?.last_name}</p>
            <p className="text-sm text-slate-500">Usuario: {accessDriver?.document_number}@jrm.com</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Nueva contraseña de acceso</label>
            <div className="relative">
              <input
                type={showAccessPassword ? 'text' : 'password'}
                minLength={8}
                required
                autoComplete="new-password"
                value={accessPassword}
                onChange={event => setAccessPassword(event.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 pr-11 text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none"
              />
              <button type="button" onClick={() => setShowAccessPassword(value => !value)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-slate-400 hover:text-slate-700"
                aria-label={showAccessPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}>
                {showAccessPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-500">Mínimo 8 caracteres. Se guardará únicamente en Supabase Auth.</p>
          </div>
          <div className="flex justify-end gap-3 border-t border-slate-100 pt-4">
            <button type="button" onClick={() => setAccessDriver(null)}
              className="rounded-lg px-4 py-2 font-medium text-slate-600 hover:bg-slate-100">Cancelar</button>
            <button type="submit" disabled={isSavingAccess}
              className="inline-flex items-center gap-2 rounded-lg bg-[#002855] px-4 py-2 font-medium text-white disabled:opacity-50">
              {isSavingAccess ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              Guardar acceso
            </button>
          </div>
        </form>
      </Modal>

    </div>
  )
}
