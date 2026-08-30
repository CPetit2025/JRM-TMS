"use client"
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Truck, Users, Plus, Edit2, Trash2, Search, AlertCircle, Loader2 } from 'lucide-react'
import { Modal } from '@/components/ui/modal'

export default function FlotaPage() {
  const supabase = createClient()
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
    status: 'DISPONIBLE'
  })

  const [newDriver, setNewDriver] = useState({
    document_number: '',
    carrier_id: '',
    first_name: '',
    last_name: '',
    phone: '',
    license_number: '',
    license_category: 'A-I',
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
      if (editingVehicleId) {
        const { error: updateError } = await supabase
          .from('vehicles')
          .update(newVehicle)
          .eq('id', editingVehicleId)
        error = updateError
      } else {
        const { error: insertError } = await supabase
          .from('vehicles')
          .insert([newVehicle])
        error = insertError
      }

      if (error) throw error

      setIsVehicleModalOpen(false)
      fetchData()
    } catch (err: any) {
      console.error('Error guardando vehículo:', err)
      alert('Error al guardar vehículo. Verifique los datos o si la placa ya existe.')
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
      status: v.status
    })
    setIsVehicleModalOpen(true)
  }

  const handleSaveDriver = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    try {
      let error;
      if (editingDriverId) {
        // Al actualizar, evitamos sobrescribir el PIN si ya existe, a menos que se quiera manejar distinto.
        const driverPayload = { ...newDriver }
        const { error: updateError } = await supabase
          .from('drivers')
          .update(driverPayload)
          .eq('id', editingDriverId)
        error = updateError
      } else {
        // Por defecto el PIN son los primeros 4 dígitos del DNI al crear
        const driverPayload = {
          ...newDriver,
          pin: newDriver.document_number.substring(0, 4)
        }
        const { error: insertError } = await supabase
          .from('drivers')
          .insert([driverPayload])
        error = insertError
      }

      if (error) throw error

      setIsDriverModalOpen(false)
      fetchData()
    } catch (err: any) {
      console.error('Error guardando conductor:', err)
      alert('Error al guardar conductor. Verifique los datos o si el documento ya existe.')
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
      is_active: d.is_active
    })
    setIsDriverModalOpen(true)
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
          <p className="text-sm text-slate-500 mt-1">Gestión de unidades de transporte y conductores registrados.</p>
        </div>
        <div className="flex items-center gap-2">
          {activeTab === 'vehicles' ? (
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
                  status: 'DISPONIBLE'
                })
                setIsVehicleModalOpen(true)
              }}
              className="px-4 py-2 bg-[#002855] text-white rounded-lg font-medium hover:bg-[#003875] transition-colors flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              Alta de Vehículo
            </button>
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
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Placa</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Tipo / Marca</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Capacidad</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Transportista</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Estado</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider text-right">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {vehicles.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="p-8 text-center text-slate-500">
                          No hay vehículos registrados
                        </td>
                      </tr>
                    ) : (
                      vehicles.map(v => (
                        <tr key={v.id} className="hover:bg-slate-50 transition-colors">
                          <td className="p-4 font-bold text-[#002855]">{v.plate}</td>
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
                              v.status === 'DISPONIBLE' ? 'bg-green-100 text-green-700' :
                              v.status === 'EN_RUTA' ? 'bg-blue-100 text-blue-700' :
                              v.status === 'EN_MANTENIMIENTO' ? 'bg-yellow-100 text-yellow-700' :
                              'bg-slate-100 text-slate-700'
                            }`}>
                              {v.status}
                            </span>
                          </td>
                          <td className="p-4 text-right">
                            <button 
                              onClick={() => handleEditVehicle(v)}
                              title="Editar Vehículo"
                              className="p-2 text-slate-400 hover:text-[#002855] transition-colors rounded-lg hover:bg-slate-100"
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>
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
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Nombre Completo</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Documento (DNI)</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Licencia</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Transportista</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">PIN (Clave)</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Estado</th>
                      <th className="p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider text-right">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {drivers.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="p-8 text-center text-slate-500">
                          No hay conductores registrados
                        </td>
                      </tr>
                    ) : (
                      drivers.map(d => (
                        <tr key={d.id} className="hover:bg-slate-50 transition-colors">
                          <td className="p-4 font-bold text-[#002855]">{d.first_name} {d.last_name}</td>
                          <td className="p-4 text-sm text-slate-600">{d.document_number}</td>
                          <td className="p-4">
                            <div className="text-sm font-medium text-slate-800">{d.license_number}</div>
                            <div className="text-xs font-semibold text-blue-600 bg-blue-50 px-2 py-0.5 rounded inline-block mt-1">
                              Cat. {d.license_category}
                            </div>
                          </td>
                          <td className="p-4 text-sm text-slate-600">{d.carriers?.business_name || 'N/A'}</td>
                          <td className="p-4 font-bold text-slate-700">{d.pin || '----'}</td>
                          <td className="p-4">
                            <span className={`px-2 py-1 text-xs font-semibold rounded-full ${
                              d.is_active !== false ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                            }`}>
                              {d.is_active !== false ? 'ACTIVO' : 'INACTIVO'}
                            </span>
                          </td>
                          <td className="p-4 text-right">
                            <button 
                              onClick={() => handleEditDriver(d)}
                              className="p-2 text-slate-400 hover:text-[#002855] transition-colors rounded-lg hover:bg-slate-100"
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>
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
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Capacidad Carga (KG)</label>
              <input 
                type="number" 
                step="0.1"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none"
                value={newVehicle.weight_capacity}
                onChange={(e) => setNewVehicle({...newVehicle, weight_capacity: Number(e.target.value)})}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Capacidad Volumen (M3)</label>
              <input 
                type="number" 
                step="0.1"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-900 focus:ring-2 focus:ring-[#002855] outline-none"
                value={newVehicle.volume_capacity}
                onChange={(e) => setNewVehicle({...newVehicle, volume_capacity: Number(e.target.value)})}
              />
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
