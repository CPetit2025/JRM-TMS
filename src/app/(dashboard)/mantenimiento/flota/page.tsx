"use client"
import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Truck, Users, Plus, Edit2, Trash2, Search, AlertCircle, Loader2, ArrowRight, Filter, Upload, MoreVertical, Ban, Download } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import * as XLSX from 'xlsx'

export default function FlotaPage() {
  const supabase = createClient()
  const router = useRouter()
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
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [filterStatus, setFilterStatus] = useState('TODOS')
  
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isImporting, setIsImporting] = useState(false)
  const [activeDropdown, setActiveDropdown] = useState<string | null>(null)
  
  const filteredVehicles = vehicles.filter((v: any) => {
    const matchSearch = searchTerm === '' || v.plate.toLowerCase().includes(searchTerm.toLowerCase());
    const matchStatus = filterStatus === 'TODOS' || v.status === filterStatus;
    return matchSearch && matchStatus;
  })
  
  const filteredDrivers = drivers.filter((d: any) => {
    const matchSearch = searchTerm === '' || (d.first_name + ' ' + d.last_name).toLowerCase().includes(searchTerm.toLowerCase()) || (d.document_number||'').includes(searchTerm);
    const matchStatus = filterStatus === 'TODOS' || d.status === filterStatus;
    return matchSearch && matchStatus;
  })

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
    technical_review_expiration: ''
  })

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
      
      const payload = {
        ...newVehicle,
        soat_expiration: newVehicle.soat_expiration || null,
        technical_review_expiration: newVehicle.technical_review_expiration || null
      }

      if (editingVehicleId) {
        const { error: updateError } = await supabase
          .from('vehicles')
          .update(payload)
          .eq('id', editingVehicleId)
        error = updateError
      } else {
        const { error: insertError } = await supabase
          .from('vehicles')
          .insert([payload])
        error = insertError
      }

      if (error) throw error

      setIsVehicleModalOpen(false)
      fetchData()
    } catch (err: any) {
      toast.error('Error al guardar vehículo. Verifique los datos o si la placa ya existe.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleEditVehicle = (v: any) => {
    setEditingVehicleId(v.id)
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
      technical_review_expiration: v.technical_review_expiration || ''
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
      
      // Remove license_expiration because it doesn't exist on the drivers table
      // It exists on profiles, but this form updates drivers.
      delete (driverPayload as any).license_expiration;

      if (editingDriverId) {
        // Al actualizar, evitamos sobrescribir el PIN si ya existe, a menos que se quiera manejar distinto.
        const { error: updateError } = await supabase
          .from('drivers')
          .update(driverPayload)
          .eq('id', editingDriverId)
        error = updateError
      } else {
        // Por defecto el PIN son los primeros 4 dígitos del DNI al crear
        (driverPayload as any).pin = newDriver.document_number.substring(0, 4)
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
      toast.error('Error al eliminar vehículo. Puede que tenga registros asociados.')
    }
  }

  const handleSuspendVehicle = async (id: string, currentStatus: string) => {
    if (!confirm(`¿Está seguro de ${currentStatus === 'INACTIVO' ? 'activar' : 'suspender'} este vehículo?`)) return
    try {
      const newStatus = currentStatus === 'INACTIVO' ? 'DISPONIBLE' : 'INACTIVO'
      const { error } = await supabase.from('vehicles').update({ status: newStatus }).eq('id', id)
      if (error) throw error
      toast.success(`Vehículo ${newStatus === 'DISPONIBLE' ? 'activado' : 'suspendido'}`)
      fetchData()
    } catch (err: any) {
      toast.error('Error al cambiar el estado del vehículo')
    }
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
            type: String(row['Tipo'] || row['tipo'] || row['TIPO'] || 'CAMION').trim().toUpperCase(),
            brand: String(row['Marca'] || row['marca'] || row['MARCA'] || '').trim().toUpperCase(),
            model: String(row['Modelo'] || row['modelo'] || row['MODELO'] || '').trim().toUpperCase(),
            year: parseInt(row['Año'] || row['año'] || row['AÑO']) || new Date().getFullYear(),
            weight_capacity: parseFloat(row['Peso_kg'] || row['Peso'] || row['peso'] || 0),
            volume_capacity: parseFloat(row['Volumen_m3'] || row['Volumen'] || row['volumen'] || 0),
            status: 'DISPONIBLE'
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

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-[#002855]" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-[calc(100vh-theme(spacing.16))] bg-slate-50">
      <div className="p-6 border-b border-slate-200 bg-white shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#002855]">Maestro de Unidades y Conductores</h1>
          <p className="text-sm text-slate-500">Gestión de unidades de transporte y conductores registrados.</p>
        </div>
        <div className="flex items-center gap-2">
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
                    technical_review_expiration: ''
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
      </div>

      <div className="flex-1 overflow-hidden flex flex-col">
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
                placeholder={activeTab === 'vehicles' ? 'Buscar por placa...' : 'Buscar por nombre o DNI...'}
                className="block w-full pl-10 pr-3 py-2 border border-slate-300 rounded-lg bg-slate-50 focus:bg-white focus:ring-2 focus:ring-[#002855] focus:border-transparent transition-colors sm:text-sm"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors border ${showFilters ? 'bg-slate-100 border-slate-300 text-slate-800' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}
            >
              <Filter className="w-4 h-4" />
              Filtros Avanzados
            </button>
          </div>
          {showFilters && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4 pt-4 border-t border-slate-100">
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Estado</label>
                <select
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                >
                  <option value="TODOS">Todos</option>
                  <option value="ACTIVO">Activo</option>
                  <option value="INACTIVO">Inactivo</option>
                  <option value="MANTENIMIENTO">Mantenimiento</option>
                </select>
              </div>
            </div>
          )}
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
          <table className="w-full text-left border-collapse relative">
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
                            <span className={`px-2 py-1 text-xs font-semibold rounded-full ${
                              v.status === 'DISPONIBLE' ? 'bg-emerald-100 text-emerald-700' :
                              v.status === 'EN_RUTA' ? 'bg-blue-100 text-blue-700' :
                              v.status === 'EN_MANTENIMIENTO' ? 'bg-amber-100 text-amber-700' :
                              'bg-slate-100 text-slate-700'
                            }`}>
                              {v.status}
                            </span>
                          </td>
                          <td className="p-4 text-right relative">
                            <button 
                              onClick={(e) => {
                                e.stopPropagation()
                                setActiveDropdown(activeDropdown === v.id ? null : v.id)
                              }}
                              className="p-2 text-slate-400 hover:text-[#002855] transition-colors rounded-lg hover:bg-slate-100"
                            >
                              <MoreVertical className="w-5 h-5" />
                            </button>
                            
                            {activeDropdown === v.id && (
                              <div className="absolute right-8 top-10 w-48 bg-white rounded-lg shadow-lg border border-slate-200 z-50 py-1" onClick={e => e.stopPropagation()}>
                                <Link 
                                  href={`/mantenimiento/flota/${v.plate}`}
                                  onClick={() => setActiveDropdown(null)}
                                  className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                                >
                                  <ArrowRight className="w-4 h-4" /> Ver Ficha 360
                                </Link>
                                <button 
                                  onClick={() => { setActiveDropdown(null); handleEditVehicle(v) }}
                                  className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                                >
                                  <Edit2 className="w-4 h-4" /> Editar
                                </button>
                                <button 
                                  onClick={() => { setActiveDropdown(null); handleSuspendVehicle(v.id, v.status) }}
                                  className="w-full text-left px-4 py-2 text-sm text-amber-600 hover:bg-amber-50 flex items-center gap-2"
                                >
                                  <Ban className="w-4 h-4" /> {v.status === 'INACTIVO' ? 'Activar' : 'Suspender'}
                                </button>
                                <button 
                                  onClick={() => { setActiveDropdown(null); handleDeleteVehicle(v.id) }}
                                  className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"
                                >
                                  <Trash2 className="w-4 h-4" /> Eliminar
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
          )}

          {activeTab === 'drivers' && (
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="overflow-auto max-h-[calc(100vh-220px)]">
          <table className="w-full text-left border-collapse relative">
            <thead className="sticky top-0 z-10 shadow-[0_1px_0_0_#e2e8f0]">
              <tr className="bg-slate-50  border-slate-200">
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Nombre Completo</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Documento (DNI)</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Licencia</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Vencimiento</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Transportista</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">PIN (Clave)</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Estado</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider text-right">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredDrivers.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="p-8 text-center text-slate-500">
                          No hay conductores registrados
                        </td>
                      </tr>
                    ) : (
                      filteredDrivers.map(d => (
                        <tr key={d.id} className="hover:bg-slate-50 transition-colors">
                          <td className="p-4 font-bold text-[#002855]">{d.first_name} {d.last_name}</td>
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
                          <td className="p-4 font-bold text-slate-700">{d.pin || '----'}</td>
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
                </table>
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
              <label className="block text-sm font-medium text-slate-700 mb-1">Placa</label>
              <input 
                type="text" 
                required
                className="w-full px-3 py-2 border border-slate-300 rounded-lg uppercase text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none"
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
                <option value="CAMION">Camión</option>
                <option value="CAMIONETA">Camioneta</option>
                <option value="TRAILER">Tráiler</option>
                <option value="FURGON">Furgón</option>
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
              <label className="block text-sm font-medium text-slate-700 mb-1">Vencimiento SOAT</label>
              <input type="date" value={newVehicle.soat_expiration} onChange={e => setNewVehicle({...newVehicle, soat_expiration: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] focus:border-[#002855] outline-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Vencimiento Rev. Técnica</label>
              <input type="date" value={newVehicle.technical_review_expiration} onChange={e => setNewVehicle({...newVehicle, technical_review_expiration: e.target.value})} className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] focus:border-[#002855] outline-none" />
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
            <div className="pt-4 flex justify-end gap-2 border-t mt-4">
              <button type="button" onClick={() => setIsDriverModalOpen(false)} className="px-4 py-2 text-slate-700 hover:bg-slate-100 border border-slate-300 rounded-lg transition-colors font-medium">Cancelar</button>
              <button type="submit" disabled={isSubmitting} className="px-4 py-2 bg-[#002855] text-white rounded-lg font-medium transition-colors hover:bg-[#001d3d]">
                {isSubmitting ? 'Guardando...' : 'Guardar Conductor'}
              </button>
            </div>
        </form>
      </Modal>

    </div>
  )
}
