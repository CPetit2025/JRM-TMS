'use client'
import { protectedFileHref } from '@/lib/protected-files'
import { DataTable } from '@/components/ui/data-table'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from '@/components/ui/modal'
import { toast } from 'sonner'
import { format } from 'date-fns'
import { ShieldAlert, Plus, RefreshCw, Loader2, FileText, Upload } from 'lucide-react'

// Cumplimiento vehicular (Fase 9): documentos (fuente única que alimenta el motor de elegibilidad),
// documentos de conductores, multas/papeletas y siniestros (migración 20260928090000).

const supabase = createClient()
const fileStamp = () => `${Date.now()}`

const VEHICLE_DOCS = ['SOAT', 'REVISION_TECNICA', 'POLIZA_SEGURO', 'TARJETA_PROPIEDAD', 'PERMISO_CIRCULACION', 'CERTIFICADO_HABILITACION', 'CERTIFICADO_MATPEL', 'CERTIFICADO_GNV', 'OTRO']
const DRIVER_DOCS = ['LICENCIA', 'LICENCIA_ESPECIAL', 'EXAMEN_MEDICO', 'CERTIFICADO_MATPEL', 'SCTR', 'SEGURO_VIDA', 'OTRO']
const FINE_NEXT: Record<string, string[]> = {
  PENDIENTE: ['EN_REVISION', 'APELACION', 'PAGADA', 'ANULADA'], EN_REVISION: ['PENDIENTE', 'APELACION', 'PAGADA', 'ANULADA'],
  APELACION: ['PENDIENTE', 'PAGADA', 'ANULADA'], VENCIDA: ['APELACION', 'PAGADA', 'ANULADA'], PAGADA: [], ANULADA: [],
}
const LEVEL_STYLE: Record<string, string> = {
  VENCIDO: 'bg-red-100 text-red-700', VENCIDA: 'bg-red-100 text-red-700', POR_VENCER: 'bg-orange-100 text-orange-700', PROXIMO: 'bg-amber-100 text-amber-700',
  VIGENTE: 'bg-emerald-100 text-emerald-700', PENDIENTE: 'bg-amber-100 text-amber-700', EN_REVISION: 'bg-sky-100 text-sky-700', APELACION: 'bg-purple-100 text-purple-700',
  PAGADA: 'bg-emerald-100 text-emerald-700', ANULADA: 'bg-slate-100 text-slate-600', REPORTADO: 'bg-amber-100 text-amber-700', EN_EVALUACION: 'bg-sky-100 text-sky-700',
  EN_RECLAMO: 'bg-purple-100 text-purple-700', CERRADO: 'bg-slate-100 text-slate-600',
}
const money = (n: number | null | undefined) => `S/ ${Number(n || 0).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const d = (v: string | null | undefined) => v ? format(new Date(v.length === 10 ? `${v}T12:00:00` : v), 'dd/MM/yyyy') : '—'
type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

function loadAll() {
  return Promise.all([
    supabase.from('vw_compliance_alerts').select('*').order('due_date', { ascending: true }),
    supabase.from('vw_document_alerts').select('*').order('expiration_date'),
    supabase.from('driver_documents').select('*, drivers(first_name, last_name)').eq('is_active', true).order('expiry_date'),
    supabase.from('traffic_fines').select('*, drivers(first_name, last_name)').order('infraction_date', { ascending: false }).limit(300),
    supabase.from('vehicle_incidents').select('*, drivers(first_name, last_name)').order('occurred_at', { ascending: false }).limit(200),
    supabase.from('vehicles').select('id, plate').order('plate'),
    supabase.from('drivers').select('id, first_name, last_name').eq('is_active', true).order('first_name'),
  ])
}

export default function CumplimientoPage() {
  const [tab, setTab] = useState<'alertas' | 'vehiculos' | 'conductores' | 'multas' | 'siniestros'>('alertas')
  const [data, setData] = useState<{ alerts: Row[]; vdocs: Row[]; ddocs: Row[]; fines: Row[]; incidents: Row[]; vehicles: Row[]; drivers: Row[] }>({ alerts: [], vdocs: [], ddocs: [], fines: [], incidents: [], vehicles: [], drivers: [] })
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState<'vdoc' | 'ddoc' | 'fine' | 'incident' | null>(null)
  const [editIncident, setEditIncident] = useState<Row | null>(null)

  const apply = useCallback(([a, vd, dd, f, i, v, dr]: Awaited<ReturnType<typeof loadAll>>) => {
    const err = a.error || vd.error || f.error
    if (err) toast.error('Error al cargar: ' + err.message)
    setData({ alerts: a.data || [], vdocs: vd.data || [], ddocs: dd.data || [], fines: f.data || [], incidents: i.data || [], vehicles: v.data || [], drivers: dr.data || [] })
    setLoading(false)
  }, [])
  const refresh = useCallback(() => { setLoading(true); return loadAll().then(apply) }, [apply])
  useEffect(() => { loadAll().then(apply) }, [apply])

  const kpis = useMemo(() => ({
    docsExpired: data.vdocs.filter(x => x.status === 'VENCIDO').length,
    docsSoon: data.vdocs.filter(x => x.status === 'POR_VENCER' || x.status === 'PROXIMO').length,
    finesOpen: data.fines.filter(x => ['PENDIENTE', 'VENCIDA', 'EN_REVISION', 'APELACION'].includes(x.status)),
    incidentsOpen: data.incidents.filter(x => x.status !== 'CERRADO').length,
  }), [data])

  const transitionFine = async (fine: Row, status: string) => {
    let args: Record<string, unknown> = { p_fine_id: fine.id, p_status: status, p_notes: null }
    if (status === 'PAGADA') {
      const amount = prompt('Monto pagado (S/):', String(fine.amount)); if (!amount) return
      const ref = prompt('Referencia del pago (operación/recibo):'); if (!ref?.trim()) return
      let resp = fine.responsibility
      if (resp === 'POR_DETERMINAR') { resp = (prompt('Responsabilidad (CONDUCTOR, EMPRESA, TERCERO):') || '').toUpperCase(); if (!['CONDUCTOR', 'EMPRESA', 'TERCERO'].includes(resp)) return toast.error('Responsabilidad inválida') }
      args = { ...args, p_paid_amount: Number(amount), p_payment_reference: ref, p_responsibility: resp, p_paid_at: null }
    } else if (status === 'APELACION' || status === 'ANULADA') {
      const notes = prompt('Sustento (obligatorio):'); if (!notes?.trim()) return
      args.p_notes = notes
    }
    const { data: res, error } = await supabase.rpc('transition_traffic_fine', args)
    if (error || !res?.success) return toast.error(error?.message || res?.error)
    toast.success(`Multa ${fine.ticket_number}: ${res.previous_status} → ${status}`); refresh()
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2"><ShieldAlert className="w-6 h-6" />Cumplimiento vehicular</h1>
          <p className="text-sm text-slate-500">Documentos (alimentan la elegibilidad), multas y papeletas, siniestros e incidentes con su costo por activo.</p>
        </div>
        <button onClick={refresh} className="px-3 py-2 border rounded-lg text-sm flex items-center gap-2"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />Actualizar</button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[['Documentos vencidos', kpis.docsExpired], ['Por vencer (30 d)', kpis.docsSoon], ['Multas abiertas', kpis.finesOpen.length],
          ['Monto multas abiertas', money(kpis.finesOpen.reduce((s, f) => s + Number(f.amount || 0), 0))], ['Siniestros abiertos', kpis.incidentsOpen]]
          .map(([l, v]) => <div key={l as string} className="bg-white border rounded-xl p-3"><div className="text-xs text-slate-500">{l}</div><div className="text-xl font-bold">{v}</div></div>)}
      </div>

      <div className="flex flex-wrap gap-1 border-b">
        {([['alertas', 'Alertas'], ['vehiculos', 'Documentos de unidades'], ['conductores', 'Documentos de conductores'], ['multas', 'Multas y papeletas'], ['siniestros', 'Siniestros e incidentes']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`px-3 py-2 text-sm border-b-2 -mb-px ${tab === k ? 'border-[#002855] text-[#002855] font-semibold' : 'border-transparent text-slate-500'}`}>{l}</button>
        ))}
      </div>

      {loading ? <div className="p-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div> : (
        <>
          {tab === 'alertas' && <Table rows={data.alerts} empty="Sin alertas de cumplimiento" cols={[
            ['Tipo', r => r.alert_type.replace('_', ' ')], ['Nivel', r => <Badge v={r.level} />], ['Sujeto', r => r.subject], ['Detalle', r => r.detail],
            ['Fecha', r => d(r.due_date)], ['Días', r => r.days_remaining ?? '—']]} />}

          {tab === 'vehiculos' && (
            <Section action={() => setModal('vdoc')} label="Registrar documento">
              <Table rows={data.vdocs} empty="Sin documentos registrados" cols={[
                ['Unidad', r => r.vehicle_plate], ['Documento', r => r.document_type.replace(/_/g, ' ')], ['Número', r => r.document_number || '—'],
                ['Emisor', r => r.issuer || '—'], ['Vence', r => d(r.expiration_date)], ['Estado', r => <Badge v={r.status} />],
                ['Archivo', r => r.file_url ? <a href={protectedFileHref(r.file_url)} target="_blank" rel="noreferrer" className="text-blue-600 text-xs">ver</a> : '—']]} />
            </Section>
          )}

          {tab === 'conductores' && (
            <Section action={() => setModal('ddoc')} label="Registrar documento">
              <Table rows={data.ddocs} empty="Sin documentos de conductores" cols={[
                ['Conductor', r => `${r.drivers?.first_name ?? ''} ${r.drivers?.last_name ?? ''}`], ['Documento', r => r.doc_type.replace(/_/g, ' ')],
                ['Número / categoría', r => [r.doc_number, r.category].filter(Boolean).join(' · ') || '—'], ['Vence', r => d(r.expiry_date)],
                ['Estado', r => <Badge v={new Date(`${r.expiry_date}T23:59:59`) < new Date() ? 'VENCIDO' : 'VIGENTE'} />]]} />
            </Section>
          )}

          {tab === 'multas' && (
            <Section action={() => setModal('fine')} label="Registrar multa/papeleta">
              <Table rows={data.fines} empty="Sin multas registradas" cols={[
                ['Fecha', r => d(r.infraction_date)], ['Unidad', r => r.vehicle_plate], ['Conductor', r => r.drivers ? `${r.drivers.first_name} ${r.drivers.last_name}` : '—'],
                ['Entidad / N°', r => `${r.entity} · ${r.ticket_number}`], ['Código', r => r.infraction_code || '—'], ['Importe', r => money(r.amount)],
                ['Vence', r => d(r.due_date)], ['Responsable', r => r.responsibility.replace('_', ' ')], ['Estado', r => <Badge v={r.status} />],
                ['', r => FINE_NEXT[r.status]?.length ? (
                  <select className="border rounded px-1 py-0.5 text-xs" value="" onChange={e => e.target.value && transitionFine(r, e.target.value)}>
                    <option value="">Cambiar…</option>{FINE_NEXT[r.status].map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
                  </select>) : null]]} />
            </Section>
          )}

          {tab === 'siniestros' && (
            <Section action={() => setModal('incident')} label="Registrar siniestro/incidente">
              <Table rows={data.incidents} empty="Sin siniestros registrados" cols={[
                ['Fecha', r => d(r.occurred_at)], ['Unidad', r => r.vehicle_plate], ['Tipo', r => r.incident_type], ['Criticidad', r => r.severity],
                ['Descripción', r => <span className="line-clamp-2 max-w-xs block">{r.description}</span>], ['Costo final', r => r.final_cost != null ? money(r.final_cost) : `est. ${money(r.estimated_cost)}`],
                ['Seguro', r => money(r.insurance_coverage)], ['Responsable', r => r.responsibility.replace('_', ' ')], ['Estado', r => <Badge v={r.status} />],
                ['', r => r.status !== 'CERRADO' ? <button onClick={() => setEditIncident(r)} className="px-2 py-1 border rounded text-xs">Gestionar</button> : null]]} />
            </Section>
          )}
        </>
      )}

      {modal === 'vdoc' && <VehicleDocModal vehicles={data.vehicles} onClose={() => setModal(null)} onSaved={() => { setModal(null); refresh() }} />}
      {modal === 'ddoc' && <DriverDocModal drivers={data.drivers} onClose={() => setModal(null)} onSaved={() => { setModal(null); refresh() }} />}
      {modal === 'fine' && <FineModal vehicles={data.vehicles} drivers={data.drivers} onClose={() => setModal(null)} onSaved={() => { setModal(null); refresh() }} />}
      {(modal === 'incident' || editIncident) && <IncidentModal incident={editIncident} vehicles={data.vehicles} drivers={data.drivers} onClose={() => { setModal(null); setEditIncident(null) }} onSaved={() => { setModal(null); setEditIncident(null); refresh() }} />}
    </div>
  )
}

function Badge({ v }: { v: string }) {
  return <span className={`px-2 py-0.5 rounded text-xs font-semibold ${LEVEL_STYLE[v] || 'bg-slate-100 text-slate-600'}`}>{String(v).replace(/_/g, ' ')}</span>
}
function Section({ action, label, children }: { action: () => void; label: string; children: React.ReactNode }) {
  return <div className="space-y-3"><button onClick={action} className="px-4 py-2 bg-[#002855] text-white rounded-lg text-sm flex items-center gap-2"><Plus className="w-4 h-4" />{label}</button>{children}</div>
}
function Table({ rows, cols, empty }: { rows: Row[]; cols: [string, (r: Row) => React.ReactNode][]; empty: string }) {
  if (!rows.length) return <p className="text-sm text-slate-500 p-4">{empty}</p>
  return (
    <div className="bg-white border rounded-xl overflow-x-auto">
      <DataTable className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>{cols.map(([h], i) => <th key={i} className="text-left p-3">{h}</th>)}</tr></thead>
        <tbody className="divide-y">{rows.map((r, i) => <tr key={r.id ?? r.ref_id ?? i}>{cols.map(([, fn], j) => <td key={j} className="p-3">{fn(r)}</td>)}</tr>)}</tbody>
      </DataTable>
    </div>
  )
}

async function uploadFile(file: File, folder: string): Promise<string | null> {
  const path = `${folder}/${fileStamp()}-${file.name.replace(/[^\w.-]/g, '_')}`
  const { error } = await supabase.storage.from('evidence').upload(path, file, { contentType: file.type })
  if (error) { toast.error(error.message); return null }
  return supabase.storage.from('evidence').getPublicUrl(path).data.publicUrl
}
const field = 'w-full border rounded-lg px-3 py-2 text-sm'
function FileInput({ onFile, url }: { onFile: (f: File) => void; url: string | null }) {
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer border rounded-lg px-3 py-2 w-fit">
      <Upload className="w-4 h-4" />{url ? 'Archivo adjunto ✓' : 'Adjuntar archivo'}
      <input type="file" className="hidden" accept="image/*,application/pdf" onChange={e => e.target.files?.[0] && onFile(e.target.files[0])} />
    </label>
  )
}

function VehicleDocModal({ vehicles, onClose, onSaved }: { vehicles: Row[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ vehicle_id: '', document_type: 'SOAT', document_number: '', issuer: '', issue_date: '', expiration_date: '' })
  const [url, setUrl] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true)
    const { error } = await supabase.from('vehicle_documents').insert({ ...f, issue_date: f.issue_date || null, document_number: f.document_number || null, issuer: f.issuer || null, file_url: url })
    setSaving(false)
    if (error) return toast.error(error.message)
    toast.success('Documento registrado; el anterior del mismo tipo quedó reemplazado'); onSaved()
  }
  return (
    <Modal isOpen onClose={onClose} title="Documento de unidad">
      <form onSubmit={save} className="space-y-3 text-sm">
        <label className="block">Unidad<select required className={field} value={f.vehicle_id} onChange={e => setF({ ...f, vehicle_id: e.target.value })}><option value="">Seleccionar…</option>{vehicles.map(v => <option key={v.id} value={v.id}>{v.plate}</option>)}</select></label>
        <label className="block">Tipo<select className={field} value={f.document_type} onChange={e => setF({ ...f, document_type: e.target.value })}>{VEHICLE_DOCS.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
        <div className="grid grid-cols-2 gap-3">
          <label>Número<input className={field} value={f.document_number} onChange={e => setF({ ...f, document_number: e.target.value })} /></label>
          <label>Emisor / aseguradora<input className={field} value={f.issuer} onChange={e => setF({ ...f, issuer: e.target.value })} /></label>
          <label>Emisión<input type="date" className={field} value={f.issue_date} onChange={e => setF({ ...f, issue_date: e.target.value })} /></label>
          <label>Vencimiento<input required type="date" className={field} value={f.expiration_date} onChange={e => setF({ ...f, expiration_date: e.target.value })} /></label>
        </div>
        <FileInput url={url} onFile={async file => setUrl(await uploadFile(file, 'documentos/unidades'))} />
        <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="px-4 py-2 border rounded-lg">Cancelar</button><button disabled={saving} className="px-4 py-2 bg-[#002855] text-white rounded-lg">Guardar</button></div>
      </form>
    </Modal>
  )
}

function DriverDocModal({ drivers, onClose, onSaved }: { drivers: Row[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ driver_id: '', doc_type: 'LICENCIA', doc_number: '', category: '', issue_date: '', expiry_date: '' })
  const [url, setUrl] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true)
    const { error } = await supabase.from('driver_documents').insert({ ...f, issue_date: f.issue_date || null, doc_number: f.doc_number || null, category: f.category || null, file_url: url })
    setSaving(false)
    if (error) return toast.error(error.message)
    toast.success('Documento del conductor registrado'); onSaved()
  }
  return (
    <Modal isOpen onClose={onClose} title="Documento de conductor">
      <form onSubmit={save} className="space-y-3 text-sm">
        <label className="block">Conductor<select required className={field} value={f.driver_id} onChange={e => setF({ ...f, driver_id: e.target.value })}><option value="">Seleccionar…</option>{drivers.map(d => <option key={d.id} value={d.id}>{d.first_name} {d.last_name}</option>)}</select></label>
        <label className="block">Tipo<select className={field} value={f.doc_type} onChange={e => setF({ ...f, doc_type: e.target.value })}>{DRIVER_DOCS.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
        <div className="grid grid-cols-2 gap-3">
          <label>Número<input className={field} value={f.doc_number} onChange={e => setF({ ...f, doc_number: e.target.value })} /></label>
          <label>Categoría<input className={field} value={f.category} onChange={e => setF({ ...f, category: e.target.value })} placeholder="A-IIIc" /></label>
          <label>Emisión<input type="date" className={field} value={f.issue_date} onChange={e => setF({ ...f, issue_date: e.target.value })} /></label>
          <label>Vencimiento<input required type="date" className={field} value={f.expiry_date} onChange={e => setF({ ...f, expiry_date: e.target.value })} /></label>
        </div>
        <FileInput url={url} onFile={async file => setUrl(await uploadFile(file, 'documentos/conductores'))} />
        <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="px-4 py-2 border rounded-lg">Cancelar</button><button disabled={saving} className="px-4 py-2 bg-[#002855] text-white rounded-lg">Guardar</button></div>
      </form>
    </Modal>
  )
}

function FineModal({ vehicles, drivers, onClose, onSaved }: { vehicles: Row[]; drivers: Row[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ fine_type: 'PAPELETA', vehicle_id: '', driver_id: '', infraction_date: '', infraction_code: '', description: '', entity: '', ticket_number: '', amount: '', due_date: '', responsibility: 'POR_DETERMINAR' })
  const [url, setUrl] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true)
    const { error } = await supabase.from('traffic_fines').insert({
      ...f, driver_id: f.driver_id || null, amount: Number(f.amount), due_date: f.due_date || null, infraction_date: new Date(f.infraction_date).toISOString(),
      infraction_code: f.infraction_code || null, description: f.description || null, evidence_url: url,
    })
    setSaving(false)
    if (error) return toast.error(error.code === '23505' ? 'Esa papeleta ya está registrada para la entidad' : error.message)
    toast.success('Registrada. Si no indicó conductor, se asignó el del viaje vigente a esa fecha.'); onSaved()
  }
  return (
    <Modal isOpen onClose={onClose} title="Multa / papeleta" maxWidth="max-w-2xl">
      <form onSubmit={save} className="grid md:grid-cols-2 gap-3 text-sm">
        <label>Tipo<select className={field} value={f.fine_type} onChange={e => setF({ ...f, fine_type: e.target.value })}><option>PAPELETA</option><option>MULTA</option></select></label>
        <label>Unidad<select required className={field} value={f.vehicle_id} onChange={e => setF({ ...f, vehicle_id: e.target.value })}><option value="">Seleccionar…</option>{vehicles.map(v => <option key={v.id} value={v.id}>{v.plate}</option>)}</select></label>
        <label>Fecha y hora de la infracción<input required type="datetime-local" className={field} value={f.infraction_date} onChange={e => setF({ ...f, infraction_date: e.target.value })} /></label>
        <label>Conductor (vacío = el del viaje)<select className={field} value={f.driver_id} onChange={e => setF({ ...f, driver_id: e.target.value })}><option value="">Inferir del viaje</option>{drivers.map(d => <option key={d.id} value={d.id}>{d.first_name} {d.last_name}</option>)}</select></label>
        <label>Entidad<input required className={field} value={f.entity} onChange={e => setF({ ...f, entity: e.target.value })} placeholder="SAT Lima, SUTRAN, MTC…" /></label>
        <label>N° de papeleta/acta<input required className={field} value={f.ticket_number} onChange={e => setF({ ...f, ticket_number: e.target.value })} /></label>
        <label>Código de infracción<input className={field} value={f.infraction_code} onChange={e => setF({ ...f, infraction_code: e.target.value })} /></label>
        <label>Importe (S/)<input required type="number" min={0} step="0.01" className={field} value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} /></label>
        <label>Vencimiento de pago<input type="date" className={field} value={f.due_date} onChange={e => setF({ ...f, due_date: e.target.value })} /></label>
        <label>Responsabilidad<select className={field} value={f.responsibility} onChange={e => setF({ ...f, responsibility: e.target.value })}>{['POR_DETERMINAR', 'CONDUCTOR', 'EMPRESA', 'TERCERO'].map(r => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}</select></label>
        <label className="md:col-span-2">Descripción<input className={field} value={f.description} onChange={e => setF({ ...f, description: e.target.value })} /></label>
        <FileInput url={url} onFile={async file => setUrl(await uploadFile(file, 'multas'))} />
        <div className="md:col-span-2 flex justify-end gap-2"><button type="button" onClick={onClose} className="px-4 py-2 border rounded-lg">Cancelar</button><button disabled={saving} className="px-4 py-2 bg-[#002855] text-white rounded-lg">Registrar</button></div>
      </form>
    </Modal>
  )
}

function IncidentModal({ incident, vehicles, drivers, onClose, onSaved }: { incident: Row | null; vehicles: Row[]; drivers: Row[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    incident_type: incident?.incident_type || 'ACCIDENTE', severity: incident?.severity || 'MEDIA', vehicle_id: incident?.vehicle_id || '', driver_id: incident?.driver_id || '',
    occurred_at: incident?.occurred_at ? String(incident.occurred_at).slice(0, 16) : '', location: incident?.location || '', description: incident?.description || '',
    third_parties: incident?.third_parties || '', police_report: incident?.police_report || '', insurance_claim_number: incident?.insurance_claim_number || '',
    estimated_cost: incident?.estimated_cost ?? '', final_cost: incident?.final_cost ?? '', insurance_coverage: incident?.insurance_coverage ?? 0,
    responsibility: incident?.responsibility || 'POR_DETERMINAR', status: incident?.status || 'REPORTADO', vehicle_damage: incident?.vehicle_damage ?? false,
  })
  const [saving, setSaving] = useState(false)
  const num = (v: unknown) => (v === '' || v == null ? null : Number(v))
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true)
    const payload = { ...f, driver_id: f.driver_id || null, occurred_at: new Date(f.occurred_at).toISOString(), estimated_cost: num(f.estimated_cost), final_cost: num(f.final_cost), insurance_coverage: num(f.insurance_coverage) ?? 0 }
    const { error } = incident ? await supabase.from('vehicle_incidents').update(payload).eq('id', incident.id) : await supabase.from('vehicle_incidents').insert(payload)
    setSaving(false)
    if (error) return toast.error(error.message)
    toast.success(f.vehicle_damage && !incident ? 'Registrado. El daño generó una falla en el backlog de mantenimiento.' : 'Guardado'); onSaved()
  }
  return (
    <Modal isOpen onClose={onClose} title={incident ? 'Gestionar siniestro' : 'Siniestro / incidente'} maxWidth="max-w-2xl">
      <form onSubmit={save} className="grid md:grid-cols-2 gap-3 text-sm max-h-[75vh] overflow-y-auto pr-1">
        <label>Tipo<select className={field} value={f.incident_type} onChange={e => setF({ ...f, incident_type: e.target.value })}>{['ACCIDENTE', 'SINIESTRO', 'ROBO', 'DANO', 'INCIDENTE'].map(t => <option key={t}>{t}</option>)}</select></label>
        <label>Criticidad<select className={field} value={f.severity} onChange={e => setF({ ...f, severity: e.target.value })}>{['CRITICA', 'ALTA', 'MEDIA', 'BAJA'].map(t => <option key={t}>{t}</option>)}</select></label>
        <label>Unidad<select required disabled={!!incident} className={field} value={f.vehicle_id} onChange={e => setF({ ...f, vehicle_id: e.target.value })}><option value="">Seleccionar…</option>{vehicles.map(v => <option key={v.id} value={v.id}>{v.plate}</option>)}</select></label>
        <label>Conductor (vacío = el del viaje)<select className={field} value={f.driver_id} onChange={e => setF({ ...f, driver_id: e.target.value })}><option value="">Inferir del viaje</option>{drivers.map(d => <option key={d.id} value={d.id}>{d.first_name} {d.last_name}</option>)}</select></label>
        <label>Fecha y hora<input required type="datetime-local" className={field} value={f.occurred_at} onChange={e => setF({ ...f, occurred_at: e.target.value })} /></label>
        <label>Lugar<input className={field} value={f.location} onChange={e => setF({ ...f, location: e.target.value })} /></label>
        <label className="md:col-span-2">Descripción<textarea required className={field} rows={2} value={f.description} onChange={e => setF({ ...f, description: e.target.value })} /></label>
        <label>Terceros involucrados<input className={field} value={f.third_parties} onChange={e => setF({ ...f, third_parties: e.target.value })} /></label>
        <label>Denuncia policial<input className={field} value={f.police_report} onChange={e => setF({ ...f, police_report: e.target.value })} /></label>
        <label>N° de siniestro (seguro)<input className={field} value={f.insurance_claim_number} onChange={e => setF({ ...f, insurance_claim_number: e.target.value })} /></label>
        <label>Costo estimado (S/)<input type="number" min={0} step="0.01" className={field} value={f.estimated_cost} onChange={e => setF({ ...f, estimated_cost: e.target.value })} /></label>
        <label>Costo final (S/)<input type="number" min={0} step="0.01" className={field} value={f.final_cost} onChange={e => setF({ ...f, final_cost: e.target.value })} /></label>
        <label>Cobertura del seguro (S/)<input type="number" min={0} step="0.01" className={field} value={f.insurance_coverage} onChange={e => setF({ ...f, insurance_coverage: e.target.value })} /></label>
        <label>Responsabilidad<select className={field} value={f.responsibility} onChange={e => setF({ ...f, responsibility: e.target.value })}>{['POR_DETERMINAR', 'CONDUCTOR', 'EMPRESA', 'TERCERO'].map(r => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}</select></label>
        <label>Estado<select className={field} value={f.status} onChange={e => setF({ ...f, status: e.target.value })}>{['REPORTADO', 'EN_EVALUACION', 'EN_RECLAMO', 'CERRADO'].map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select></label>
        <label className="flex items-center gap-2 md:col-span-2"><input type="checkbox" checked={f.vehicle_damage} onChange={e => setF({ ...f, vehicle_damage: e.target.checked })} />La unidad sufrió daños (genera una falla en el backlog de mantenimiento)</label>
        <div className="md:col-span-2 flex justify-end gap-2"><button type="button" onClick={onClose} className="px-4 py-2 border rounded-lg">Cancelar</button><button disabled={saving} className="px-4 py-2 bg-[#002855] text-white rounded-lg flex items-center gap-2"><FileText className="w-4 h-4" />Guardar</button></div>
      </form>
    </Modal>
  )
}
