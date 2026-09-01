"use client"
import { useState, useEffect, useCallback } from 'react'
import { 
  Truck, ArrowDownToLine, Calendar, RefreshCw, Loader2,
  Package, Users, CheckCircle2, Clock, TrendingUp, MapPin,
  Filter, ChevronDown, RotateCcw, Receipt, FileDown
} from 'lucide-react'
import * as XLSX from 'xlsx'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface DispatchRow {
  id: string
  dispatch_number: string
  driver_name: string
  vehicle_plate: string
  scheduled_departure: string
  status: string
  estimated_distance_km: number
  freight_cost?: number      // from freight_rates lookup
  freight_zone?: string
  destinations: string[]     // extracted from requests
  request_types: string[]    // DESPACHO or RECOJO
  total_weight_tn: number
  request_count: number
  dispatch_requests?: any[]
}

// ─── STATUS CONFIG ─────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string; dot: string }> = {
  PROGRAMADO:            { label: 'Programado',    bg: 'bg-slate-100',  text: 'text-slate-700',  dot: 'bg-slate-400'  },
  EN_CURSO:              { label: 'En Curso',      bg: 'bg-blue-100',   text: 'text-blue-800',   dot: 'bg-blue-500'   },
  'EN RUTA':             { label: 'En Ruta',       bg: 'bg-blue-100',   text: 'text-blue-800',   dot: 'bg-blue-500'   },
  RETORNO:               { label: 'Retorno',       bg: 'bg-violet-100', text: 'text-violet-800', dot: 'bg-violet-500' },
  ESPERANDO_AUTORIZACION:{ label: 'Auth. Retorno', bg: 'bg-amber-100',  text: 'text-amber-800',  dot: 'bg-amber-500'  },
  LIQUIDADO:             { label: 'Liquidado',     bg: 'bg-green-100',  text: 'text-green-800',  dot: 'bg-green-500'  },
}

// Normalise district extracted from delivery_address for freight_rates lookup
function extractDistrict(address: string): string {
  if (!address) return ''
  // Known districts list — sorted longest first to avoid partial matches
  const DISTRICTS = [
    'San Juan de Lurigancho','San Juan de Miraflores','San Martin de Porres',
    'Villa el Salvador','Lima Cercado','Jesús María','Jesus Maria',
    'El Agustino','Punta Hermosa','Punta Negra','Puente Piedra',
    'Carabayllo','Lurigancho','Pachacamac','Chorrillos','Independencia',
    'Los Olivos','La Victoria','San Isidro','Santa Anita','Miraflores',
    'Surquillo','Ventanilla','Jicamarca','Huachipa','Barranco','Callao',
    'Chincha','Cañete','Canete','Comas','Huaral','Lurin','San Luis',
    'Ate','Ica','Pisco','Pucusana','Surco','Breña','Brena',
  ]
  const addressUpper = address.toUpperCase()
  for (const d of DISTRICTS) {
    if (addressUpper.includes(d.toUpperCase())) return d
  }
  // Fallback: last segment split by comma
  const parts = address.split(',')
  return parts[parts.length - 1].trim()
}

export default function ReportesPage() {
  const supabase = createClient()

  const [activeTab, setActiveTab] = useState<'despachos' | 'recojos'>('despachos')
  const [loading, setLoading] = useState(true)
  const [dispatches, setDispatches] = useState<DispatchRow[]>([])
  const [freightRates, setFreightRates] = useState<any[]>([])

  // Filters
  const todayStr = new Date().toISOString().split('T')[0]
  const [filterDate, setFilterDate] = useState(todayStr)
  const [filterStatus, setFilterStatus] = useState('TODOS')

  // ── KPI totals ──
  const despachos = dispatches.filter(d => d.request_types.some(t => t !== 'RECOJO'))
  const recojos   = dispatches.filter(d => d.request_types.every(t => t === 'RECOJO'))
  const enRuta    = dispatches.filter(d => ['EN_CURSO','EN RUTA'].includes(d.status))
  const totalFlete = dispatches.reduce((s, d) => s + (d.freight_cost || 0), 0)
  const totalTn   = dispatches.reduce((s, d) => s + d.total_weight_tn, 0)

  // ── Lookup freight rate ──
  const lookupFreight = useCallback((plate: string, addresses: string[], rates: any[]) => {
    for (const addr of addresses) {
      const district = extractDistrict(addr)
      const match = rates.find(r =>
        r.plate_number === plate &&
        r.district.toLowerCase() === district.toLowerCase()
      )
      if (match) return { cost: match.rate as number, zone: match.zone as string }
    }
    return { cost: 0, zone: '' }
  }, [])

  // ── Fetch data ──
  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      // Build date range filter (full day)
      const dateStart = `${filterDate}T00:00:00`
      const dateEnd   = `${filterDate}T23:59:59`

      const statusFilter = filterStatus === 'TODOS'
        ? ['PROGRAMADO','EN_CURSO','EN RUTA','RETORNO','ESPERANDO_AUTORIZACION','LIQUIDADO']
        : [filterStatus]

      const [dispatchRes, ratesRes] = await Promise.all([
        supabase
          .from('dispatches')
          .select(`
            id, dispatch_number, driver_name, vehicle_plate,
            scheduled_departure, status, estimated_distance_km,
            dispatch_requests (
              transport_request_id, status, document_type, document_number,
              transport_requests (
                id, request_number, request_type,
                pickup_address, delivery_address,
                transport_request_items ( weight, quantity, volume_m3 )
              )
            )
          `)
          .gte('scheduled_departure', dateStart)
          .lte('scheduled_departure', dateEnd)
          .in('status', statusFilter)
          .order('scheduled_departure', { ascending: true }),
        supabase.from('freight_rates').select('plate_number, district, zone, rate, vehicle_type')
      ])

      if (dispatchRes.error) throw dispatchRes.error
      const rates = ratesRes.data || []
      setFreightRates(rates)

      // Transform rows
      const rows: DispatchRow[] = (dispatchRes.data || []).map((d: any) => {
        const requests = (d.dispatch_requests || []).map((dr: any) => dr.transport_requests).filter(Boolean)
        const destinations = requests.map((r: any) => r.delivery_address || '').filter(Boolean)
        const request_types = requests.map((r: any) => r.request_type || 'DESPACHO')

        const total_weight_tn = requests.reduce((sum: number, r: any) => {
          const items = r.transport_request_items || []
          const w = items.reduce((s: number, i: any) => s + (i.weight || 0), 0)
          return sum + w / 1000
        }, 0)

        const { cost, zone } = lookupFreight(d.vehicle_plate, destinations, rates)

        return {
          id: d.id,
          dispatch_number: d.dispatch_number,
          driver_name: d.driver_name,
          vehicle_plate: d.vehicle_plate,
          scheduled_departure: d.scheduled_departure,
          status: d.status,
          estimated_distance_km: d.estimated_distance_km || 0,
          freight_cost: cost,
          freight_zone: zone,
          destinations,
          request_types,
          total_weight_tn: parseFloat(total_weight_tn.toFixed(3)),
          request_count: requests.length,
          dispatch_requests: d.dispatch_requests
        }
      })

      setDispatches(rows)
    } catch (err: any) {
      toast.error('Error al cargar reporte: ' + err.message)
    } finally {
      setLoading(false)
    }
  }, [filterDate, filterStatus, supabase, lookupFreight])

  useEffect(() => { fetchData() }, [fetchData])

  // ── Export to Excel ──
  const handleExport = () => {
    const rows = activeTab === 'despachos' ? despachos : recojos
    const data = rows.map(d => ({
      'Nº Despacho': d.dispatch_number,
      'Fecha/Hora': d.scheduled_departure ? new Date(d.scheduled_departure).toLocaleString('es-PE') : '',
      'Placa': d.vehicle_plate,
      'Conductor': d.driver_name,
      'Destinos': d.destinations.join(' | '),
      'Zona': d.freight_zone || '',
      'Carga (Tn)': d.total_weight_tn,
      'KM Est.': d.estimated_distance_km,
      'Costo Flete (S/)': d.freight_cost || 0,
      'Estado': STATUS_CONFIG[d.status]?.label || d.status,
    }))

    // Summary row
    data.push({} as any)
    data.push({
      'Nº Despacho': 'TOTALES',
      'Fecha/Hora': '',
      'Placa': '',
      'Conductor': `${rows.length} unidades`,
      'Destinos': '',
      'Zona': '',
      'Carga (Tn)': parseFloat(rows.reduce((s, d) => s + d.total_weight_tn, 0).toFixed(3)),
      'KM Est.': rows.reduce((s, d) => s + d.estimated_distance_km, 0),
      'Costo Flete (S/)': rows.reduce((s, d) => s + (d.freight_cost || 0), 0),
      'Estado': '',
    })

    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, activeTab === 'despachos' ? 'Despachos' : 'Recojos')
    XLSX.writeFile(wb, `Reporte_${activeTab}_${filterDate}.xlsx`)
    toast.success('Excel exportado correctamente')
  }

  const displayRows = activeTab === 'despachos' ? despachos : recojos

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-black text-slate-800">Reporte de Despacho y Recojo</h1>
          <p className="text-sm text-slate-500 mt-0.5">Planificación consolidada de rutas del día</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchData}
            className="flex items-center gap-1.5 px-3 py-2 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 text-sm font-medium transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Actualizar
          </button>
          <button
            onClick={handleExport}
            className="flex items-center gap-1.5 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-bold shadow-sm transition-colors"
          >
            <FileDown className="w-4 h-4" />
            Exportar Excel
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {[
          { label: 'Total Despachos', value: despachos.length, icon: Truck,       color: 'bg-blue-50 text-blue-600',    border: 'border-blue-100' },
          { label: 'Total Recojos',   value: recojos.length,   icon: RotateCcw,   color: 'bg-violet-50 text-violet-600',border: 'border-violet-100' },
          { label: 'En Ruta Ahora',   value: enRuta.length,    icon: MapPin,      color: 'bg-orange-50 text-orange-600',border: 'border-orange-100' },
          { label: 'Costo Flete',     value: `S/ ${totalFlete.toLocaleString('es-PE',{minimumFractionDigits:0})}`, icon: Receipt, color: 'bg-emerald-50 text-emerald-600', border: 'border-emerald-100' },
          { label: 'Toneladas',       value: `${totalTn.toFixed(1)} Tn`, icon: Package, color: 'bg-slate-100 text-slate-700', border: 'border-slate-200' },
        ].map(({ label, value, icon: Icon, color, border }) => (
          <div key={label} className={`bg-white rounded-2xl border ${border} p-4 flex items-center gap-3 shadow-sm`}>
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${color}`}>
              <Icon className="w-5 h-5" />
            </div>
            <div>
              <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{label}</p>
              <p className="text-xl font-black text-slate-800">{value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1.5">Fecha</label>
          <input
            type="date"
            value={filterDate}
            onChange={e => setFilterDate(e.target.value)}
            className="px-3 py-2.5 border-2 border-slate-200 rounded-xl text-sm font-medium text-slate-800 focus:border-[#002855] outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1.5">Estado</label>
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            className="px-3 py-2.5 border-2 border-slate-200 rounded-xl text-sm font-medium text-slate-800 focus:border-[#002855] outline-none bg-white"
          >
            <option value="TODOS">Todos los estados</option>
            <option value="PROGRAMADO">Programado</option>
            <option value="EN_CURSO">En Curso</option>
            <option value="RETORNO">En Retorno</option>
            <option value="ESPERANDO_AUTORIZACION">Esperando Autorización</option>
            <option value="LIQUIDADO">Liquidado</option>
          </select>
        </div>
        <button
          onClick={fetchData}
          className="px-4 py-2.5 bg-[#002855] text-white rounded-xl text-sm font-bold flex items-center gap-1.5 hover:bg-[#001f44] transition-colors"
        >
          <Filter className="w-4 h-4" />
          Filtrar
        </button>
      </div>

      {/* Tabs */}
      <div className="flex bg-white border border-slate-200 rounded-2xl p-1 shadow-sm gap-1 w-fit">
        {(['despachos', 'recojos'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-6 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 transition-all ${
              activeTab === tab
                ? 'bg-[#002855] text-white shadow-md'
                : 'text-slate-500 hover:bg-slate-50'
            }`}
          >
            {tab === 'despachos' ? <Truck className="w-4 h-4" /> : <RotateCcw className="w-4 h-4" />}
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
            <span className={`text-xs px-2 py-0.5 rounded-full font-black ${
              activeTab === tab ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-600'
            }`}>
              {tab === 'despachos' ? despachos.length : recojos.length}
            </span>
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-8 h-8 animate-spin text-[#002855] mr-3" />
            <span className="text-slate-500 font-medium">Cargando reporte...</span>
          </div>
        ) : displayRows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center mb-4">
              <Truck className="w-8 h-8 text-slate-400" />
            </div>
            <h3 className="font-bold text-slate-700 mb-1">Sin registros para esta fecha</h3>
            <p className="text-sm text-slate-400">Cambia el filtro de fecha o estado</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wider whitespace-nowrap">Nº Despacho</th>
                  <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wider whitespace-nowrap">Hora Salida</th>
                  <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wider whitespace-nowrap">Placa</th>
                  <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wider whitespace-nowrap">Conductor</th>
                  <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wider">Destinos</th>
                  <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wider whitespace-nowrap">Zona</th>
                  <th className="text-right px-4 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wider whitespace-nowrap">Carga (Tn)</th>
                  <th className="text-right px-4 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wider whitespace-nowrap">KM Est.</th>
                  <th className="text-right px-4 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wider whitespace-nowrap">Flete (S/)</th>
                  <th className="text-center px-4 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wider whitespace-nowrap">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {displayRows.map(row => {
                  const sc = STATUS_CONFIG[row.status] || { label: row.status, bg: 'bg-slate-100', text: 'text-slate-700', dot: 'bg-slate-400' }
                  const hasRate = (row.freight_cost || 0) > 0
                  return (
                    <tr key={row.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3">
                        <span className="font-black text-[#002855]">{row.dispatch_number}</span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="flex items-center gap-1.5 text-slate-700">
                          <Clock className="w-3.5 h-3.5 text-slate-400" />
                          {row.scheduled_departure
                            ? new Date(row.scheduled_departure).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })
                            : '—'}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-bold text-slate-800 bg-slate-100 px-2 py-0.5 rounded-lg">{row.vehicle_plate}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <Users className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          <span className="text-slate-700 truncate max-w-[140px]">{row.driver_name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 max-w-[200px]">
                        {row.destinations.length === 0 ? (
                          <span className="text-slate-400 text-xs">—</span>
                        ) : (
                          <div className="space-y-0.5">
                            {row.destinations.slice(0, 2).map((d, i) => (
                              <div key={i} className="flex items-center gap-1 text-xs text-slate-600">
                                <MapPin className="w-3 h-3 text-red-400 shrink-0" />
                                <span className="truncate">{d}</span>
                              </div>
                            ))}
                            {row.destinations.length > 2 && (
                              <span className="text-xs text-slate-400">+{row.destinations.length - 2} más</span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {row.freight_zone ? (
                          <span className="text-xs font-semibold text-slate-600 bg-blue-50 px-2 py-0.5 rounded-full border border-blue-100">{row.freight_zone}</span>
                        ) : (
                          <span className="text-slate-400 text-xs">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="font-bold text-slate-800">{row.total_weight_tn > 0 ? row.total_weight_tn.toFixed(2) : '—'}</span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="text-slate-600">{row.estimated_distance_km > 0 ? row.estimated_distance_km : '—'}</span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {hasRate ? (
                          <span className="font-black text-emerald-700">S/ {(row.freight_cost || 0).toLocaleString('es-PE')}</span>
                        ) : (
                          <span className="text-slate-400 text-xs">Sin tarifa</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold ${sc.bg} ${sc.text}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${sc.dot}`} />
                          {sc.label}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              {/* Totals footer */}
              <tfoot>
                <tr className="bg-[#002855]/5 border-t-2 border-[#002855]/20">
                  <td colSpan={6} className="px-4 py-3">
                    <span className="font-black text-[#002855] text-sm">{displayRows.length} REGISTROS</span>
                  </td>
                  <td className="px-4 py-3 text-right font-black text-slate-800">
                    {displayRows.reduce((s, d) => s + d.total_weight_tn, 0).toFixed(2)} Tn
                  </td>
                  <td className="px-4 py-3 text-right font-black text-slate-800">
                    {displayRows.reduce((s, d) => s + d.estimated_distance_km, 0).toFixed(0)} KM
                  </td>
                  <td className="px-4 py-3 text-right font-black text-emerald-700">
                    S/ {displayRows.reduce((s, d) => s + (d.freight_cost || 0), 0).toLocaleString('es-PE')}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
