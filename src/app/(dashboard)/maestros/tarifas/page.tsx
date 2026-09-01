"use client"
import React, { useState, useEffect } from "react"
import { Zap, Truck, DollarSign, Check, X, Loader2, AlertTriangle, LinkIcon, Link2Off, MapPin, Plus, Trash2, Import } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import { toast } from "sonner"

interface Vehicle {
  id: string
  plate: string
  type: string
  brand: string
  model: string
  year: number
  weight_capacity: number
  status: string
  carriers: { business_name: string } | null
}

interface VehicleCost {
  id: string
  vehicle_type: string
  description: string
  fixed_cost_per_km: number
  driver_cost_per_km: number
  tolls_estimated_cost: number
  vehicle_plate: string | null
  is_default: boolean
}

interface FreightRate {
  id: string
  origin: string
  district: string
  zone: string
  vehicle_type: string
  plate_number: string | null
  capacity_ton: number
  rate: number
}

interface VehicleWithRate {
  vehicle: Vehicle
  rate: VehicleCost | null
}

export default function TarifasPage() {
  const supabase = createClient()
  const [activeTab, setActiveTab] = useState<'km' | 'destino'>('km')
  
  // States for KM Rates
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [rates, setRates] = useState<VehicleCost[]>([])
  const [loadingKm, setLoadingKm] = useState(true)
  const [editingPlate, setEditingPlate] = useState<string | null>(null)
  const [savingKm, setSavingKm] = useState(false)
  const [simKm, setSimKm] = useState(50)
  const [editFormKm, setEditFormKm] = useState({
    vehicle_type: "",
    fixed_cost_per_km: 0,
    driver_cost_per_km: 0,
    tolls_estimated_cost: 0,
    description: ""
  })

  // States for Destination Rates (Flete Fijo)
  const [freightRates, setFreightRates] = useState<FreightRate[]>([])
  const [loadingDest, setLoadingDest] = useState(true)
  const [isAddingDest, setIsAddingDest] = useState(false)
  const [savingDest, setSavingDest] = useState(false)
  const [destForm, setDestForm] = useState({
    origin: 'Planta Chilca',
    district: '',
    zone: '',
    vehicle_type: 'Trailer',
    plate_number: '',
    capacity_ton: 0,
    rate: 0
  })

  useEffect(() => {
    if (activeTab === 'km') fetchDataKm()
    else fetchDataDest()
  }, [activeTab])

  // --- KM LOGIC ---
  const fetchDataKm = async () => {
    setLoadingKm(true)
    const [{ data: vData }, { data: rData }] = await Promise.all([
      supabase.from("vehicles").select("*, carriers(business_name)").order("plate"),
      supabase.from("vehicle_costs").select("*")
    ])
    setVehicles(vData || [])
    setRates(rData || [])
    setLoadingKm(false)
  }

  const vehiclesWithRates: VehicleWithRate[] = vehicles.map(v => ({
    vehicle: v,
    rate: rates.find(r => r.vehicle_plate === v.plate) ||
          rates.find(r => r.vehicle_type?.toUpperCase() === v.type?.toUpperCase() && r.is_default) ||
          null
  }))

  const rateByPlate = (plate: string) => rates.find(r => r.vehicle_plate === plate)
  const isLinked = (plate: string) => !!rateByPlate(plate)

  const startEditKm = (v: Vehicle) => {
    const existing = rateByPlate(v.plate)
    setEditingPlate(v.plate)
    setEditFormKm({
      vehicle_type: v.type,
      fixed_cost_per_km: existing?.fixed_cost_per_km || 0,
      driver_cost_per_km: existing?.driver_cost_per_km || 0,
      tolls_estimated_cost: existing?.tolls_estimated_cost || 0,
      description: existing?.description || `${v.brand} ${v.model} ${v.year}`
    })
  }

  const handleSaveKm = async (v: Vehicle) => {
    setSavingKm(true)
    const existing = rateByPlate(v.plate)
    const payload = {
      vehicle_plate: v.plate,
      vehicle_type: editFormKm.vehicle_type || v.type,
      description: editFormKm.description,
      fixed_cost_per_km: Number(editFormKm.fixed_cost_per_km),
      driver_cost_per_km: Number(editFormKm.driver_cost_per_km),
      tolls_estimated_cost: Number(editFormKm.tolls_estimated_cost),
      is_default: false
    }

    let error
    if (existing) {
      ({ error } = await supabase.from("vehicle_costs").update(payload).eq("id", existing.id))
    } else {
      ({ error } = await supabase.from("vehicle_costs").insert([payload]))
    }

    if (error) toast.error("Error al guardar: " + error.message)
    else { toast.success(`Tarifa guardada para ${v.plate}`); setEditingPlate(null); fetchDataKm() }
    setSavingKm(false)
  }

  const handleUnlinkKm = async (plate: string) => {
    const existing = rateByPlate(plate)
    if (!existing) return
    if (!confirm(`¿Eliminar tarifa específica de ${plate}? Usará la tarifa genérica de su tipo.`)) return
    const { error } = await supabase.from("vehicle_costs").delete().eq("id", existing.id)
    if (error) toast.error("Error: " + error.message)
    else { toast.success("Tarifa específica eliminada"); fetchDataKm() }
  }

  const totalKmCost = (r: VehicleCost | null) => r ? (r.fixed_cost_per_km + r.driver_cost_per_km) : 0
  const simTotal = (r: VehicleCost | null) => r ? (totalKmCost(r) * simKm + r.tolls_estimated_cost) : 0

  const withRate = vehiclesWithRates.filter(vr => isLinked(vr.vehicle.plate)).length
  const withoutRate = vehiclesWithRates.filter(vr => !isLinked(vr.vehicle.plate)).length
  const avgRate = rates.filter(r => r.vehicle_plate).reduce((s, r) => s + r.fixed_cost_per_km + r.driver_cost_per_km, 0) / (rates.filter(r => r.vehicle_plate).length || 1)

  // --- DESTINATION LOGIC ---
  const fetchDataDest = async () => {
    setLoadingDest(true)
    const { data } = await supabase.from('freight_rates').select('*').order('district')
    setFreightRates(data || [])
    setLoadingDest(false)
  }

  const handleSaveDest = async (e: React.FormEvent) => {
    e.preventDefault()
    setSavingDest(true)
    
    const payload = {
      ...destForm,
      plate_number: destForm.plate_number.trim() === '' ? null : destForm.plate_number,
      capacity_ton: Number(destForm.capacity_ton),
      rate: Number(destForm.rate)
    }

    const { error } = await supabase.from('freight_rates').insert([payload])
    
    if (error) {
      toast.error("Error al guardar: " + error.message)
    } else {
      toast.success("Tarifa fija agregada exitosamente")
      setIsAddingDest(false)
      fetchDataDest()
      setDestForm({
        origin: 'Planta Chilca',
        district: '',
        zone: '',
        vehicle_type: 'Trailer',
        plate_number: '',
        capacity_ton: 0,
        rate: 0
      })
    }
    setSavingDest(false)
  }

  const handleDeleteDest = async (id: string) => {
    if (!confirm("¿Eliminar esta tarifa?")) return
    const { error } = await supabase.from('freight_rates').delete().eq('id', id)
    if (error) toast.error("Error: " + error.message)
    else { toast.success("Tarifa eliminada"); fetchDataDest() }
  }

  return (
    <div className="p-6 w-full space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#002855] flex items-center gap-2">
          <DollarSign className="w-6 h-6 text-yellow-500" /> Modelos de Tarifario
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          Configura y administra las tarifas de flete para la flota propia y tercerizada.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex space-x-1 border-b border-slate-200">
        <button
          onClick={() => setActiveTab('km')}
          className={`flex items-center gap-2 px-6 py-3 border-b-2 font-semibold text-sm transition-colors ${
            activeTab === 'km' 
              ? "border-[#002855] text-[#002855]" 
              : "border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300"
          }`}
        >
          <Zap className="w-4 h-4" />
          Tarifas por KM
        </button>
        <button
          onClick={() => setActiveTab('destino')}
          className={`flex items-center gap-2 px-6 py-3 border-b-2 font-semibold text-sm transition-colors ${
            activeTab === 'destino' 
              ? "border-[#002855] text-[#002855]" 
              : "border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300"
          }`}
        >
          <MapPin className="w-4 h-4" />
          Tarifas Fijas por Destino
        </button>
      </div>

      {/* TAB CONTENT: KM */}
      {activeTab === 'km' && (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
          {/* KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-xl p-4 border border-slate-200 shadow-sm">
              <div className="text-xs text-slate-500 font-semibold uppercase mb-1">Flota Total</div>
              <div className="text-2xl font-black text-[#002855]">{vehicles.length}</div>
              <div className="text-[10px] text-slate-400">vehículos registrados</div>
            </div>
            <div className="bg-white rounded-xl p-4 border border-green-200 bg-green-50 shadow-sm">
              <div className="text-xs text-slate-500 font-semibold uppercase mb-1">Con Tarifa</div>
              <div className="text-2xl font-black text-green-600">{withRate}</div>
              <div className="text-[10px] text-slate-400">tarifas configuradas</div>
            </div>
            <div className={`rounded-xl p-4 border shadow-sm ${withoutRate > 0 ? "border-orange-200 bg-orange-50" : "border-slate-200 bg-white"}`}>
              <div className="text-xs text-slate-500 font-semibold uppercase mb-1">Sin Tarifa</div>
              <div className={`text-2xl font-black ${withoutRate > 0 ? "text-orange-600" : "text-slate-400"}`}>{withoutRate}</div>
              <div className="text-[10px] text-slate-400">pendientes de configurar</div>
            </div>
            <div className="bg-white rounded-xl p-4 border border-slate-200 shadow-sm">
              <div className="text-xs text-slate-500 font-semibold uppercase mb-1">Tarifa Promedio/KM</div>
              <div className="text-2xl font-black text-[#002855]">S/ {avgRate.toFixed(2)}</div>
              <div className="text-[10px] text-slate-400">promedio flota propia</div>
            </div>
          </div>

          {/* Simulador */}
          <div className="bg-gradient-to-r from-[#002855] to-[#0040a0] text-white p-5 rounded-xl shadow-lg">
            <div className="flex items-center gap-2 mb-3">
              <DollarSign className="w-5 h-5 text-yellow-300" />
              <span className="font-bold text-lg">Simulador de Costo por Viaje</span>
            </div>
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <label className="block text-xs text-blue-200 font-semibold mb-1">KM del Viaje</label>
                <input type="number" min="1" value={simKm} onChange={e => setSimKm(Number(e.target.value))}
                  className="w-28 px-3 py-2 bg-white/10 text-white border border-white/20 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400" />
              </div>
              {vehiclesWithRates.filter(vr => vr.rate).slice(0, 6).map(vr => (
                <div key={vr.vehicle.plate} className="bg-white/10 rounded-lg px-4 py-2 text-center min-w-[110px]">
                  <div className="text-[10px] text-blue-200 font-bold">{vr.vehicle.plate}</div>
                  <div className="text-xs text-blue-300">{vr.vehicle.type}</div>
                  <div className="text-xl font-black text-yellow-300">S/ {simTotal(vr.rate).toFixed(0)}</div>
                  <div className="text-[10px] text-blue-300">S/ {totalKmCost(vr.rate).toFixed(2)}/km</div>
                </div>
              ))}
            </div>
          </div>

          {/* Tabla principal */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider border-b border-slate-100">
                  <tr>
                    <th className="p-4 font-semibold">Placa</th>
                    <th className="p-4 font-semibold">Tipo / Marca</th>
                    <th className="p-4 font-semibold">Capacidad</th>
                    <th className="p-4 font-semibold">Transportista</th>
                    <th className="p-4 font-semibold text-right">Costo Fijo/KM</th>
                    <th className="p-4 font-semibold text-right">Costo Chofer/KM</th>
                    <th className="p-4 font-semibold text-right">Total/KM</th>
                    <th className="p-4 font-semibold text-right">Peaje Base</th>
                    <th className="p-4 font-semibold text-center">Tarifa</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {loadingKm ? (
                    <tr><td colSpan={10} className="p-8 text-center text-slate-500">
                      <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2 text-[#002855]" />Cargando flota...
                    </td></tr>
                  ) : vehiclesWithRates.length === 0 ? (
                    <tr><td colSpan={10} className="p-8 text-center text-slate-500">
                      No hay vehículos registrados en Flota. <a href="/flota" className="text-[#002855] underline font-semibold">Ir a Flota →</a>
                    </td></tr>
                  ) : (
                    vehiclesWithRates.map(({ vehicle: v, rate: r }) => (
                      <React.Fragment key={v.plate}>
                        <tr className={`hover:bg-slate-50 transition-colors ${editingPlate === v.plate ? "bg-blue-50" : ""}`}>
                          <td className="p-4">
                            <div className="font-bold text-[#002855] text-sm">{v.plate}</div>
                          </td>
                          <td className="p-4">
                            <div className="font-semibold text-slate-700 text-sm">{v.type}</div>
                            <div className="text-xs text-slate-400">{v.brand} {v.model} {v.year}</div>
                          </td>
                          <td className="p-4 text-xs text-slate-600">
                            <div>{v.weight_capacity} KG</div>
                          </td>
                          <td className="p-4 text-xs text-slate-600">
                            {v.carriers?.business_name || "—"}
                          </td>
                          
                          {editingPlate === v.plate ? (
                            <>
                              <td className="p-2">
                                <input type="number" min="0" step="0.01" className="w-24 px-2 py-1.5 border-2 border-[#002855] rounded text-sm text-slate-900 text-right"
                                  value={editFormKm.fixed_cost_per_km} onChange={e => setEditFormKm(f => ({ ...f, fixed_cost_per_km: Number(e.target.value) }))} />
                              </td>
                              <td className="p-2">
                                <input type="number" min="0" step="0.01" className="w-24 px-2 py-1.5 border-2 border-[#002855] rounded text-sm text-slate-900 text-right"
                                  value={editFormKm.driver_cost_per_km} onChange={e => setEditFormKm(f => ({ ...f, driver_cost_per_km: Number(e.target.value) }))} />
                              </td>
                              <td className="p-2 text-right">
                                <span className="font-bold text-[#002855] text-sm">
                                  S/ {(Number(editFormKm.fixed_cost_per_km) + Number(editFormKm.driver_cost_per_km)).toFixed(2)}
                                </span>
                              </td>
                              <td className="p-2">
                                <input type="number" min="0" step="0.01" className="w-24 px-2 py-1.5 border-2 border-[#002855] rounded text-sm text-slate-900 text-right"
                                  value={editFormKm.tolls_estimated_cost} onChange={e => setEditFormKm(f => ({ ...f, tolls_estimated_cost: Number(e.target.value) }))} />
                              </td>
                              <td className="p-2">
                                <div className="flex gap-1 justify-center">
                                  <button onClick={() => handleSaveKm(v)} disabled={savingKm}
                                    className="p-1.5 bg-green-500 text-white rounded hover:bg-green-600 transition-colors">
                                    {savingKm ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                                  </button>
                                  <button onClick={() => setEditingPlate(null)} className="p-1.5 bg-slate-200 text-slate-700 rounded hover:bg-slate-300 transition-colors">
                                    <X className="w-4 h-4" />
                                  </button>
                                </div>
                              </td>
                            </>
                          ) : (
                            <>
                              <td className="p-4 text-right text-sm text-slate-700">
                                {r ? `S/ ${Number(r.fixed_cost_per_km).toFixed(2)}` : <span className="text-slate-300">—</span>}
                              </td>
                              <td className="p-4 text-right text-sm text-slate-700">
                                {r ? `S/ ${Number(r.driver_cost_per_km).toFixed(2)}` : <span className="text-slate-300">—</span>}
                              </td>
                              <td className="p-4 text-right">
                                {r ? (
                                  <span className="font-bold text-[#002855] bg-blue-50 px-2 py-1 rounded text-sm">
                                    S/ {totalKmCost(r).toFixed(2)}
                                  </span>
                                ) : <span className="text-slate-300">—</span>}
                              </td>
                              <td className="p-4 text-right text-sm text-slate-700">
                                {r ? `S/ ${Number(r.tolls_estimated_cost).toFixed(2)}` : <span className="text-slate-300">—</span>}
                              </td>
                              <td className="p-4">
                                <div className="flex items-center justify-center gap-1">
                                  {isLinked(v.plate) ? (
                                    <>
                                      <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-semibold flex items-center gap-0.5">
                                        <LinkIcon className="w-3 h-3" /> Vinculada
                                      </span>
                                      <button onClick={() => startEditKm(v)} title="Editar tarifa"
                                        className="p-1 text-[#002855] hover:bg-blue-50 rounded transition-colors text-xs font-bold">
                                        Editar
                                      </button>
                                      <button onClick={() => handleUnlinkKm(v.plate)} title="Quitar tarifa específica"
                                        className="p-1 text-red-400 hover:bg-red-50 rounded transition-colors">
                                        <Link2Off className="w-3.5 h-3.5" />
                                      </button>
                                    </>
                                  ) : (
                                    <>
                                      <span className="text-[10px] bg-orange-100 text-orange-600 px-1.5 py-0.5 rounded font-semibold flex items-center gap-0.5">
                                        <AlertTriangle className="w-3 h-3" /> Sin tarifa
                                      </span>
                                      <button onClick={() => startEditKm(v)}
                                        className="p-1 text-sm text-[#002855] hover:bg-blue-50 rounded font-bold transition-colors">
                                        + Asignar
                                      </button>
                                    </>
                                  )}
                                </div>
                              </td>
                            </>
                          )}
                        </tr>
                      </React.Fragment>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {withoutRate > 0 && (
            <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-orange-500 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold text-orange-700">
                  {withoutRate} vehículo{withoutRate > 1 ? "s" : ""} sin tarifa configurada
                </div>
                <div className="text-sm text-orange-600 mt-1">
                  Estos vehículos no podrán calcular automáticamente el costo del viaje en la valorización de OTs si dependen del tarifario por KM.
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB CONTENT: DESTINO */}
      {activeTab === 'destino' && (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
          
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-bold text-[#002855]">Matriz de Tarifas Fijas</h2>
            <div className="flex gap-2">
              <button className="flex items-center gap-2 px-3 py-1.5 bg-slate-100 text-slate-700 font-semibold rounded-lg hover:bg-slate-200 transition-colors border border-slate-200">
                <Import className="w-4 h-4" />
                Carga Masiva
              </button>
              <button 
                onClick={() => setIsAddingDest(!isAddingDest)}
                className="flex items-center gap-2 px-3 py-1.5 bg-[#002855] text-white font-semibold rounded-lg hover:bg-[#001f44] transition-colors shadow-sm"
              >
                {isAddingDest ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                {isAddingDest ? 'Cancelar' : 'Nueva Tarifa'}
              </button>
            </div>
          </div>

          {isAddingDest && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-5 mb-4 shadow-sm animate-in fade-in slide-in-from-top-2">
              <h3 className="font-bold text-[#002855] mb-4">Agregar Nueva Tarifa por Destino</h3>
              <form onSubmit={handleSaveDest} className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Origen</label>
                  <input type="text" required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-[#002855] outline-none bg-white"
                    value={destForm.origin} onChange={e => setDestForm({...destForm, origin: e.target.value})} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Destino (Distrito)</label>
                  <input type="text" required placeholder="Ej. Ate" className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-[#002855] outline-none bg-white"
                    value={destForm.district} onChange={e => setDestForm({...destForm, district: e.target.value})} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Zona</label>
                  <input type="text" placeholder="Ej. ZONA ESTE" className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-[#002855] outline-none bg-white"
                    value={destForm.zone} onChange={e => setDestForm({...destForm, zone: e.target.value})} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Tipo de Unidad</label>
                  <select required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-[#002855] outline-none bg-white"
                    value={destForm.vehicle_type} onChange={e => setDestForm({...destForm, vehicle_type: e.target.value})}>
                    <option value="Trailer">Trailer</option>
                    <option value="Hino">Hino</option>
                    <option value="Volkswagen">Volkswagen</option>
                    <option value="H100">H100</option>
                    <option value="Furgón">Furgón</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Capacidad (Tn)</label>
                  <input type="number" step="0.1" required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-[#002855] outline-none bg-white"
                    value={destForm.capacity_ton} onChange={e => setDestForm({...destForm, capacity_ton: Number(e.target.value)})} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Placa (Opcional)</label>
                  <input type="text" placeholder="Ej. BCW838" className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-[#002855] outline-none bg-white uppercase"
                    value={destForm.plate_number} onChange={e => setDestForm({...destForm, plate_number: e.target.value})} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Tarifa Total (S/)</label>
                  <input type="number" step="0.01" required className="w-full px-3 py-2 border-2 border-yellow-400 font-bold rounded-lg text-sm focus:ring-2 focus:ring-[#002855] outline-none bg-white text-[#002855]"
                    value={destForm.rate} onChange={e => setDestForm({...destForm, rate: Number(e.target.value)})} />
                </div>
                <div>
                  <button type="submit" disabled={savingDest} className="w-full bg-green-500 text-white font-bold py-2 rounded-lg hover:bg-green-600 transition-colors flex justify-center items-center h-[38px]">
                    {savingDest ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Guardar Tarifa'}
                  </button>
                </div>
              </form>
            </div>
          )}

          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider border-b border-slate-100">
                  <tr>
                    <th className="p-4 font-semibold">Origen</th>
                    <th className="p-4 font-semibold">Destino / Distrito</th>
                    <th className="p-4 font-semibold">Zona</th>
                    <th className="p-4 font-semibold">Tipo Unidad</th>
                    <th className="p-4 font-semibold text-center">Placa</th>
                    <th className="p-4 font-semibold text-right">Cap. (Tn)</th>
                    <th className="p-4 font-semibold text-right">Tarifa Fija</th>
                    <th className="p-4 font-semibold text-center">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {loadingDest ? (
                    <tr><td colSpan={8} className="p-8 text-center text-slate-500">
                      <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2 text-[#002855]" />Cargando matriz...
                    </td></tr>
                  ) : freightRates.length === 0 ? (
                    <tr><td colSpan={8} className="p-8 text-center text-slate-500">
                      No hay tarifas fijas registradas. <br/>
                      <button onClick={() => setIsAddingDest(true)} className="text-[#002855] font-semibold underline mt-2">Agregar la primera</button>
                    </td></tr>
                  ) : (
                    freightRates.map(rate => (
                      <tr key={rate.id} className="hover:bg-slate-50 transition-colors">
                        <td className="p-4 text-sm font-semibold text-slate-700">{rate.origin}</td>
                        <td className="p-4 text-sm font-bold text-[#002855]">{rate.district}</td>
                        <td className="p-4 text-xs text-slate-500">{rate.zone || "—"}</td>
                        <td className="p-4 text-sm font-medium text-slate-700">{rate.vehicle_type}</td>
                        <td className="p-4 text-center">
                          {rate.plate_number ? (
                            <span className="bg-slate-100 border border-slate-300 text-slate-700 px-2 py-0.5 rounded text-xs font-bold uppercase">{rate.plate_number}</span>
                          ) : (
                            <span className="text-slate-300 text-xs italic">Cualquiera</span>
                          )}
                        </td>
                        <td className="p-4 text-right text-sm text-slate-600">{rate.capacity_ton.toFixed(1)} Tn</td>
                        <td className="p-4 text-right font-black text-[#002855]">S/ {rate.rate.toFixed(2)}</td>
                        <td className="p-4 text-center">
                          <button onClick={() => handleDeleteDest(rate.id)} className="p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500 rounded transition-colors" title="Eliminar Tarifa">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      )}

    </div>
  )
}
