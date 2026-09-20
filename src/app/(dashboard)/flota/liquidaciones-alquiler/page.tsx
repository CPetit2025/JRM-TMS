'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Calculator, Search, Calendar, FileText, CheckCircle2, AlertCircle, Download, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import Link from 'next/link'

export default function LiquidacionAlquilerPage() {
  const [contracts, setContracts] = useState<any[]>([])
  const [selectedContractId, setSelectedContractId] = useState('')
  const [month, setMonth] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  })
  const [isLoading, setIsLoading] = useState(false)
  const [report, setReport] = useState<any>(null)

  const supabase = createClient()

  useEffect(() => {
    fetchContracts()
  }, [])

  const fetchContracts = async () => {
    try {
      const { data } = await supabase.from('vehicle_lease_contracts')
        .select('*, vehicles(plate), carriers(business_name)')
        .eq('status', 'ACTIVO')
      setContracts(data || [])
    } catch (e) {
      toast.error('Error al cargar contratos')
    }
  }

  const generateLiquidation = async () => {
    if (!selectedContractId || !month) return toast.error('Selecciona contrato y mes')
    
    setIsLoading(true)
    try {
      const contract = contracts.find(c => c.id === selectedContractId)
      if (!contract) throw new Error('Contrato no encontrado')

      // 1. Get start and end dates of the selected month
      const [y, m] = month.split('-')
      const startDate = new Date(Number(y), Number(m) - 1, 1).toISOString()
      const endDate = new Date(Number(y), Number(m), 0, 23, 59, 59).toISOString()

      // 2. Fetch dispatches for that vehicle in that month
      const { data: dispatches, error } = await supabase.from('dispatches')
        .select('*')
        .eq('vehicle_id', contract.vehicle_id)
        .gte('created_at', startDate)
        .lte('created_at', endDate)
        .order('created_at', { ascending: true })

      if (error) throw error

      // 3. Calculate total KM
      const totalKm = dispatches?.reduce((sum, d) => sum + Number(d.estimated_distance_km || 0), 0) || 0

      // 4. Calculate financials
      const baseFee = Number(contract.monthly_base_fee)
      const includedKm = Number(contract.included_km)
      const excessRate = Number(contract.excess_km_rate)
      const guaranteedKm = Number(contract.guaranteed_km)

      const excessKm = Math.max(0, totalKm - includedKm)
      const excessCost = excessKm * excessRate
      
      const subtotal = baseFee + excessCost
      const tax = subtotal * 0.18 // IGV 18%
      const total = subtotal + tax

      setReport({
        contract,
        month,
        dispatches: dispatches || [],
        summary: {
          totalKm,
          baseFee,
          includedKm,
          excessKm,
          excessCost,
          guaranteedKm,
          subtotal,
          tax,
          total
        }
      })

      toast.success('Liquidación generada con éxito')
    } catch (e: any) {
      toast.error('Error: ' + e.message)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="p-4 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <Calculator className="w-8 h-8 text-blue-600" />
            Liquidación de Alquiler en Seco
          </h1>
          <p className="text-slate-500">
            Genera el reporte mensual de KMs y pagos por vehículos subcontratados.
          </p>
        </div>
      </div>

      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-700">Contrato / Vehículo</label>
          <select 
            value={selectedContractId} 
            onChange={(e) => setSelectedContractId(e.target.value)}
            className="w-full px-3 py-2 border rounded-lg focus:ring-2 outline-none"
          >
            <option value="">Seleccione...</option>
            {contracts.map(c => (
              <option key={c.id} value={c.id}>
                {c.vehicles?.plate} - {c.carriers?.business_name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-700">Mes a Liquidar</label>
          <input 
            type="month" 
            value={month} 
            onChange={(e) => setMonth(e.target.value)}
            className="w-full px-3 py-2 border rounded-lg focus:ring-2 outline-none"
          />
        </div>
        <div className="md:col-span-2 flex justify-end">
          <button 
            onClick={generateLiquidation}
            disabled={isLoading}
            className="px-6 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2 disabled:opacity-50 w-full md:w-auto justify-center"
          >
            {isLoading ? 'Calculando...' : 'Generar Liquidación'}
          </button>
        </div>
      </div>

      {report && (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
          {/* Tarjetas de Resumen */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <p className="text-sm text-slate-500 font-medium">Kilometraje Total</p>
              <p className="text-3xl font-bold text-slate-800 mt-1">{report.summary.totalKm.toFixed(2)} <span className="text-lg text-slate-400">km</span></p>
              <div className="mt-2 text-xs text-slate-500 flex justify-between">
                <span>Incluido: {report.summary.includedKm}</span>
                <span className={report.summary.totalKm < report.summary.guaranteedKm ? 'text-amber-500 font-bold' : ''}>Garantía: {report.summary.guaranteedKm}</span>
              </div>
            </div>
            
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <p className="text-sm text-slate-500 font-medium">Exceso de KMs</p>
              <p className="text-3xl font-bold text-red-600 mt-1">{report.summary.excessKm.toFixed(2)} <span className="text-lg text-red-400 opacity-50">km</span></p>
              <div className="mt-2 text-xs text-slate-500">
                Tarifa x Exceso: S/ {report.summary.contract.excess_km_rate} / km
              </div>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <p className="text-sm text-slate-500 font-medium">Subtotal a Pagar</p>
              <p className="text-3xl font-bold text-blue-600 mt-1">S/ {report.summary.subtotal.toFixed(2)}</p>
              <div className="mt-2 text-xs text-slate-500 flex justify-between">
                <span>Base: S/ {report.summary.baseFee.toFixed(2)}</span>
                <span>Exceso: S/ {report.summary.excessCost.toFixed(2)}</span>
              </div>
            </div>

            <div className="bg-gradient-to-br from-blue-600 to-[#002855] p-4 rounded-xl shadow-lg shadow-blue-500/20 text-white">
              <p className="text-sm text-blue-200 font-medium">Total con IGV (18%)</p>
              <p className="text-3xl font-bold mt-1">S/ {report.summary.total.toFixed(2)}</p>
              <button className="mt-3 w-full py-2 bg-white/10 hover:bg-white/20 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2">
                <Download className="w-4 h-4" /> Exportar PDF
              </button>
            </div>
          </div>

          {/* Advertencias */}
          {report.summary.totalKm < report.summary.guaranteedKm && (
            <div className="bg-amber-50 border border-amber-200 p-4 rounded-xl flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
              <div>
                <h4 className="text-amber-800 font-medium">Alerta de Garantía</h4>
                <p className="text-sm text-amber-700 mt-1">
                  El kilometraje total del mes ({report.summary.totalKm.toFixed(2)} km) no supera la garantía mínima de {report.summary.guaranteedKm} km acordada en el contrato. 
                  El proveedor facturará la tarifa base completa independientemente.
                </p>
              </div>
            </div>
          )}

          {/* Detalle de Rutas */}
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
            <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
              <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                <Calendar className="w-5 h-5 text-slate-400" />
                Detalle de Rutas del Mes ({report.month})
              </h3>
              <span className="text-xs font-medium bg-blue-100 text-blue-700 px-2 py-1 rounded-full">
                {report.dispatches.length} Despachos
              </span>
            </div>
            <div className="overflow-x-auto max-h-[500px]">
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="bg-slate-50 text-slate-500 font-medium sticky top-0 shadow-sm">
                  <tr>
                    <th className="px-6 py-4">Fecha</th>
                    <th className="px-6 py-4">Despacho</th>
                    <th className="px-6 py-4">Conductor</th>
                    <th className="px-6 py-4">Origen / Destino</th>
                    <th className="px-6 py-4 text-right">KMs Recorridos</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {report.dispatches.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-6 py-8 text-center text-slate-500">No se encontraron despachos registrados en este mes.</td>
                    </tr>
                  ) : (
                    report.dispatches.map((d: any) => (
                      <tr key={d.id} className="hover:bg-slate-50/50">
                        <td className="px-6 py-3">{new Date(d.created_at).toLocaleDateString()}</td>
                        <td className="px-6 py-3">
                          <Link href={`/despacho/${d.id}`} className="text-blue-600 font-medium hover:underline flex items-center gap-1">
                            {d.dispatch_number}
                            <ExternalLink className="w-3 h-3" />
                          </Link>
                        </td>
                        <td className="px-6 py-3">{d.driver_name || '-'}</td>
                        <td className="px-6 py-3 text-slate-500">Según Plan de Ruta</td>
                        <td className="px-6 py-3 font-mono text-right font-medium text-slate-700">
                          {Number(d.estimated_distance_km || 0).toFixed(2)} km
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
