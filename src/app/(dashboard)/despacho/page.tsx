"use client"
import { allPages } from '@/lib/analytics/model'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { TransportWorkflow, TorreControlButton } from '@/components/transport/TransportWorkflow'
import { DataTable } from '@/components/ui/data-table'
import { PageHeader } from '@/components/ui/page-header'
import { InlineStatusBar } from '@/components/ui/inline-status-bar'
import { FilterToolbar, FilterField, filterControl } from '@/components/ui/filter-toolbar'
import { districtOf } from '@/lib/address'
import { cellDateTime } from '@/lib/table-format'
import { partyName, referenceLabel, requiresSupplier } from '@/lib/suppliers'
import { LinkPartyModal } from '@/components/solicitudes/LinkPartyModal'
import { ServiceTypeBadge } from '@/components/ui/service-type-badge'
import { serviceKind, SERVICE_KINDS, type ServiceKind } from '@/lib/request-service'
import { DISPATCH_STATUS_GROUPS } from '@/lib/dispatch-status'
import { isTransportUnit, TRANSPORT_VEHICLE_TYPES } from '@/lib/fleet-filters'
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Truck, MapPin, Loader2, Plus, FileText, Search, Clock, Route, PackageCheck } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { usePermissions } from '@/hooks/usePermissions'
import { errorMessage } from '@/lib/caja'
import { serviceDate, wasRescheduled, withRescheduling } from '@/lib/request-schedule'
import { ReportarFallaButton } from '@/components/mantenimiento/ReportarFalla'
import { AddRouteService } from '@/components/despacho/AddRouteService'
import { OCCUPIED_DISPATCH_STATUSES } from '@/lib/route-assignment'
import { useRouteBuilder } from '@/components/despacho/programar-ruta/useRouteBuilder'
import { RouteBuilderModal } from '@/components/despacho/programar-ruta/RouteBuilderModal'
import type { Dispatch, PlanningDriver, PlanningVehicle, TransportRequest } from '@/components/despacho/programar-ruta/types'

// Orden de la bandeja: la solicitud registrada más recientemente primero; a igual registro, la atención más reciente.
// Fecha de atención: hora exacta si existe; si no, el día en Lima. Sin fecha va al final.
function attentionTime(request: { required_at?: string | null; required_date?: string | null }) {
  const t = request.required_at ? Date.parse(request.required_at) : request.required_date ? Date.parse(`${request.required_date.slice(0, 10)}T00:00:00-05:00`) : NaN
  return Number.isFinite(t) ? t : -Infinity
}
const newestFirst = <T extends { required_at?: string | null; required_date?: string | null; created_at?: string | null }>(rows: T[]) =>
  [...rows].sort((a, b) => (Date.parse(b.created_at || '') || 0) - (Date.parse(a.created_at || '') || 0) || attentionTime(b) - attentionTime(a))

const STATUS_GROUPS = { ruta: DISPATCH_STATUS_GROUPS.RUTA as readonly string[], cerrar: DISPATCH_STATUS_GROUPS.POR_CERRAR as readonly string[] }

export default function DespachoPage() {
  const router = useRouter()
  const { canWrite, role } = usePermissions()
  const canAddService = canWrite('despacho') && ['admin', 'supervisor de transporte'].includes(role)
  const supabase = useMemo(() => createClient(), [])
  const [pendingRequests, setPendingRequests] = useState<TransportRequest[]>([])
  const [linkRequest, setLinkRequest] = useState<TransportRequest | null>(null)
  const [dispatches, setDispatches] = useState<Dispatch[]>([])
  const [vehicles, setVehicles] = useState<PlanningVehicle[]>([])
  const [drivers, setDrivers] = useState<PlanningDriver[]>([])
  
  const alertedDispatches = useRef<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)

  const [pendingSearch, setPendingSearch] = useState('')
  const [pendingService, setPendingService] = useState('')
  const visiblePending = pendingRequests.filter(r => {
    const term = pendingSearch.trim().toLocaleLowerCase('es-PE')
    const matchSearch = !term || [r.request_number, r.requester_name, r.contracts?.code, r.contracts?.clients?.business_name, r.suppliers?.business_name, referenceLabel(r),
      districtOf(r.pickup_address, r.pickup_district), districtOf(r.delivery_address, r.delivery_district)].join(' ').toLocaleLowerCase('es-PE').includes(term)
    return matchSearch && (!pendingService || serviceKind(r) === pendingService)
  })


  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      // 1. Obtener Solicitudes pendientes de asignar
      // Por páginas: la API entrega como máximo 1.000 filas por consulta
      const reqData = await allPages<any>((o, n) => supabase
        .from('transport_requests')
        .select(`
          *,
          suppliers!transport_requests_supplier_id_fkey(business_name),
          request_client:clients!client_id(business_name),
          transport_request_items (
            weight,
            volume_m3,
            quantity
          ),
          contracts (
            id,
            code,
            clients (
              business_name
            ),
            contract_budgets (
              balance_pen,
              allocated_pen
            )
          )
        `)
        .in('status', ['APROBADA', 'REPROGRAMADA'])
        .order('created_at', { ascending: false }).order('id')
        .range(o, o + n - 1), 1000)

      const { data: history, error: historyError } = reqData?.length ? await supabase.rpc('get_transport_request_rescheduling', { p_request_ids: reqData.map(r => r.id) }) : { data: [], error: null }
      if (historyError) throw historyError
      setPendingRequests(newestFirst(withRescheduling(reqData || [], history || [])))

      // 2. Despachos asignados: solo para los contadores y el aviso de retorno (se gestionan en Torre de Control)
      const { data: dispatchData, error: dispatchError } = await supabase
        .from('dispatches')
        .select('id, dispatch_number, status, vehicle_plate, driver_id, driver_name, scheduled_departure')
        .in('status', [...OCCUPIED_DISPATCH_STATUSES])

      if (dispatchError) throw dispatchError
      if (!dispatchData) {
        // Set vacío para evitar null
        setDispatches([])
      } else {
        const fetchedDispatches = dispatchData as unknown as Dispatch[] || []
        setDispatches(fetchedDispatches)

        // Disparar alertas para los que ya están ESPERANDO_AUTORIZACION
        let shouldAlert = false
        fetchedDispatches.forEach(d => {
          if (d.status === 'ESPERANDO_AUTORIZACION' && !alertedDispatches.current.has(d.id)) {
            toast.error(`⚠️ ATENCIÓN: El despacho ${d.dispatch_number} espera autorización de retorno.`, { duration: 10000 })
            alertedDispatches.current.add(d.id)
            shouldAlert = true
          }
        })
        
        if (shouldAlert) {
          try {
            const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3')
            audio.play().catch(e => console.log('Auto-play prevent:', e))
          } catch(e) {}
        }
      }

      // 3. Obtener vehículos y conductores para el select
      const { data: vData } = await supabase.from('vehicles').select('plate, status, type, brand, model, assigned_driver_id, weight_capacity, volume_capacity, carriers(business_name)')
        .in('status', ['DISPONIBLE', 'ASIGNADA', 'EN_RUTA', 'EN_OPERACION']).eq('is_active', true).in('type', [...TRANSPORT_VEHICLE_TYPES])
      const { data: dData } = await supabase.from('drivers')
        .select('id, first_name, last_name, document_number, profile_id, carriers(business_name)')
        .eq('is_active', true).not('profile_id', 'is', null)
      
      setVehicles((vData || []).filter(vehicle => isTransportUnit(vehicle.type) && (vehicle.status === 'DISPONIBLE' || dispatchData?.some(route => route.vehicle_plate === vehicle.plate))).map(vehicle => ({ ...vehicle, carriers: Array.isArray(vehicle.carriers) ? vehicle.carriers[0] || null : vehicle.carriers })))
      setDrivers((dData || []).map(driver => ({ ...driver, carriers: Array.isArray(driver.carriers) ? driver.carriers[0] || null : driver.carriers })))

    } catch (error) {
      toast.error('Error al cargar datos de despacho: ' + errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [supabase])

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void fetchData(), 0)

    // Suscripción a cambios en tiempo real
    const channel = supabase.channel('dispatches_changes')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'dispatches'
        },
        (payload) => {
          if (payload.new.status === 'ESPERANDO_AUTORIZACION' && payload.old.status !== 'ESPERANDO_AUTORIZACION') {
            toast.error(`⚠️ ATENCIÓN: El despacho ${payload.new.dispatch_number} espera autorización de retorno.`, { duration: 10000 })
            // Intentar reproducir sonido
            try {
              const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3')
              audio.play().catch(e => console.log('Auto-play prevent:', e))
            } catch(e) {}
            fetchData()
          }
        }
      )
      .subscribe()

    return () => {
      window.clearTimeout(initialLoad)
      void supabase.removeChannel(channel)
    }
  }, [fetchData, supabase])

  // Armado de ruta («Armar ruta y programar unidad»): estado, reglas y programación en useRouteBuilder
  const rb = useRouteBuilder({ supabase, pendingRequests, setPendingRequests, dispatches, vehicles, drivers, fetchData, canAddService, canAuthorizeFreight: canWrite('despacho-aprobacion'), router, onLinkRequest: setLinkRequest })

  return (
    <div className="w-full mx-auto space-y-2.5">
      <PageHeader showTitle title="Programación de Despachos y Ruteo" description="Asignación de unidades de transporte a Solicitudes" actions={<>
        <ReportarFallaButton />
        {canWrite('despacho') && (
          <button 
            onClick={() => rb.setIsModalOpen(true)}
            className="flex min-h-10 items-center gap-2 rounded-lg bg-jrm-navy px-4 font-medium text-white shadow-sm transition-colors hover:bg-jrm-navy-dark"
          >
            <Plus className="w-4 h-4" />
            Armar Ruta
          </button>
        )}
        <TorreControlButton />
      </>} />
      <div className="flex flex-wrap items-center gap-2">
        <TransportWorkflow current="programacion" torre={false} />
        <div className="ml-auto min-w-0">
          <InlineStatusBar label="Resumen operativo: los despachos asignados se siguen en Torre de Control" loading={loading} active="asignar"
            onChange={key => { if (key !== 'asignar') router.push(`/torre-control?estado=${({ programados: 'PROGRAMADO', ruta: 'RUTA', cerrar: 'POR_CERRAR' } as Record<string, string>)[key]}`) }}
            items={[
              { key: 'asignar', label: 'Por asignar', count: pendingRequests.length, icon: <FileText />, tone: 'amber' },
              { key: 'programados', label: 'Programados', count: dispatches.filter(d => d.status === 'PROGRAMADO').length, icon: <Clock />, tone: 'navy' },
              { key: 'ruta', label: 'En ruta', count: dispatches.filter(d => STATUS_GROUPS.ruta.includes(d.status)).length, icon: <Route />, tone: 'blue' },
              { key: 'cerrar', label: 'Por cerrar', count: dispatches.filter(d => STATUS_GROUPS.cerrar.includes(d.status)).length, icon: <PackageCheck />, tone: 'emerald' }]} />
        </div>
      </div>

      <section aria-label="Solicitudes por asignar" className="min-w-0 space-y-2">
        <FilterToolbar compact label="Búsqueda y filtros de solicitudes por asignar" onClear={() => { setPendingSearch(''); setPendingService('') }}>
          <label className="relative min-w-0 flex-1 basis-60">
            <span className="sr-only">Buscar solicitudes</span><Search className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" aria-hidden="true" />
            <input type="search" placeholder="Buscar por OT, cliente, solicitud o distrito…" value={pendingSearch} onChange={e => setPendingSearch(e.target.value)} className={`${filterControl} pl-9`} />
          </label>
          <FilterField inline label="Servicio" className="w-60">
            <select className={filterControl} value={pendingService} onChange={e => setPendingService(e.target.value)}>
              <option value="">Todos</option>
              {(Object.keys(SERVICE_KINDS) as ServiceKind[]).map(kind => <option key={kind} value={kind}>{SERVICE_KINDS[kind].short}</option>)}
            </select>
          </FilterField>
        </FilterToolbar>

        <div className="overflow-hidden rounded-jrm border border-jrm-line bg-jrm-surface shadow-jrm-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-jrm-line px-3 py-2.5">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <FileText className="h-4 w-4 text-amber-600" aria-hidden="true" />
              Solicitudes por asignar <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">{visiblePending.length}</span>
            </h2>
            <p className="text-xs text-slate-500">Programados y en ruta: <Link href="/torre-control" className="font-semibold text-jrm-navy hover:underline">Torre de Control</Link> · Servicios realizados: <Link href="/contratos/servicios" className="font-semibold text-jrm-navy hover:underline">Registro de servicios</Link></p>
          </div>
          <div className="overflow-x-auto">
            <DataTable dense className="w-full border-collapse text-left">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  {['Registro', 'Atención', 'Servicio', 'OT / OC / OS / RQ', 'Empresa', 'Origen → Destino', 'Partida / costo', 'Acciones'].map((title, i) => <th key={title} className={`whitespace-nowrap font-semibold ${i === 7 ? 'text-right' : ''}`}>{title}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading ? (
                  <tr><td colSpan={8} className="p-8 text-center text-slate-500"><Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />Cargando solicitudes…</td></tr>
                ) : visiblePending.length === 0 ? (
                  <tr><td colSpan={8} className="p-8 text-center text-slate-500">{pendingRequests.length ? 'No hay solicitudes con estos filtros.' : 'No hay solicitudes pendientes de asignación.'}</td></tr>
                ) : visiblePending.map(req => {
                  const selected = rb.newDispatch.selected_requests.some(r => r.id === req.id)
                  const balance = req.contracts?.contract_budgets?.[0]?.balance_pen
                  return (
                    <tr key={req.id} className={selected ? 'bg-blue-50/50' : 'hover:bg-slate-50'}>
                      <td className="whitespace-nowrap text-sm text-slate-500" title="Fecha y hora en que se registró la solicitud">{req.created_at ? cellDateTime(req.created_at) : '—'}</td>
                      <td className="whitespace-nowrap">
                        <span className={`text-sm ${wasRescheduled(req) ? 'font-semibold text-orange-700' : 'text-slate-700'}`} title={wasRescheduled(req) ? 'Reprogramado' : undefined}>{req.required_at ? cellDateTime(req.required_at) : `${serviceDate(req.required_date).slice(0, 5)}${req.time_window ? ` ${req.time_window}` : ''}`}</span>
                      </td>
                      <td><ServiceTypeBadge request={req} /></td>
                      <td className="whitespace-nowrap text-sm font-bold text-jrm-navy" title={`Solicitud ${req.request_number} · ${req.requester_name}`}>{req.contracts?.code ? `OT ${req.contracts.code}` : referenceLabel(req) || 'Sin OT'}</td>
                      <td className="max-w-40">{(() => { const party = partyName(req, (req.request_client?.business_name || req.contracts?.clients?.business_name), req.suppliers?.business_name); return <p className="truncate text-sm text-slate-700" title={party ? `${requiresSupplier(req) ? 'Proveedor' : 'Cliente'}: ${party}` : undefined}>{party || <button type="button" onClick={e => { e.stopPropagation(); setLinkRequest(req) }} className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700 ring-1 ring-red-200 hover:bg-red-100" title="Sin esto no se puede programar">{requiresSupplier(req) ? 'Proveedor sin vincular' : 'Sin cliente'} · vincular</button>}</p> })()}</td>
                      <td className="max-w-48">
                        <p className="flex items-center gap-1 truncate text-sm text-slate-700" title={`Origen: ${req.pickup_address}\nDestino: ${req.delivery_address}`}>
                          <MapPin className="h-3.5 w-3.5 shrink-0 text-blue-500" aria-hidden="true" />
                          <span className="truncate">{districtOf(req.pickup_address, req.pickup_district)} → {districtOf(req.delivery_address, req.delivery_district)}</span>
                        </p>
                      </td>
                      <td className="whitespace-nowrap text-sm">
                        {req.contracts?.code && balance !== undefined && balance !== null
                          ? <span className={`font-semibold ${(balance || 0) < 500 ? 'text-red-700' : 'text-slate-700'}`}>S/ {(balance || 0).toLocaleString('es-PE')}</span>
                          : !req.contract_id && referenceLabel(req)
                            ? <span className="text-slate-700" title="Costo de la solicitud aprobada, sin consumo de partida OT">S/ {Number(req.service_cost || 0).toLocaleString('es-PE')}<span className="block text-[11px] font-normal text-slate-500">Costo aprobado</span></span>
                            : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="text-right">
                        {canWrite('despacho') && (
                          <button type="button" onClick={() => { rb.setIsModalOpen(true); if (!selected) void rb.toggleRequestSelection(req.id, req.pickup_address, req.delivery_address) }}
                            aria-label={`Asignar ${req.request_number}`}
                            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-jrm-navy px-3 text-xs font-semibold text-white hover:bg-jrm-navy-dark lg:min-h-8">
                            <Truck className="h-4 w-4" aria-hidden="true" />{selected ? 'En la ruta' : 'Asignar'}
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </DataTable>
          </div>
        </div>
      </section>

      <RouteBuilderModal rb={rb} onLink={setLinkRequest} />
      {linkRequest && <LinkPartyModal request={linkRequest} onClose={() => setLinkRequest(null)} onLinked={() => void fetchData()} />}
      <AddRouteService dispatchId={rb.addServiceId} initialRequestId={rb.newDispatch.selected_requests[0]?.id} onClose={() => { rb.setAddServiceId(null); rb.setIsModalOpen(true) }} onChanged={requestId => { rb.setNewDispatch(previous => ({ ...previous, selected_requests: previous.selected_requests.filter(request => request.id !== requestId) })); void fetchData() }} />
    </div>
  )
}
