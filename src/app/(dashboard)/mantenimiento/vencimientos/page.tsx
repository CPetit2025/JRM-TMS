"use client"
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { AlertTriangle, ShieldCheck, Clock, Search, Wrench, ArrowRight } from 'lucide-react'
import { toast } from 'sonner'
import Link from 'next/link'

type ExpirationRecord = {
  vehicle_plate: string
  vehicle_type: string
  current_km: number
  plan_id: string
  plan_name: string
  frequency_km: number
  due_km: number
  remaining_km: number
  status: 'VENCIDO' | 'ALERTA' | 'AL_DIA'
}

export default function VencimientosPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [records, setRecords] = useState<ExpirationRecord[]>([])
  const [searchTerm, setSearchTerm] = useState('')

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    setLoading(true)
    try {
      // 1. Fetch active vehicles
      const { data: vehiclesData, error: vError } = await supabase
        .from('vehicles')
        .select('*')
        .eq('is_active', true)
      if (vError) throw vError

      // 2. Fetch active maintenance plans
      const { data: plansData, error: pError } = await supabase
        .from('maintenance_plans')
        .select('*')
        .eq('is_active', true)
      if (pError) throw pError

      // 3. Fetch maintenance history (to find last maintenance for a given plan and vehicle)
      const { data: historyData, error: hError } = await supabase
        .from('vehicle_maintenance_history')
        .select('*')
        .order('created_at', { ascending: false })
      if (hError) throw hError

      const generatedRecords: ExpirationRecord[] = []

      for (const vehicle of vehiclesData || []) {
        // Find plans that apply to this vehicle type
        const applicablePlans = (plansData || []).filter(
          p => p.vehicle_type === 'TODOS' || p.vehicle_type === vehicle.type
        )

        for (const plan of applicablePlans) {
          // Find the last execution of this plan for this vehicle
          const lastHistory = (historyData || []).find(
            h => h.vehicle_plate === vehicle.plate && h.maintenance_plan_id === plan.id
          )

          let last_km = 0
          if (lastHistory && lastHistory.mileage_at_maintenance) {
            last_km = lastHistory.mileage_at_maintenance
          } else {
            // If no history, assume the last maintenance was at the nearest lower multiple of the frequency
            if (plan.frequency_km > 0) {
              last_km = Math.floor(vehicle.current_mileage / plan.frequency_km) * plan.frequency_km
            } else {
              last_km = vehicle.current_mileage
            }
          }

          const due_km = last_km + plan.frequency_km
          const remaining_km = due_km - vehicle.current_mileage
          
          let status: 'VENCIDO' | 'ALERTA' | 'AL_DIA' = 'AL_DIA'
          if (remaining_km <= 0) {
            status = 'VENCIDO'
          } else if (remaining_km <= 1000) { // Alerta a los 1000 KM
            status = 'ALERTA'
          }

          generatedRecords.push({
            vehicle_plate: vehicle.plate,
            vehicle_type: vehicle.type,
            current_km: vehicle.current_mileage || 0,
            plan_id: plan.id,
            plan_name: plan.name,
            frequency_km: plan.frequency_km,
            due_km,
            remaining_km,
            status
          })
        }
      }

      // Sort by status (VENCIDO first, then ALERTA, then AL_DIA) and then by remaining_km ascending
      const statusWeight = { 'VENCIDO': 1, 'ALERTA': 2, 'AL_DIA': 3 }
      generatedRecords.sort((a, b) => {
        if (statusWeight[a.status] !== statusWeight[b.status]) {
          return statusWeight[a.status] - statusWeight[b.status]
        }
        return a.remaining_km - b.remaining_km
      })

      setRecords(generatedRecords)

    } catch (err: any) {
      toast.error('Error al calcular vencimientos: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const filteredRecords = records.filter(r => 
    r.vehicle_plate.toLowerCase().includes(searchTerm.toLowerCase()) ||
    r.plan_name.toLowerCase().includes(searchTerm.toLowerCase())
  )

  const countVencidos = records.filter(r => r.status === 'VENCIDO').length
  const countAlerta = records.filter(r => r.status === 'ALERTA').length

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Proyección de Vencimientos</h1>
          <p className="text-slate-500">Cruza el KM actual de la flota con los planes de mantenimiento para prevenir fallas.</p>
        </div>
      </div>

      {/* Resumen KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        <div className="bg-red-50 border border-red-200 p-6 rounded-xl flex items-center gap-4">
          <div className="bg-red-100 p-3 rounded-full text-red-600">
            <AlertTriangle className="w-8 h-8" />
          </div>
          <div>
            <p className="text-sm font-semibold text-red-800">Planes Vencidos</p>
            <h3 className="text-3xl font-black text-red-600">{countVencidos}</h3>
          </div>
        </div>
        
        <div className="bg-yellow-50 border border-yellow-200 p-6 rounded-xl flex items-center gap-4">
          <div className="bg-yellow-100 p-3 rounded-full text-yellow-600">
            <Clock className="w-8 h-8" />
          </div>
          <div>
            <p className="text-sm font-semibold text-yellow-800">Por Vencer (&lt; 1,000 KM)</p>
            <h3 className="text-3xl font-black text-yellow-600">{countAlerta}</h3>
          </div>
        </div>

        <div className="bg-green-50 border border-green-200 p-6 rounded-xl flex items-center gap-4">
          <div className="bg-green-100 p-3 rounded-full text-green-600">
            <ShieldCheck className="w-8 h-8" />
          </div>
          <div>
            <p className="text-sm font-semibold text-green-800">Flota al Día</p>
            <h3 className="text-3xl font-black text-green-600">{records.length - countVencidos - countAlerta}</h3>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        <div className="p-4 border-b border-slate-200 flex gap-4 bg-slate-50/50 rounded-t-xl">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input 
              type="text"
              placeholder="Buscar por placa o plan..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-4 py-2 rounded-lg border-slate-300 text-sm focus:ring-[#002855]"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200">
              <tr>
                <th className="px-6 py-3">Unidad</th>
                <th className="px-6 py-3">Plan Preventivo</th>
                <th className="px-6 py-3">KM Actual</th>
                <th className="px-6 py-3">KM Vencimiento</th>
                <th className="px-6 py-3">Restante</th>
                <th className="px-6 py-3">Estado</th>
                <th className="px-6 py-3 text-right">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-6 py-8 text-center text-slate-500">
                    Calculando proyecciones de flota...
                  </td>
                </tr>
              ) : filteredRecords.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-8 text-center text-slate-500">
                    No se encontraron proyecciones
                  </td>
                </tr>
              ) : (
                filteredRecords.map((r, idx) => (
                  <tr key={`${r.vehicle_plate}-${r.plan_id}-${idx}`} className="hover:bg-slate-50">
                    <td className="px-6 py-4">
                      <div className="font-bold text-[#002855]">{r.vehicle_plate}</div>
                      <div className="text-xs text-slate-500">{r.vehicle_type}</div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="font-semibold text-slate-800">{r.plan_name}</div>
                      <div className="text-xs text-slate-500">Cada {r.frequency_km.toLocaleString()} KM</div>
                    </td>
                    <td className="px-6 py-4 font-mono text-slate-600">
                      {r.current_km.toLocaleString()}
                    </td>
                    <td className="px-6 py-4 font-mono font-medium text-slate-800">
                      {r.due_km.toLocaleString()}
                    </td>
                    <td className="px-6 py-4 font-mono font-bold">
                      {r.remaining_km <= 0 ? (
                        <span className="text-red-600">{r.remaining_km.toLocaleString()} KM</span>
                      ) : (
                        <span className="text-slate-700">Faltan {r.remaining_km.toLocaleString()} KM</span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      {r.status === 'VENCIDO' && (
                        <span className="bg-red-100 text-red-800 px-2 py-1 rounded text-xs font-bold border border-red-200">Vencido</span>
                      )}
                      {r.status === 'ALERTA' && (
                        <span className="bg-yellow-100 text-yellow-800 px-2 py-1 rounded text-xs font-bold border border-yellow-200">Por Vencer</span>
                      )}
                      {r.status === 'AL_DIA' && (
                        <span className="bg-green-100 text-green-800 px-2 py-1 rounded text-xs font-bold border border-green-200">Al Día</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right">
                      {(r.status === 'VENCIDO' || r.status === 'ALERTA') && (
                        <Link 
                          href={`/mantenimiento/ot?placa=${r.vehicle_plate}&plan=${r.plan_id}`}
                          className="inline-flex items-center gap-1 bg-[#002855] text-white px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-[#003566] transition-colors"
                        >
                          <Wrench className="w-3 h-3" /> Crear OT <ArrowRight className="w-3 h-3" />
                        </Link>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
