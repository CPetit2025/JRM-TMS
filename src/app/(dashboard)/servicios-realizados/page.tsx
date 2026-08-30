"use client"
import { useState, useEffect } from "react"
import {
  ArchiveRestore, Download, Search, Filter, Loader2, Calendar, MapPin,
  DollarSign, TrendingUp, TrendingDown, AlertTriangle, CheckCircle2,
  Plus, Trash2, Zap, Check
} from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import { toast } from "sonner"
import { Modal } from "@/components/ui/modal"

interface FlattenedOT {
  id: string
  ot_id: string
  dispatch_id: string
  dispatch_number: string
  driver_name: string
  vehicle_plate: string
  scheduled_departure: string
  dispatch_status: string
  estimated_distance_km: number
  ot_document: string
  ot_status: string
  pickup_address: string
  delivery_address: string
  service_cost: number
  service_balance: number
  budget_amount: number
  cost_per_km: number
  liquidation_notes: string
  ots_in_dispatch: number
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

interface DispatchExpense {
  id: string
  expense_type: string
  amount: number
  description: string
}

const STATUS_COLORS: Record<string, string> = {
  PROGRAMADO: "bg-yellow-100 text-yellow-700",
  EN_CURSO: "bg-blue-100 text-blue-700",
  "EN RUTA": "bg-blue-100 text-blue-700",
  ESPERANDO_AUTORIZACION: "bg-orange-100 text-orange-700",
  RETORNO: "bg-indigo-100 text-indigo-700",
  ENTREGADO: "bg-green-100 text-green-700",
  LIQUIDADO: "bg-emerald-100 text-emerald-700",
}

const EXPENSE_TYPES = ["COMBUSTIBLE", "PEAJE", "ESTIBA", "VIATICOS", "OTROS"]

export default function ServiciosRealizadosPage() {
  const supabase = createClient()
  const [ots, setOts] = useState<FlattenedOT[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState("")
  const [statusFilter, setStatusFilter] = useState("TODOS")

  const [selectedOT, setSelectedOT] = useState<FlattenedOT | null>(null)
  const [vehicleRates, setVehicleRates] = useState<VehicleCost[]>([])
  const [dispatchExpenses, setDispatchExpenses] = useState<DispatchExpense[]>([])
  const [saving, setSaving] = useState(false)
  const [loadingExpenses, setLoadingExpenses] = useState(false)

  const [liqForm, setLiqForm] = useState({
    budget_amount: 0,
    override_rate: false,
    manual_cost_per_km: 0,
    liquidation_notes: ""
  })
  const [newExpense, setNewExpense] = useState({ expense_type: "PEAJE", amount: 0, description: "" })

  useEffect(() => { fetchHistory(); fetchVehicleRates() }, [])

  const fetchVehicleRates = async () => {
    const { data } = await supabase.from("vehicle_costs").select("*").order("vehicle_type")
    setVehicleRates(data || [])
  }

  const fetchHistory = async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from("dispatches")
        .select(`
          id, dispatch_number, driver_name, vehicle_plate, scheduled_departure, status, estimated_distance_km,
          dispatch_requests(
            transport_request_id, status, document_type, document_number,
            transport_requests(id, request_number, pickup_address, delivery_address, service_cost, service_balance, budget_amount, cost_per_km, liquidation_notes)
          )
        `)
        .order("created_at", { ascending: false })

      if (error) throw error

      const flatOTs: FlattenedOT[] = []
      const rawDispatches = (data as any[]) || []

      rawDispatches.forEach((d: any) => {
        const totalOTs = d.dispatch_requests?.length || 1
        d.dispatch_requests?.forEach((dr: any) => {
          const tr = dr.transport_requests
          flatOTs.push({
            id: `${d.id}-${dr.transport_request_id}`,
            ot_id: tr?.id || "",
            dispatch_id: d.id,
            dispatch_number: d.dispatch_number,
            driver_name: d.driver_name || "Sin Chofer",
            vehicle_plate: d.vehicle_plate || "Sin Placa",
            scheduled_departure: d.scheduled_departure,
            dispatch_status: d.status,
            estimated_distance_km: d.estimated_distance_km || 0,
            ot_document: dr.document_number || tr?.request_number || "S/N",
            ot_status: dr.status || d.status,
            pickup_address: tr?.pickup_address || "No especificado",
            delivery_address: tr?.delivery_address || "No especificado",
            service_cost: tr?.service_cost || 0,
            service_balance: tr?.service_balance || 0,
            budget_amount: tr?.budget_amount || 0,
            cost_per_km: tr?.cost_per_km || 0,
            liquidation_notes: tr?.liquidation_notes || "",
            ots_in_dispatch: totalOTs
          })
        })
      })

      setOts(flatOTs)
    } catch (err: any) {
      toast.error("Error al cargar historial: " + err.message)
    } finally {
      setLoading(false)
    }
  }

  const fetchDispatchExpenses = async (dispatchId: string) => {
    setLoadingExpenses(true)
    const { data } = await supabase.from("dispatch_expenses").select("*").eq("dispatch_id", dispatchId).order("created_at")
    setDispatchExpenses(data || [])
    setLoadingExpenses(false)
  }

  const openLiquidation = async (ot: FlattenedOT) => {
    setSelectedOT(ot)
    // Auto-detect rate by plate first, then by type
    const rateByPlate = vehicleRates.find(r => r.vehicle_plate === ot.vehicle_plate)
    const autoRate = rateByPlate
    const autoCostPerKm = autoRate
      ? (autoRate.fixed_cost_per_km + autoRate.driver_cost_per_km)
      : (ot.cost_per_km || 0)
    setLiqForm({
      budget_amount: ot.budget_amount || 0,
      override_rate: !autoRate && ot.cost_per_km > 0,
      manual_cost_per_km: autoRate ? autoCostPerKm : (ot.cost_per_km || 0),
      liquidation_notes: ot.liquidation_notes || ""
    })
    await fetchDispatchExpenses(ot.dispatch_id)
  }

  const getAutoRate = () => selectedOT ? vehicleRates.find(r => r.vehicle_plate === selectedOT.vehicle_plate) : null
  const effectiveCostPerKm = () => {
    const r = getAutoRate()
    if (r && !liqForm.override_rate) return r.fixed_cost_per_km + r.driver_cost_per_km
    return liqForm.manual_cost_per_km
  }
  const totalExpenses = () => dispatchExpenses.reduce((s, e) => s + Number(e.amount), 0)
  const dispatchTotalCost = () => {
    const r = getAutoRate()
    const km = selectedOT?.estimated_distance_km || 0
    const tolls = (r && !liqForm.override_rate) ? r.tolls_estimated_cost : 0
    return effectiveCostPerKm() * km + tolls + totalExpenses()
  }
  const otCost = () => {
    const n = selectedOT?.ots_in_dispatch || 1
    return dispatchTotalCost() / n
  }
  const otBalance = () => liqForm.budget_amount - otCost()

  const healthColor = (balance: number, budget: number) => {
    if (budget === 0) return "text-slate-400"
    if (balance < 0) return "text-red-600"
    if (balance < budget * 0.2) return "text-orange-500"
    return "text-green-600"
  }

  const healthBadge = (ot: FlattenedOT) => {
    if (ot.budget_amount === 0 || ot.service_cost === 0)
      return <span className="text-[10px] bg-slate-100 text-slate-400 px-1.5 py-0.5 rounded font-semibold">SIN VALORIZAR</span>
    if (ot.service_balance < 0)
      return <span className="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-semibold flex items-center gap-0.5"><TrendingDown className="w-3 h-3"/>SOBRE PRESUP.</span>
    if (ot.service_balance < ot.budget_amount * 0.2)
      return <span className="text-[10px] bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded font-semibold flex items-center gap-0.5"><AlertTriangle className="w-3 h-3"/>ALERTA</span>
    return <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-semibold flex items-center gap-0.5"><CheckCircle2 className="w-3 h-3"/>OK</span>
  }

  const handleAddExpense = async () => {
    if (!selectedOT || newExpense.amount <= 0) { toast.error("Ingresa un monto valido"); return }
    const { error } = await supabase.from("dispatch_expenses").insert([{
      dispatch_id: selectedOT.dispatch_id,
      expense_type: newExpense.expense_type,
      amount: newExpense.amount,
      description: newExpense.description
    }])
    if (error) { toast.error("Error: " + error.message); return }
    setNewExpense({ expense_type: "PEAJE", amount: 0, description: "" })
    if (selectedOT) await fetchDispatchExpenses(selectedOT.dispatch_id)
    toast.success("Gasto registrado")
  }

  const handleDeleteExpense = async (id: string) => {
    await supabase.from("dispatch_expenses").delete().eq("id", id)
    if (selectedOT) await fetchDispatchExpenses(selectedOT.dispatch_id)
  }

  const handleSaveLiquidation = async () => {
    if (!selectedOT) return
    setSaving(true)
    const cost = otCost()
    const balance = otBalance()
    const { error } = await supabase.from("transport_requests").update({
      budget_amount: liqForm.budget_amount,
      service_cost: parseFloat(cost.toFixed(2)),
      service_balance: parseFloat(balance.toFixed(2)),
      cost_per_km: effectiveCostPerKm(),
      liquidation_notes: liqForm.liquidation_notes
    }).eq("id", selectedOT.ot_id)

    if (error) toast.error("Error al guardar: " + error.message)
    else { toast.success("Valorizacion guardada"); setSelectedOT(null); fetchHistory() }
    setSaving(false)
  }

  const filteredOts = ots.filter(ot => {
    const matchSearch = [ot.ot_document, ot.dispatch_number, ot.driver_name, ot.vehicle_plate]
      .some(f => f.toLowerCase().includes(searchTerm.toLowerCase()))
    const matchStatus = statusFilter === "TODOS" || ot.ot_status === statusFilter || ot.dispatch_status === statusFilter
    return matchSearch && matchStatus
  })

  const totalCost = filteredOts.reduce((s, o) => s + o.service_cost, 0)
  const totalBudget = filteredOts.reduce((s, o) => s + o.budget_amount, 0)
  const totalBalance = filteredOts.reduce((s, o) => s + o.service_balance, 0)
  const overBudget = filteredOts.filter(o => o.service_balance < 0 && o.budget_amount > 0).length
  const valorized = filteredOts.filter(o => o.service_cost > 0).length

  const handleExportCSV = () => {
    if (filteredOts.length === 0) { toast.error("No hay datos"); return }
    const headers = ["Documento OT","Despacho","Chofer","Placa","Fecha","KM","Origen","Destino","Estado OT","Partida","Costo OT","Saldo","Notas"]
    const rows = filteredOts.map(ot => [
      ot.ot_document, ot.dispatch_number, ot.driver_name, ot.vehicle_plate,
      new Date(ot.scheduled_departure).toLocaleString(), ot.estimated_distance_km,
      ot.pickup_address, ot.delivery_address, ot.ot_status,
      ot.budget_amount.toFixed(2), ot.service_cost.toFixed(2), ot.service_balance.toFixed(2), ot.liquidation_notes
    ].map(f => `"${String(f).replace(/"/g,'""')}"`).join(","))
    const link = document.createElement("a")
    link.href = URL.createObjectURL(new Blob([[headers.join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8;" }))
    link.download = `servicios_${new Date().toISOString().split("T")[0]}.csv`
    link.click()
    toast.success("Reporte descargado")
  }

  return (
    <div className="p-6 w-full mx-auto space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#002855] flex items-center gap-2">
            <ArchiveRestore className="w-6 h-6" /> Servicios Realizados
          </h1>
          <p className="text-slate-500 text-sm mt-1">Historial de OTs · Valorizacion y control de partidas</p>
        </div>
        <button onClick={handleExportCSV}
          className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium text-sm shadow-sm transition-colors">
          <Download className="w-4 h-4" /> Exportar Excel (CSV)
        </button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="bg-white rounded-xl p-4 border border-slate-200 shadow-sm">
          <div className="text-xs text-slate-500 font-semibold uppercase mb-1">Total OTs</div>
          <div className="text-2xl font-black text-[#002855]">{filteredOts.length}</div>
          <div className="text-[10px] text-slate-400">{valorized} valorizadas</div>
        </div>
        <div className="bg-white rounded-xl p-4 border border-slate-200 shadow-sm">
          <div className="text-xs text-slate-500 font-semibold uppercase mb-1">Partida Total</div>
          <div className="text-xl font-black text-slate-700">S/ {totalBudget.toFixed(0)}</div>
          <div className="text-[10px] text-slate-400">Presupuesto asignado</div>
        </div>
        <div className="bg-white rounded-xl p-4 border border-slate-200 shadow-sm">
          <div className="text-xs text-slate-500 font-semibold uppercase mb-1">Costo Total</div>
          <div className="text-xl font-black text-slate-800">S/ {totalCost.toFixed(0)}</div>
          <div className="text-[10px] text-slate-400">Ejecutado acumulado</div>
        </div>
        <div className={`rounded-xl p-4 border shadow-sm ${totalBalance < 0 ? "border-red-300 bg-red-50" : "border-green-200 bg-green-50"}`}>
          <div className="text-xs text-slate-500 font-semibold uppercase mb-1">Saldo Total</div>
          <div className={`text-xl font-black ${totalBalance < 0 ? "text-red-600" : "text-green-600"}`}>
            S/ {totalBalance.toFixed(0)}
          </div>
          <div className="text-[10px] text-slate-400">Partida minus Costo</div>
        </div>
        <div className={`rounded-xl p-4 border shadow-sm ${overBudget > 0 ? "border-red-300 bg-red-50" : "bg-white border-slate-200"}`}>
          <div className="text-xs text-slate-500 font-semibold uppercase mb-1">Sobre Presupuesto</div>
          <div className={`text-2xl font-black ${overBudget > 0 ? "text-red-600" : "text-green-600"}`}>{overBudget}</div>
          <div className="text-[10px] text-slate-400">OTs en perdida</div>
        </div>
      </div>

      {/* Filtros */}
      <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex flex-col md:flex-row gap-4">
        <div className="flex-1 relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
          <input type="text" placeholder="Buscar por Doc OT, Despacho, Placa o Chofer..."
            value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-4 py-2 border border-slate-300 rounded-lg text-sm text-slate-900 placeholder:text-slate-400" />
        </div>
        <div className="w-full md:w-64 relative">
          <Filter className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            className="w-full pl-9 pr-4 py-2 border border-slate-300 rounded-lg text-sm text-slate-900 appearance-none">
            <option value="TODOS">Todos los Estados</option>
            <option value="ENTREGADO">ENTREGADO</option>
            <option value="LIQUIDADO">LIQUIDADO</option>
            <option value="RETORNO">RETORNO</option>
            <option value="EN_CURSO">EN CURSO</option>
            <option value="PROGRAMADO">PROGRAMADO</option>
          </select>
        </div>
      </div>

      {/* Tabla */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-50 text-slate-500 text-xs border-b border-slate-100 uppercase tracking-wider">
              <tr>
                <th className="p-3 font-semibold">Salud</th>
                <th className="p-3 font-semibold whitespace-nowrap">Documento OT</th>
                <th className="p-3 font-semibold whitespace-nowrap">Despacho</th>
                <th className="p-3 font-semibold whitespace-nowrap">Fecha</th>
                <th className="p-3 font-semibold whitespace-nowrap">Unidad</th>
                <th className="p-3 font-semibold whitespace-nowrap">Chofer</th>
                <th className="p-3 font-semibold whitespace-nowrap">Origen</th>
                <th className="p-3 font-semibold whitespace-nowrap">Destino</th>
                <th className="p-3 font-semibold text-right whitespace-nowrap">Partida (S/)</th>
                <th className="p-3 font-semibold text-right whitespace-nowrap">Costo OT (S/)</th>
                <th className="p-3 font-semibold text-right whitespace-nowrap">Saldo (S/)</th>
                <th className="p-3 font-semibold whitespace-nowrap">Estado OT</th>
                <th className="p-3 font-semibold text-center">Valorizar</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={13} className="p-8 text-center text-slate-500">
                  <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2 text-[#002855]" />Cargando historial...
                </td></tr>
              ) : filteredOts.length === 0 ? (
                <tr><td colSpan={13} className="p-8 text-center text-slate-500">No se encontraron servicios.</td></tr>
              ) : (
                filteredOts.map(ot => (
                  <tr key={ot.id} className="hover:bg-slate-50 transition-colors">
                    <td className="p-3">{healthBadge(ot)}</td>
                    <td className="p-3"><span className="font-bold text-slate-800 text-xs">{ot.ot_document}</span></td>
                    <td className="p-3"><span className="font-bold text-[#002855] text-xs">{ot.dispatch_number}</span></td>
                    <td className="p-3">
                      <div className="flex items-center gap-1 text-[11px] text-slate-500 whitespace-nowrap">
                        <Calendar className="w-3.5 h-3.5 text-slate-400" />
                        {new Date(ot.scheduled_departure).toLocaleDateString()}
                      </div>
                    </td>
                    <td className="p-3"><span className="font-bold text-slate-700 text-xs">{ot.vehicle_plate}</span></td>
                    <td className="p-3"><span className="text-xs text-slate-600">{ot.driver_name}</span></td>
                    <td className="p-3 max-w-[150px]">
                      <div className="flex items-start gap-1 text-[11px] text-slate-600">
                        <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                        <span className="truncate" title={ot.pickup_address}>{ot.pickup_address}</span>
                      </div>
                    </td>
                    <td className="p-3 max-w-[150px]">
                      <div className="flex items-start gap-1 text-[11px] text-slate-600">
                        <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                        <span className="truncate" title={ot.delivery_address}>{ot.delivery_address}</span>
                      </div>
                    </td>
                    <td className="p-3 text-right">
                      <span className="text-xs font-semibold text-slate-600">
                        {ot.budget_amount > 0 ? ot.budget_amount.toFixed(2) : <span className="text-slate-300">—</span>}
                      </span>
                    </td>
                    <td className="p-3 text-right">
                      <span className="text-xs font-semibold text-slate-800">
                        {ot.service_cost > 0 ? ot.service_cost.toFixed(2) : <span className="text-slate-300">—</span>}
                      </span>
                    </td>
                    <td className="p-3 text-right">
                      <span className={`text-xs font-bold ${ot.service_cost > 0 ? healthColor(ot.service_balance, ot.budget_amount) : "text-slate-300"}`}>
                        {ot.service_cost > 0 ? ot.service_balance.toFixed(2) : "—"}
                      </span>
                    </td>
                    <td className="p-3">
                      <span className={`px-2 py-1 text-[10px] font-semibold rounded-md whitespace-nowrap ${STATUS_COLORS[ot.ot_status] || "bg-slate-100 text-slate-700"}`}>
                        {ot.ot_status}
                      </span>
                    </td>
                    <td className="p-3 text-center">
                      <button onClick={() => openLiquidation(ot)}
                        className="p-1.5 bg-[#002855] text-white hover:bg-[#001d3d] rounded-lg transition-colors" title="Valorizar OT">
                        <DollarSign className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal de Liquidacion */}
      <Modal isOpen={!!selectedOT} onClose={() => setSelectedOT(null)}
        title={`Valorizacion OT: ${selectedOT?.ot_document}`} maxWidth="max-w-5xl">
        {selectedOT && (
          <div className="space-y-5">
            {/* Info Despacho */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              {[
                { label: "Despacho", val: selectedOT.dispatch_number, sub: "" },
                { label: "Unidad / Chofer", val: selectedOT.vehicle_plate, sub: selectedOT.driver_name },
                { label: "KM del Viaje", val: `${selectedOT.estimated_distance_km} KM`, sub: "" },
                { label: "OTs en este viaje", val: String(selectedOT.ots_in_dispatch), sub: "Costo prorrateado" },
              ].map(c => (
                <div key={c.label} className="bg-slate-50 rounded-lg p-3 border border-slate-200">
                  <div className="text-xs text-slate-400 font-semibold uppercase">{c.label}</div>
                  <div className="font-bold text-[#002855]">{c.val}</div>
                  {c.sub && <div className="text-xs text-slate-500">{c.sub}</div>}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Izquierda: Configuracion */}
              <div className="space-y-4">
                <h3 className="font-bold text-slate-800 flex items-center gap-2">
                  <Zap className="w-4 h-4 text-yellow-500" /> Configuracion de Costo
                </h3>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Partida / Presupuesto (S/)</label>
                  <input type="number" min="0" step="0.01"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900 focus:ring-2 focus:ring-[#002855]"
                    value={liqForm.budget_amount}
                    onChange={e => setLiqForm(f => ({ ...f, budget_amount: Number(e.target.value) }))} />
                  <p className="text-[10px] text-slate-400 mt-1">Monto asignado para este servicio de transporte</p>
                </div>
                {/* Tarifa auto-detectada por placa */}
                {(() => {
                  const autoRate = getAutoRate()
                  return autoRate ? (
                    <div className={`rounded-lg p-3 border ${liqForm.override_rate ? 'border-slate-200 bg-slate-50' : 'border-green-200 bg-green-50'}`}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-bold text-slate-600 uppercase">Tarifa detectada de Flota</span>
                        <button onClick={() => setLiqForm(f => ({ ...f, override_rate: !f.override_rate }))}
                          className="text-[10px] text-slate-500 underline hover:text-[#002855]">
                          {liqForm.override_rate ? 'Usar tarifa de flota' : 'Ingresar manualmente'}
                        </button>
                      </div>
                      {!liqForm.override_rate ? (
                        <div className="flex items-center gap-3">
                          <div className="font-bold text-[#002855] text-lg">S/ {(autoRate.fixed_cost_per_km + autoRate.driver_cost_per_km).toFixed(2)}<span className="text-xs font-normal text-slate-500">/km</span></div>
                          <div className="text-xs text-slate-600">
                            <span className="bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-semibold">{selectedOT?.vehicle_plate}</span>
                            <span className="ml-1 text-slate-400">{autoRate.description}</span>
                          </div>
                          <div className="text-xs text-slate-500 ml-auto">+ S/ {autoRate.tolls_estimated_cost} peaje</div>
                        </div>
                      ) : (
                        <input type="number" min="0" step="0.01" placeholder="Costo/KM manual"
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900 focus:ring-2 focus:ring-[#002855]"
                          value={liqForm.manual_cost_per_km}
                          onChange={e => setLiqForm(f => ({ ...f, manual_cost_per_km: Number(e.target.value) }))} />
                      )}
                    </div>
                  ) : (
                    <div className="rounded-lg p-3 border border-orange-200 bg-orange-50">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold text-orange-700 flex items-center gap-1">⚠ Sin tarifa configurada para {selectedOT?.vehicle_plate}</span>
                        <a href="/maestros/tarifas" className="text-[10px] text-[#002855] underline" target="_blank">Configurar en Tarifas →</a>
                      </div>
                      <input type="number" min="0" step="0.01" placeholder="Ingresa costo/km manualmente"
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900 focus:ring-2 focus:ring-[#002855]"
                        value={liqForm.manual_cost_per_km}
                        onChange={e => setLiqForm(f => ({ ...f, manual_cost_per_km: Number(e.target.value) }))} />
                    </div>
                  )
                })()}
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Notas de Liquidacion</label>
                  <textarea rows={2} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900 resize-none"
                    value={liqForm.liquidation_notes}
                    onChange={e => setLiqForm(f => ({ ...f, liquidation_notes: e.target.value }))}
                    placeholder="Observaciones, incidencias, etc." />
                </div>

                {/* Gastos Variables */}
                <div>
                  <h4 className="font-semibold text-slate-700 text-sm mb-2">Gastos Variables del Viaje</h4>
                  <div className="space-y-2 mb-2">
                    {loadingExpenses ? <div className="text-xs text-slate-400 p-2">Cargando...</div> :
                      dispatchExpenses.length === 0 ? <div className="text-xs text-slate-300 p-2">Sin gastos registrados</div> :
                      dispatchExpenses.map(exp => (
                        <div key={exp.id} className="flex items-center justify-between bg-slate-50 rounded-lg px-3 py-2 border border-slate-200">
                          <div>
                            <span className="text-xs font-semibold text-slate-700">{exp.expense_type}</span>
                            {exp.description && <span className="text-[10px] text-slate-400 ml-2">{exp.description}</span>}
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-slate-800 text-sm">S/ {Number(exp.amount).toFixed(2)}</span>
                            <button onClick={() => handleDeleteExpense(exp.id)} className="text-red-400 hover:text-red-600">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      ))
                    }
                  </div>
                  <div className="flex gap-2">
                    <select className="w-32 px-2 py-1.5 border border-slate-300 rounded-lg text-xs text-slate-900"
                      value={newExpense.expense_type} onChange={e => setNewExpense(f => ({ ...f, expense_type: e.target.value }))}>
                      {EXPENSE_TYPES.map(t => <option key={t}>{t}</option>)}
                    </select>
                    <input type="number" placeholder="S/" min="0" step="0.01"
                      className="w-20 px-2 py-1.5 border border-slate-300 rounded-lg text-xs text-slate-900"
                      value={newExpense.amount || ""} onChange={e => setNewExpense(f => ({ ...f, amount: Number(e.target.value) }))} />
                    <input placeholder="Descripcion" className="flex-1 px-2 py-1.5 border border-slate-300 rounded-lg text-xs text-slate-900"
                      value={newExpense.description} onChange={e => setNewExpense(f => ({ ...f, description: e.target.value }))} />
                    <button onClick={handleAddExpense} className="px-2 py-1.5 bg-[#002855] text-white rounded-lg hover:bg-[#001d3d] transition-colors">
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>

              {/* Derecha: Resumen */}
              <div>
                <h3 className="font-bold text-slate-800 mb-4 flex items-center gap-2">
                  <DollarSign className="w-4 h-4 text-green-600" /> Resumen de Valorizacion
                </h3>
                <div className="bg-slate-50 rounded-xl border border-slate-200 p-4 space-y-2 text-sm mb-4">
                  <div className="flex justify-between">
                    <span className="text-slate-500">{selectedOT.estimated_distance_km} KM x S/ {effectiveCostPerKm().toFixed(2)}/km</span>
                    <span className="font-semibold">S/ {(effectiveCostPerKm() * selectedOT.estimated_distance_km).toFixed(2)}</span>
                  </div>
                  {getAutoRate() && !liqForm.override_rate && (
                    <div className="flex justify-between">
                      <span className="text-slate-500">Peaje base estimado</span>
                      <span className="font-semibold">S/ {getAutoRate()!.tolls_estimated_cost.toFixed(2)}</span>
                    </div>
                  )}
                  {totalExpenses() > 0 && (
                    <div className="flex justify-between">
                      <span className="text-slate-500">Gastos variables</span>
                      <span className="font-semibold">S/ {totalExpenses().toFixed(2)}</span>
                    </div>
                  )}
                  <div className="border-t border-slate-200 pt-2 flex justify-between font-bold">
                    <span>Costo Total del Viaje</span>
                    <span>S/ {dispatchTotalCost().toFixed(2)}</span>
                  </div>
                  {selectedOT.ots_in_dispatch > 1 && (
                    <div className="flex justify-between text-xs text-slate-500 bg-blue-50 rounded p-2">
                      <span>div {selectedOT.ots_in_dispatch} OTs (prorrateo igual)</span>
                      <span className="font-semibold">= S/ {otCost().toFixed(2)} por OT</span>
                    </div>
                  )}
                </div>

                <div className={`rounded-xl border-2 p-4 space-y-3 ${otBalance() < 0 ? "border-red-300 bg-red-50" : "border-green-200 bg-green-50"}`}>
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-semibold text-slate-600">Partida Asignada</span>
                    <span className="text-lg font-bold text-slate-700">S/ {liqForm.budget_amount.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-semibold text-slate-600">Costo de esta OT</span>
                    <span className="text-lg font-bold text-[#002855]">S/ {otCost().toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between items-center border-t border-white/50 pt-2">
                    <span className="font-bold text-slate-700 flex items-center gap-2">
                      {otBalance() < 0 ? <TrendingDown className="w-5 h-5 text-red-500" /> : <TrendingUp className="w-5 h-5 text-green-500" />}
                      Saldo Restante
                    </span>
                    <span className={`text-2xl font-black ${otBalance() < 0 ? "text-red-600" : "text-green-600"}`}>
                      S/ {otBalance().toFixed(2)}
                    </span>
                  </div>
                  {otBalance() < 0 && (
                    <div className="flex items-center gap-2 text-red-600 text-xs font-semibold">
                      <AlertTriangle className="w-4 h-4" /> ATENCION: Esta OT supera la partida asignada
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2 border-t border-slate-100">
              <button onClick={() => setSelectedOT(null)}
                className="px-5 py-2 bg-slate-100 text-slate-700 rounded-lg font-medium hover:bg-slate-200 transition-colors">
                Cancelar
              </button>
              <button onClick={handleSaveLiquidation} disabled={saving}
                className="px-6 py-2 bg-[#002855] text-white rounded-lg font-bold hover:bg-[#001d3d] transition-colors flex items-center gap-2 shadow-md disabled:opacity-50">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Guardar Valorizacion
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
