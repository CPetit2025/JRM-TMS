"use client"
import React, { useState, useEffect } from "react"
import { Zap, Truck, DollarSign, Check, X, Loader2, AlertTriangle, LinkIcon, Link2Off } from "lucide-react"
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

interface VehicleWithRate {
  vehicle: Vehicle
  rate: VehicleCost | null
}

export default function TarifasPage() {
  const supabase = createClient()
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [rates, setRates] = useState<VehicleCost[]>([])
  const [loading, setLoading] = useState(true)
  const [editingPlate, setEditingPlate] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [simKm, setSimKm] = useState(50)

  // Formulario de edición inline por placa
  const [editForm, setEditForm] = useState({
    vehicle_type: "",
    fixed_cost_per_km: 0,
    driver_cost_per_km: 0,
    tolls_estimated_cost: 0,
    description: ""
  })

  useEffect(() => { fetchData() }, [])

  const fetchData = async () => {
    setLoading(true)
    const [{ data: vData }, { data: rData }] = await Promise.all([
      supabase.from("vehicles").select("*, carriers(business_name)").order("plate"),
      supabase.from("vehicle_costs").select("*")
    ])
    setVehicles(vData || [])
    setRates(rData || [])
    setLoading(false)
  }

  // Joins lógico: cada vehículo busca su tarifa por plate
  const vehiclesWithRates: VehicleWithRate[] = vehicles.map(v => ({
    vehicle: v,
    rate: rates.find(r => r.vehicle_plate === v.plate) ||
          rates.find(r => r.vehicle_type?.toUpperCase() === v.type?.toUpperCase() && r.is_default) ||
          null
  }))

  const rateByPlate = (plate: string) => rates.find(r => r.vehicle_plate === plate)
  const isLinked = (plate: string) => !!rateByPlate(plate)

  const startEdit = (v: Vehicle) => {
    const existing = rateByPlate(v.plate)
    setEditingPlate(v.plate)
    setEditForm({
      vehicle_type: v.type,
      fixed_cost_per_km: existing?.fixed_cost_per_km || 0,
      driver_cost_per_km: existing?.driver_cost_per_km || 0,
      tolls_estimated_cost: existing?.tolls_estimated_cost || 0,
      description: existing?.description || `${v.brand} ${v.model} ${v.year}`
    })
  }

  const cancelEdit = () => { setEditingPlate(null) }

  const handleSave = async (v: Vehicle) => {
    setSaving(true)
    const existing = rateByPlate(v.plate)
    const payload = {
      vehicle_plate: v.plate,
      vehicle_type: editForm.vehicle_type || v.type,
      description: editForm.description,
      fixed_cost_per_km: Number(editForm.fixed_cost_per_km),
      driver_cost_per_km: Number(editForm.driver_cost_per_km),
      tolls_estimated_cost: Number(editForm.tolls_estimated_cost),
      is_default: false
    }

    let error
    if (existing) {
      ({ error } = await supabase.from("vehicle_costs").update(payload).eq("id", existing.id))
    } else {
      ({ error } = await supabase.from("vehicle_costs").insert([payload]))
    }

    if (error) toast.error("Error al guardar: " + error.message)
    else { toast.success(`Tarifa guardada para ${v.plate}`); setEditingPlate(null); fetchData() }
    setSaving(false)
  }

  const handleUnlink = async (plate: string) => {
    const existing = rateByPlate(plate)
    if (!existing) return
    if (!confirm(`¿Eliminar tarifa específica de ${plate}? Usará la tarifa genérica de su tipo.`)) return
    const { error } = await supabase.from("vehicle_costs").delete().eq("id", existing.id)
    if (error) toast.error("Error: " + error.message)
    else { toast.success("Tarifa específica eliminada"); fetchData() }
  }

  const totalKmCost = (r: VehicleCost | null) => r ? (r.fixed_cost_per_km + r.driver_cost_per_km) : 0
  const simTotal = (r: VehicleCost | null) => r ? (totalKmCost(r) * simKm + r.tolls_estimated_cost) : 0

  // KPIs
  const withRate = vehiclesWithRates.filter(vr => isLinked(vr.vehicle.plate)).length
  const withoutRate = vehiclesWithRates.filter(vr => !isLinked(vr.vehicle.plate)).length
  const avgRate = rates.filter(r => r.vehicle_plate).reduce((s, r) => s + r.fixed_cost_per_km + r.driver_cost_per_km, 0) / (rates.filter(r => r.vehicle_plate).length || 1)

  return (
    <div className="p-6 w-full space-y-6">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-bold text-[#002855] flex items-center gap-2">
            <Zap className="w-6 h-6 text-yellow-500" /> Tarifas por KM
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Cada vehículo registrado en Flota tiene su propia tarifa de costo. Los datos provienen directamente de <strong>/flota</strong>.
          </p>
        </div>
      </div>

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
                <th className="p-4 font-semibold">Estado Vehículo</th>
                <th className="p-4 font-semibold text-right">Costo Fijo/KM</th>
                <th className="p-4 font-semibold text-right">Costo Chofer/KM</th>
                <th className="p-4 font-semibold text-right">Total/KM</th>
                <th className="p-4 font-semibold text-right">Peaje Base</th>
                <th className="p-4 font-semibold text-center">Tarifa</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
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
                      <td className="p-4">
                        <span className={`px-2 py-1 text-[10px] font-semibold rounded-full ${
                          v.status === "DISPONIBLE" ? "bg-green-100 text-green-700" :
                          v.status === "EN_RUTA" ? "bg-blue-100 text-blue-700" :
                          "bg-yellow-100 text-yellow-700"
                        }`}>{v.status}</span>
                      </td>

                      {editingPlate === v.plate ? (
                        // Modo edición inline
                        <>
                          <td className="p-2">
                            <input type="number" min="0" step="0.01" className="w-24 px-2 py-1.5 border-2 border-[#002855] rounded text-sm text-slate-900 text-right"
                              value={editForm.fixed_cost_per_km} onChange={e => setEditForm(f => ({ ...f, fixed_cost_per_km: Number(e.target.value) }))} />
                          </td>
                          <td className="p-2">
                            <input type="number" min="0" step="0.01" className="w-24 px-2 py-1.5 border-2 border-[#002855] rounded text-sm text-slate-900 text-right"
                              value={editForm.driver_cost_per_km} onChange={e => setEditForm(f => ({ ...f, driver_cost_per_km: Number(e.target.value) }))} />
                          </td>
                          <td className="p-2 text-right">
                            <span className="font-bold text-[#002855] text-sm">
                              S/ {(Number(editForm.fixed_cost_per_km) + Number(editForm.driver_cost_per_km)).toFixed(2)}
                            </span>
                          </td>
                          <td className="p-2">
                            <input type="number" min="0" step="0.01" className="w-24 px-2 py-1.5 border-2 border-[#002855] rounded text-sm text-slate-900 text-right"
                              value={editForm.tolls_estimated_cost} onChange={e => setEditForm(f => ({ ...f, tolls_estimated_cost: Number(e.target.value) }))} />
                          </td>
                          <td className="p-2">
                            <div className="flex gap-1 justify-center">
                              <button onClick={() => handleSave(v)} disabled={saving}
                                className="p-1.5 bg-green-500 text-white rounded hover:bg-green-600 transition-colors">
                                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                              </button>
                              <button onClick={cancelEdit} className="p-1.5 bg-slate-200 text-slate-700 rounded hover:bg-slate-300 transition-colors">
                                <X className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </>
                      ) : (
                        // Modo visualización
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
                                  <button onClick={() => startEdit(v)} title="Editar tarifa"
                                    className="p-1 text-[#002855] hover:bg-blue-50 rounded transition-colors text-xs font-bold">
                                    Editar
                                  </button>
                                  <button onClick={() => handleUnlink(v.plate)} title="Quitar tarifa específica"
                                    className="p-1 text-red-400 hover:bg-red-50 rounded transition-colors">
                                    <Link2Off className="w-3.5 h-3.5" />
                                  </button>
                                </>
                              ) : (
                                <>
                                  <span className="text-[10px] bg-orange-100 text-orange-600 px-1.5 py-0.5 rounded font-semibold flex items-center gap-0.5">
                                    <AlertTriangle className="w-3 h-3" /> Sin tarifa
                                  </span>
                                  <button onClick={() => startEdit(v)}
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
                    {editingPlate === v.plate && (
                      <tr className="bg-blue-50 border-b-2 border-[#002855]">
                        <td colSpan={10} className="px-4 py-2">
                          <div className="flex items-center gap-4 text-sm text-slate-600">
                            <span className="font-semibold text-[#002855]">Editando tarifa de {v.plate}:</span>
                            <label className="flex items-center gap-1">Descripción:
                              <input className="ml-1 px-2 py-1 border border-slate-300 rounded text-sm text-slate-900 w-64"
                                value={editForm.description} onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))} />
                            </label>
                            <span className="text-slate-400 text-xs">Costo vehicular + chofer + peaje → costo total del viaje para este vehículo</span>
                          </div>
                        </td>
                      </tr>
                    )}
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
              Estos vehículos no podrán calcular automáticamente el costo del viaje en la valorización de OTs.
              Haz clic en <strong>"+ Asignar"</strong> en la fila del vehículo para configurar su tarifa.
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
