"use client"
import { DataTable } from '@/components/ui/data-table'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { format } from 'date-fns'
import { EvidenceGallery } from '@/components/evidence/EvidenceGallery'
import { FeActivoCard } from '@/components/fleet/FeActivoCard'
import { MantHistorialPanel } from '@/components/fleet/MantHistorialPanel'
import { toast } from 'sonner'
import { ArrowLeft, Truck, ShieldCheck, ShieldAlert, AlertTriangle, Wrench, CalendarClock, ClipboardCheck, CircleDot, FileText, BarChart2, History, Gauge, Route, Image as ImageIcon, Loader2 } from 'lucide-react'

// Ficha Flota 360° (Fase 1): una sola llamada a get_fleet_360_view, que consolida todas las fuentes
// respetando RLS (migración 20260927140000).

type Row = Record<string, unknown>
interface Fleet360 {
  vehicle: Row
  eligibility: { status: string; motives: string[]; observations: string[]; checks: Record<string, boolean> }
  costs: Row | null
  open_requests: Row[]
  requests_history: Row[]
  work_orders: Row[]
  preventive: Row[]
  inspections: Row[]
  tires: Row[]
  documents: Row[]
  readings: Row[]
  dispatches: Row[]
  history: Row[]
  photos: string[]
  fines?: Row[]
  incidents?: Row[]
  compliance_costs?: Row | null
}

const TABS = [
  ['resumen', 'Resumen', Truck], ['fallas', 'Fallas', AlertTriangle], ['ot', 'OT', Wrench], ['preventivos', 'Preventivos', CalendarClock],
  ['inspecciones', 'Inspecciones', ClipboardCheck], ['neumaticos', 'Neumáticos', CircleDot], ['documentos', 'Documentos', FileText], ['cumplimiento', 'Multas y siniestros', ShieldAlert],
  ['costos', 'Costos', BarChart2], ['gasto', 'Gasto y plan', Gauge], ['operacion', 'Operación', Route], ['evidencias', 'Evidencias', ImageIcon], ['historial', 'Historial', History],
] as const

const money = (n: unknown) => `S/ ${Number(n || 0).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const date = (v: unknown, withTime = false) => v ? format(new Date(String(v)), withTime ? 'dd/MM/yyyy HH:mm' : 'dd/MM/yyyy') : '—'
const txt = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v))

export default function Flota360Page() {
  const params = useParams()
  const plate = decodeURIComponent(params.plate as string)
  const [data, setData] = useState<Fleet360 | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('resumen')

  const apply = useCallback(({ data: result, error }: { data: unknown; error: { message: string } | null }) => {
    if (error) toast.error('No se pudo cargar la ficha: ' + error.message)
    setData((result as Fleet360) || null)
    setLoading(false)
  }, [])

  useEffect(() => {
    createClient().rpc('get_fleet_360_view', { p_plate: plate }).then(apply)
  }, [plate, apply])

  if (loading) return <div className="p-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
  if (!data) return (
    <div className="p-6 space-y-3">
      <Link href="/mantenimiento/flota" className="text-sm text-blue-600 flex items-center gap-1"><ArrowLeft className="w-4 h-4" />Volver a Flota</Link>
      <p className="text-slate-600">No se encontró el activo {plate} o no tiene acceso a su sede.</p>
    </div>
  )

  const v = data.vehicle
  const el = data.eligibility
  const elStyle = el.status === 'APTO' ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
    : el.status === 'APTO_CON_OBSERVACION' ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-red-50 border-red-200 text-red-800'

  return (
    <div className="p-6 space-y-5">
      <Link href="/mantenimiento/flota" className="text-sm text-blue-600 flex items-center gap-1"><ArrowLeft className="w-4 h-4" />Volver a Flota</Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black text-[#002855]">{txt(v.plate)} {v.internal_code ? <span className="text-base font-medium text-slate-500">· {String(v.internal_code)}</span> : null}</h1>
          <p className="text-slate-600">{txt(v.type)} · {txt(v.brand)} {txt(v.model)} ({txt(v.year)}) · {txt(v.ownership_status)} · criticidad {txt(v.criticality)}</p>
        </div>
        <div className="flex gap-3">
          <Kpi icon={<Gauge className="w-4 h-4" />} label="Odómetro" value={`${Number(v.current_odometer || 0).toLocaleString('es-PE')} km`} />
          <Kpi icon={<Gauge className="w-4 h-4" />} label="Horómetro" value={`${Number(v.current_hours || 0).toLocaleString('es-PE')} h`} />
          <Kpi icon={<Truck className="w-4 h-4" />} label="Estado" value={String(v.status).replace(/_/g, ' ')} />
        </div>
      </div>

      <div className={`border rounded-xl p-4 ${elStyle}`}>
        <div className="flex items-center gap-2 font-semibold">
          {el.status === 'NO_APTO' ? <ShieldAlert className="w-5 h-5" /> : <ShieldCheck className="w-5 h-5" />}
          Elegibilidad: {el.status.replace(/_/g, ' ')}
          {v.is_blocked ? <span className="ml-2 text-xs px-2 py-0.5 rounded bg-red-600 text-white">Bloqueo administrativo</span> : null}
        </div>
        {el.motives?.length > 0 && <ul className="mt-2 text-sm list-disc ml-6">{el.motives.map(m => <li key={m}>{m}</li>)}</ul>}
        {el.observations?.length > 0 && <ul className="mt-1 text-sm list-disc ml-6 opacity-80">{el.observations.map(m => <li key={m}>{m}</li>)}</ul>}
      </div>

      <div className="flex flex-wrap gap-1 border-b">
        {TABS.map(([key, label, Icon]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-3 py-2 text-sm flex items-center gap-1 border-b-2 -mb-px ${tab === key ? 'border-[#002855] text-[#002855] font-semibold' : 'border-transparent text-slate-500'}`}>
            <Icon className="w-4 h-4" />{label}
          </button>
        ))}
      </div>

      {tab === 'resumen' && (
        <div className="grid md:grid-cols-3 gap-4">
          <Card title="Ficha técnica">
            <Dl items={[['Código interno', v.internal_code], ['Serie', v.serial_number], ['Tipo', v.type], ['Marca / modelo', `${txt(v.brand)} ${txt(v.model)}`],
              ['Año', v.year], ['Capacidad', v.weight_capacity ? `${v.weight_capacity} kg · ${txt(v.volume_capacity)} m³` : null], ['Transportista', v.carrier_name]]} />
          </Card>
          <Card title="Gestión">
            <Dl items={[['Propiedad', v.ownership_status], ['Criticidad', v.criticality], ['Responsable', v.responsible_name], ['Ubicación', v.current_location],
              ['SOAT', date(v.soat_expiration)], ['Revisión técnica', date(v.technical_review_expiration)]]} />
          </Card>
          <Card title="Situación">
            <Dl items={[['Fallas abiertas', data.open_requests.length], ['OT abiertas', data.work_orders.filter(w => !['CERRADA', 'CANCELADA'].includes(String(w.status))).length],
              ['Preventivos vencidos', data.preventive.filter(p => p.alert_status === 'VENCIDO').length], ['Documentos', data.documents.length],
              ['Costo mantenimiento', money(data.costs?.maintenance_cost)], ['TCO', money(data.costs?.total_tco)]]} />
          </Card>
          <div className="md:col-span-3"><FeActivoCard plate={plate} /></div>
        </div>
      )}

      {tab === 'fallas' && (
        <Table empty="Sin fallas registradas" rows={data.requests_history}
          cols={[['Fecha', r => date(r.reported_at, true)], ['Criticidad', r => txt(r.severity)], ['Estado', r => txt(r.status)], ['Origen', r => txt(r.source)], ['Descripción', r => txt(r.description)]]} />
      )}
      {tab === 'ot' && (
        <Table empty="Sin órdenes de trabajo" rows={data.work_orders}
          cols={[['OT', r => txt(r.ot_code)], ['Tipo', r => txt(r.order_type)], ['Estado', r => txt(r.status)], ['Indisp. (h)', r => r.downtime_hours != null ? Number(r.downtime_hours).toFixed(1) : '—'],
            ['Costo', r => money(r.total_cost)], ['Creada', r => date(r.created_at)]]} />
      )}
      {tab === 'preventivos' && (
        <Table empty="Sin planes preventivos" rows={data.preventive}
          cols={[['Plan', r => txt(r.plan_name)], ['Alerta', r => txt(r.alert_status)], ['Próx. km', r => txt(r.next_due_km)], ['Km restantes', r => txt(r.km_remaining)],
            ['Próx. fecha', r => date(r.next_due_date)], ['Días', r => txt(r.days_remaining)], ['Próx. horas', r => txt(r.next_due_hours)]]} />
      )}
      {tab === 'inspecciones' && (
        <Table empty="Sin inspecciones" rows={data.inspections}
          cols={[['Fecha', r => date(r.date, true)], ['Plantilla', r => txt(r.template_name)], ['Tipo', r => txt(r.template_type)], ['Resultado', r => txt(r.global_result)]]} />
      )}
      {tab === 'neumaticos' && (
        <Table empty="Sin neumáticos montados" rows={data.tires}
          cols={[['Código', r => txt(r.codigo_interno)], ['Posición', r => txt(r.posicion_actual)], ['Marca / medida', r => `${txt(r.marca)} ${txt(r.medida)}`],
            ['Cocada (mm)', r => `${txt(r.cocada_actual)} / ${txt(r.cocada_original)}`], ['Km', r => txt(r.total_km_travelled)], ['Estado', r => txt(r.estado)]]} />
      )}
      {tab === 'documentos' && (
        <Table empty="Sin documentos en el repositorio (se usan las fechas del maestro)" rows={data.documents}
          cols={[['Documento', r => txt(r.document_type)], ['Número', r => txt(r.document_number)], ['Vence', r => date(r.expiration_date)], ['Estado', r => txt(r.status)]]} />
      )}
      {tab === 'cumplimiento' && (
        <div className="space-y-4">
          <Table empty="Sin multas ni papeletas" rows={data.fines || []}
            cols={[['Fecha', r => date(r.infraction_date)], ['Entidad / N°', r => `${txt(r.entity)} · ${txt(r.ticket_number)}`], ['Conductor', r => txt(r.driver_name)],
              ['Importe', r => money(r.amount)], ['Responsable', r => txt(r.responsibility)], ['Estado', r => txt(r.status)]]} />
          <Table empty="Sin siniestros ni incidentes" rows={data.incidents || []}
            cols={[['Fecha', r => date(r.occurred_at)], ['Tipo', r => txt(r.incident_type)], ['Criticidad', r => txt(r.severity)], ['Descripción', r => txt(r.description)],
              ['Costo', r => money(r.final_cost ?? r.estimated_cost)], ['Seguro', r => money(r.insurance_coverage)], ['Estado', r => txt(r.status)]]} />
        </div>
      )}
      {tab === 'costos' && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Kpi label="Mantenimiento" value={money(data.costs?.maintenance_cost)} />
          <Kpi label="Operación (gastos de viaje)" value={money(data.costs?.operating_cost)} />
          <Kpi label="Combustible" value={money(data.costs?.fuel_cost)} />
          <Kpi label="Costo fijo estimado" value={money(data.costs?.fixed_cost)} />
          <Kpi label="TCO" value={money(data.costs?.total_tco)} />
          <Kpi label="Costo por km" value={data.costs?.cpk != null ? `S/ ${Number(data.costs.cpk).toFixed(3)}` : '—'} />
          <Kpi label="Mantenimiento por km" value={data.costs?.maintenance_cpk != null ? `S/ ${Number(data.costs.maintenance_cpk).toFixed(3)}` : '—'} />
          <Kpi label="Multas (empresa)" value={money(data.compliance_costs?.fines_company_cost)} />
          <Kpi label="Multas pendientes" value={money(data.compliance_costs?.fines_outstanding)} />
          <Kpi label="Siniestros (neto)" value={money(data.compliance_costs?.incidents_net_cost)} />
        </div>
      )}
      {tab === 'operacion' && (
        <div className="grid md:grid-cols-2 gap-4">
          <Table empty="Sin viajes" rows={data.dispatches}
            cols={[['Despacho', r => txt(r.dispatch_number)], ['Estado', r => txt(r.status)], ['Conductor', r => txt(r.driver_name)], ['Salida', r => date(r.scheduled_departure)]]} />
          <Table empty="Sin lecturas de odómetro" rows={data.readings}
            cols={[['Fecha', r => date(r.created_at, true)], ['Odómetro', r => txt(r.odometer_value)], ['Origen', r => txt(r.source_event)]]} />
        </div>
      )}
      {tab === 'evidencias' && (
        <div className="space-y-5">
          {/* Fotos del app del conductor (bucket privado): fallas, checklist, odómetro, gastos y anticipos de la unidad */}
          <EvidenceGallery plate={plate} title="Evidencias del app del conductor" />
          {data.photos.some(u => /^https?:\/\//.test(u)) && (
            <div>
              <h3 className="font-bold text-slate-800 mb-2">Otras evidencias (enlaces)</h3>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {data.photos.filter(u => /^https?:\/\//.test(u)).map(u => (
                  <a key={u} href={u} target="_blank" rel="noreferrer" className="block border rounded-lg overflow-hidden text-xs text-blue-600 p-2 break-all">{u.split('/').pop()}</a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {tab === 'gasto' && <MantHistorialPanel plate={plate} />}
      {tab === 'historial' && (
        <Table empty="Sin historial" rows={data.history}
          cols={[['Fecha', r => date(r.created_at, true)], ['Campo', r => txt(r.field_changed)], ['Antes', r => txt(r.old_value)], ['Después', r => txt(r.new_value)],
            ['Motivo', r => txt(r.change_reason)], ['Usuario', r => txt(r.changed_by_name)]]} />
      )}
    </div>
  )
}

function Kpi({ label, value, icon }: { label: string; value: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="bg-white border rounded-xl px-4 py-3 min-w-32">
      <div className="text-xs text-slate-500 flex items-center gap-1">{icon}{label}</div>
      <div className="font-bold text-slate-900">{value}</div>
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="bg-white border rounded-xl p-4"><h3 className="font-semibold mb-3 text-slate-800">{title}</h3>{children}</div>
}

function Dl({ items }: { items: [string, unknown][] }) {
  return (
    <dl className="space-y-1.5 text-sm">
      {items.map(([k, val]) => (
        <div key={k} className="flex justify-between gap-3"><dt className="text-slate-500">{k}</dt><dd className="font-medium text-right">{txt(val)}</dd></div>
      ))}
    </dl>
  )
}

function Table({ rows, cols, empty }: { rows: Row[]; cols: [string, (r: Row) => React.ReactNode][]; empty: string }) {
  if (!rows.length) return <p className="text-sm text-slate-500">{empty}</p>
  return (
    <div className="bg-white border rounded-xl overflow-x-auto">
      <DataTable className="w-full text-sm">
        <thead className="bg-slate-50 text-xs text-slate-500 uppercase"><tr>{cols.map(([h]) => <th key={h} className="text-left p-2.5">{h}</th>)}</tr></thead>
        <tbody className="divide-y">
          {rows.map((r, i) => <tr key={String(r.id ?? i)}>{cols.map(([h, fn]) => <td key={h} className="p-2.5">{fn(r)}</td>)}</tr>)}
        </tbody>
      </DataTable>
    </div>
  )
}
