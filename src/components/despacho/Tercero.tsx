'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Camera, CheckCircle2, Copy, Link2, Loader2, MessageCircle, PlayCircle, RefreshCw, Truck, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { errorMessage, fmtDate, money, receiptUrl } from '@/lib/caja'
import { Modal } from '@/components/ui/modal'
import { SearchableSelect } from '@/components/ui/SearchableSelect'

// Despacho tercerizado: la unidad es de un transportista que no usa el app. Despacho / Torre de Control registra la
// salida y cada entrega (hora, quién recibió y foto de la guía firmada), o se envía al chofer un enlace para que lo
// haga desde su celular sin instalar nada (/tracking/entrega/[token]).

export type TerceroForm = { carrier_id: string; placa: string; conductor: string; telefono: string; doc: string }
export const TERCERO_VACIO: TerceroForm = { carrier_id: '', placa: '', conductor: '', telefono: '', doc: '' }
type Carrier = { id: string; business_name: string; ruc: string | null }

const input = 'w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none text-sm'
const nowLocal = () => {
  const d = new Date(); d.setSeconds(0, 0)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

// Campos del tercero en "Armar ruta"
export function TerceroFields({ value, onChange }: { value: TerceroForm; onChange: (v: TerceroForm) => void }) {
  const supabase = useMemo(() => createClient(), [])
  const [carriers, setCarriers] = useState<Carrier[]>([])
  useEffect(() => {
    // En producción el RUC está en tax_id (en el repositorio, ruc): se lee la fila completa
    void supabase.from('carriers').select('*').order('business_name')
      .then(({ data }) => setCarriers(((data || []) as Record<string, unknown>[])
        .filter(c => c.is_active !== false && String(c.type || '').toUpperCase() !== 'PROPIO')
        .map(c => ({ id: String(c.id), business_name: String(c.business_name || ''), ruc: (c.tax_id ?? c.ruc ?? null) as string | null }))))
  }, [supabase])
  const set = (k: keyof TerceroForm, v: string) => onChange({ ...value, [k]: v })
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-semibold text-slate-700 mb-1">Transportista (proveedor)</label>
        <SearchableSelect value={value.carrier_id} onChange={v => set('carrier_id', v)}
          options={carriers.map(c => ({ value: c.id, label: `${c.business_name}${c.ruc ? ` · RUC ${c.ruc}` : ''}` }))}
          placeholder="Seleccione el transportista..." />
        {carriers.length === 0 && <p className="text-[11px] text-amber-700 mt-1">No hay transportistas proveedores activos: regístrelo en Maestros → Transportistas.</p>}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">Placa</label>
          <input className={`${input} uppercase`} value={value.placa} onChange={e => set('placa', e.target.value.toUpperCase())} placeholder="ABC-123" maxLength={10} />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">DNI / licencia (opcional)</label>
          <input className={input} value={value.doc} onChange={e => set('doc', e.target.value)} maxLength={20} />
        </div>
      </div>
      <div>
        <label className="block text-xs font-semibold text-slate-700 mb-1">Chofer</label>
        <input className={input} value={value.conductor} onChange={e => set('conductor', e.target.value)} placeholder="Nombre y apellido" maxLength={120} />
      </div>
      <div>
        <label className="block text-xs font-semibold text-slate-700 mb-1">Celular del chofer</label>
        <input className={input} value={value.telefono} onChange={e => set('telefono', e.target.value.replace(/[^\d+ ]/g, ''))} placeholder="999 888 777" maxLength={20} />
      </div>
      <p className="text-[11px] text-slate-500 leading-snug">
        Sin checklist pre-ruta ni GPS: el avance se registra desde Despacho o con el enlace para el chofer. La guía de remisión
        la sigue confirmando la Asistente Documentario antes de la salida.
      </p>
    </div>
  )
}

type Parada = {
  request_id: string; orden: number; solicitud: string; destino: string | null; contacto: string | null; documento: string | null
  estado: string; conformidad: string; entregado_at: string | null; recibido_por: string | null; foto: string | null; nota: string | null; fuente: string | null
}
type Avance = {
  despacho: { id: string; numero: string; estado: string; placa: string; conductor: string | null; telefono: string | null; doc: string | null
    transportista: string | null; salida_programada: string | null; salida_at: string | null; entrega_at: string | null; docs_listos: boolean }
  paradas: Parada[]
  enlace: { token: string; codigo?: string; expires_at: string; last_used_at: string | null } | null
}

export const enlaceTercero = (token: string) => `${typeof window === 'undefined' ? '' : window.location.origin}/tracking/entrega/${token}`

function whatsappUrl(telefono: string | null, text: string) {
  const digits = (telefono || '').replace(/\D/g, '')
  const phone = digits.length === 9 ? `51${digits}` : digits
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`
}

// Ventana "Registrar avance" de un despacho tercerizado
export function TerceroAvanceModal({ dispatchId, onClose, onChanged }: { dispatchId: string | null; onClose: () => void; onChanged: () => void }) {
  const supabase = useMemo(() => createClient(), [])
  const [data, setData] = useState<Avance | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [salidaAt, setSalidaAt] = useState(nowLocal())
  const [form, setForm] = useState<{ request_id: string; at: string; recibido: string; nota: string; file: File | null } | null>(null)
  const [fotos, setFotos] = useState<Record<string, string | null>>({})

  const [version, setVersion] = useState(0)
  const load = useCallback(() => setVersion(v => v + 1), [])
  useEffect(() => {
    if (!dispatchId) return
    let cancel = false
    void (async () => {
      const { data: r, error } = await supabase.rpc('tercero_avance', { p_dispatch_id: dispatchId })
      if (cancel) return
      if (error || !r?.success) { toast.error(error?.message || r?.error || 'No se pudo cargar el avance'); return }
      const urls: Record<string, string | null> = {}
      await Promise.all((r as Avance).paradas.filter(p => p.foto).map(async p => { urls[p.request_id] = await receiptUrl(supabase, p.foto) }))
      if (!cancel) { setData(r as Avance); setFotos(urls) }
    })()
    return () => { cancel = true }
  }, [dispatchId, supabase, version])

  const run = async (key: string, fn: () => Promise<{ success?: boolean; error?: string } | null>, ok: string) => {
    setBusy(key)
    try {
      const r = await fn()
      if (!r?.success) throw new Error(r?.error || 'No se pudo registrar')
      toast.success(ok)
      load(); onChanged()
      return true
    } catch (e) { toast.error(errorMessage(e)); return false } finally { setBusy(null) }
  }

  const registrarSalida = () => run('salida', async () => {
    const { data: r, error } = await supabase.rpc('tercero_registrar_salida', { p_dispatch_id: dispatchId, p_at: new Date(salidaAt).toISOString() })
    if (error) throw error
    return r
  }, 'Salida registrada: el despacho pasó a En ruta.')

  const registrarEntrega = async () => {
    if (!form || !dispatchId) return
    if (!form.file) { toast.error('Adjunte la foto de la guía firmada o de la constancia'); return }
    const done = await run('entrega', async () => {
      const { data: auth } = await supabase.auth.getUser()
      if (!auth.user) throw new Error('Sesión vencida')
      const ext = (form.file!.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
      const path = `${auth.user.id}/tercero/${dispatchId}/${crypto.randomUUID()}.${ext}`
      const { error: up } = await supabase.storage.from('driver_evidence').upload(path, form.file!, { contentType: form.file!.type })
      if (up) throw new Error('No se pudo subir la foto: ' + up.message)
      const { data: r, error } = await supabase.rpc('tercero_registrar_entrega', {
        p_dispatch_id: dispatchId, p_request_id: form.request_id, p_at: new Date(form.at).toISOString(),
        p_recibido_por: form.recibido, p_foto: path, p_nota: form.nota || null,
      })
      if (error || !r?.success) await supabase.storage.from('driver_evidence').remove([path])
      if (error) throw error
      return r
    }, 'Guía recibida: pendiente de validación del Supervisor de Transporte.')
    if (done) setForm(null)
  }

  const generarEnlace = () => run('enlace', async () => {
    const { data: r, error } = await supabase.rpc('tercero_generar_enlace', { p_dispatch_id: dispatchId })
    if (error) throw error
    return r
  }, 'Enlace generado: compártalo con el chofer.')

  const revocarEnlace = () => run('revocar', async () => {
    const { data: r, error } = await supabase.rpc('tercero_revocar_enlace', { p_dispatch_id: dispatchId })
    if (error) throw error
    return r
  }, 'Enlace anulado.')

  const d = data?.despacho
  const enRuta = d && ['EN_CURSO', 'EN RUTA'].includes(d.estado)
  const abierto = d && ['PROGRAMADO', 'EN_CURSO', 'EN RUTA'].includes(d.estado)
  const link = data?.enlace ? enlaceTercero(data.enlace.token) : null
  const portal = typeof window === 'undefined' ? '/tracking/entregas' : `${window.location.origin}/tracking/entregas`
  const mensaje = d && link ? `JRM · viaje ${d.numero}. Placa: ${d.placa}. Ingrese a ${portal} con código ${data?.enlace?.codigo || '(solicitar renovación)'} o use su enlace de viaje: ${link}. Sin guía firmada y aprobada por el Supervisor de Transporte, el servicio no puede avanzar. Al enviarla se bloquea el acceso a esa entrega; solo una observación o rechazo permite corregirla.` : ''

  return (
    <Modal isOpen={!!dispatchId} onClose={onClose} title={`Avance del tercero${d ? ` · ${d.numero}` : ''}`} maxWidth="max-w-3xl">
      {!data || !d ? <div className="p-8 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div> : (
        <div className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
            <div className="bg-slate-50 border rounded-xl p-3">
              <div className="text-[11px] font-semibold uppercase text-slate-500">Transportista</div>
              <div className="font-bold text-[#002855]">{d.transportista || '—'}</div>
              <div className="text-slate-600">{d.placa} · {d.conductor || '—'}</div>
              {d.telefono && <a href={`tel:${d.telefono}`} className="text-blue-700 text-xs">{d.telefono}</a>}
            </div>
            <div className="bg-slate-50 border rounded-xl p-3">
              <div className="text-[11px] font-semibold uppercase text-slate-500">Salida</div>
              <div className="text-slate-700">Programada: {fmtDate(d.salida_programada, true)}</div>
              <div className="font-semibold text-slate-800">Real: {d.salida_at ? fmtDate(d.salida_at, true) : 'sin registrar'}</div>
            </div>
            <div className="bg-slate-50 border rounded-xl p-3">
              <div className="text-[11px] font-semibold uppercase text-slate-500">Entregas</div>
              <div className="font-bold text-slate-800">{data.paradas.filter(p => p.estado === 'ENTREGADO').length} de {data.paradas.length}</div>
              {d.entrega_at && <div className="text-slate-600">Última: {fmtDate(d.entrega_at, true)}</div>}
            </div>
          </div>

          {d.estado === 'PROGRAMADO' && (
            <div className="border rounded-xl p-4 space-y-2">
              <h4 className="font-semibold text-slate-800 flex items-center gap-2"><PlayCircle className="w-4 h-4 text-blue-600" />Registrar salida</h4>
              {!d.docs_listos && <p className="text-xs text-amber-700">La guía aún no está confirmada por la Asistente Documentario: la salida se bloqueará hasta entonces.</p>}
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <label className="block text-xs text-slate-600 mb-1">Hora real de salida</label>
                  <input type="datetime-local" className={input} value={salidaAt} max={nowLocal()} onChange={e => setSalidaAt(e.target.value)} />
                </div>
                <button onClick={registrarSalida} disabled={!!busy}
                  className="px-4 py-2 bg-[#002855] text-white text-sm font-semibold rounded-lg disabled:opacity-50 flex items-center gap-2">
                  {busy === 'salida' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Truck className="w-4 h-4" />}Salió
                </button>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <h4 className="font-semibold text-slate-800">Paradas</h4>
            {data.paradas.map(p => (
              <div key={p.request_id} className="border rounded-xl p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-[#002855] text-sm">#{p.orden} · {p.solicitud}{p.documento ? <span className="ml-2 text-[11px] text-slate-500 font-normal">Guía {p.documento}</span> : null}</div>
                    <p className="text-xs text-amber-800">{p.conformidad === 'RECIBIDA' ? 'Pendiente de validación del Supervisor de Transporte' : p.conformidad === 'OBSERVADA' ? 'Observada: corrija el sustento' : p.conformidad === 'RECHAZADA' ? 'Rechazada: corrija el sustento' : ''}</p>
                    <div className="text-xs text-slate-600 truncate" title={p.destino || ''}>{p.destino || '—'}</div>
                    {p.estado === 'ENTREGADO' && (
                      <div className="text-xs text-emerald-700 mt-1">
                        Entregado {fmtDate(p.entregado_at, true)}{p.recibido_por ? ` · recibió ${p.recibido_por}` : ''}{p.fuente === 'ENLACE' ? ' · por el chofer' : ''}{p.nota ? ` · ${p.nota}` : ''}
                      </div>
                    )}
                  </div>
                  {p.estado === 'ENTREGADO' ? (
                    fotos[p.request_id]
                      ? <a href={fotos[p.request_id]!} target="_blank" rel="noreferrer" className="block w-20 h-14 rounded-lg overflow-hidden border">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={fotos[p.request_id]!} alt="Constancia" className="w-full h-full object-cover" />
                        </a>
                      : <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                  ) : enRuta && ['PENDIENTE', 'OBSERVADA', 'RECHAZADA'].includes(p.conformidad) && form?.request_id !== p.request_id ? (
                    <button onClick={() => setForm({ request_id: p.request_id, at: nowLocal(), recibido: '', nota: '', file: null })}
                      className="px-3 py-1.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-lg text-xs font-semibold">Enviar guía para validación</button>
                  ) : !enRuta ? <span className="text-[11px] text-slate-400">Pendiente</span> : null}
                </div>
                {form?.request_id === p.request_id && (
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 bg-emerald-50/50 rounded-lg p-3">
                    <div>
                      <label className="block text-xs text-slate-600 mb-1">Hora de entrega</label>
                      <input type="datetime-local" className={input} value={form.at} max={nowLocal()} onChange={e => setForm({ ...form, at: e.target.value })} />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-600 mb-1">Recibió (nombre)</label>
                      <input className={input} value={form.recibido} onChange={e => setForm({ ...form, recibido: e.target.value })} maxLength={120} />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-600 mb-1">Foto de la guía firmada / constancia</label>
                      <input type="file" accept="image/jpeg,image/png,image/webp" className="text-xs" onChange={e => setForm({ ...form, file: e.target.files?.[0] || null })} />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-600 mb-1">Nota (opcional)</label>
                      <input className={input} value={form.nota} onChange={e => setForm({ ...form, nota: e.target.value })} placeholder="Ej.: recibido por WhatsApp" maxLength={200} />
                    </div>
                    <div className="sm:col-span-2 flex justify-end gap-2">
                      <button onClick={() => setForm(null)} className="px-3 py-1.5 text-sm bg-slate-100 rounded-lg">Cancelar</button>
                      <button onClick={registrarEntrega} disabled={!!busy} className="px-4 py-1.5 text-sm bg-emerald-600 text-white font-semibold rounded-lg disabled:opacity-50 flex items-center gap-2">
                        {busy === 'entrega' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}Enviar guía
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {d.estado === 'ENTREGADO' && <p className="text-xs text-emerald-700">Todas las paradas están entregadas: use «Cerrar ruta» en la lista para consumir la partida.</p>}
          </div>

          {abierto && (
            <div className="border rounded-xl p-4 space-y-2">
              <h4 className="font-semibold text-slate-800 flex items-center gap-2"><Link2 className="w-4 h-4 text-blue-600" />Acceso del tercero por placa</h4>
              <p className="text-xs text-slate-500">El chofer del tercero abre el enlace en su celular, marca la salida y registra cada entrega con foto, sin instalar nada ni crear cuenta. Vale solo para este viaje.</p>
              {link ? (
                <div className="space-y-2">
                  <p className="text-sm">Portal: <a href={portal} target="_blank" rel="noreferrer" className="text-blue-700 underline">{portal}</a></p>
                  <p className="text-sm font-semibold">Placa: {d.placa} · Código: {data.enlace?.codigo || 'Renueve el enlace para asignar código'}</p>
                  <p className="text-xs text-amber-800">Comparta el código con el contacto registrado del transportista. Solo el Supervisor de Transporte aprueba; el envío de la guía bloquea el acceso a esa entrega.</p>
                  <div className="flex gap-2">
                    <input readOnly value={link} className={`${input} text-xs`} onFocus={e => e.currentTarget.select()} />
                    <button onClick={() => { void navigator.clipboard.writeText(link); toast.success('Enlace copiado') }} className="px-3 bg-slate-100 rounded-lg" title="Copiar"><Copy className="w-4 h-4" /></button>
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs">
                    <a href={whatsappUrl(d.telefono, mensaje)} target="_blank" rel="noreferrer" className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg font-semibold flex items-center gap-1"><MessageCircle className="w-3.5 h-3.5" />Enviar por WhatsApp</a>
                    <button onClick={generarEnlace} disabled={!!busy} className="px-3 py-1.5 bg-slate-100 rounded-lg flex items-center gap-1"><RefreshCw className="w-3.5 h-3.5" />Generar otro</button>
                    <button onClick={revocarEnlace} disabled={!!busy} className="px-3 py-1.5 bg-red-50 text-red-700 border border-red-200 rounded-lg flex items-center gap-1"><XCircle className="w-3.5 h-3.5" />Anular</button>
                    <span className="text-slate-500 self-center">Vence {fmtDate(data.enlace!.expires_at, true)}{data.enlace!.last_used_at ? ` · abierto ${fmtDate(data.enlace!.last_used_at, true)}` : ' · aún no abierto'}</span>
                  </div>
                </div>
              ) : (
                <button onClick={generarEnlace} disabled={!!busy} className="px-4 py-2 bg-blue-50 text-blue-700 border border-blue-200 text-sm font-semibold rounded-lg flex items-center gap-2">
                  {busy === 'enlace' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}Generar enlace
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

// Desempeño por proveedor (Maestros → Transportistas)
type Prov = { carrier_id: string | null; proveedor: string; ruc: string | null; viajes: number; cerrados: number; flete: number; horas_ruta: number | null
  salida_puntual_pct: number | null; entregas: number; entrega_a_tiempo_pct: number | null }
type Viaje = { id: string; numero: string; proveedor: string | null; placa: string; conductor: string | null; estado: string; flete: number
  programado: string; salida_at: string | null; entrega_at: string | null; salida_puntual: boolean | null }

const pctCls = (v: number | null) => v == null ? 'text-slate-400' : v >= 90 ? 'text-emerald-700' : v >= 75 ? 'text-amber-700' : 'text-red-700'

export function TerceroDesempeno() {
  const supabase = useMemo(() => createClient(), [])
  const [dias, setDias] = useState(90)
  const [data, setData] = useState<{ proveedores: Prov[]; viajes: Viaje[]; tolerancia_min: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const hasta = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' })
    const desde = new Date(Date.now() - (dias - 1) * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Lima' })
    void supabase.rpc('tercero_desempeno', { p_desde: desde, p_hasta: hasta }).then(({ data: r, error: e }) => {
      if (e || !r?.success) { setError(e?.message || r?.error || 'Sin datos'); setData(null) } else { setError(null); setData(r) }
    })
  }, [supabase, dias])

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-bold text-slate-800">Desempeño de transportistas tercerizados</h2>
          <p className="text-xs text-slate-500">Viajes con unidad de tercero. No se mezcla con los indicadores de los conductores propios.</p>
        </div>
        <select value={dias} onChange={e => setDias(Number(e.target.value))} className="border border-slate-300 rounded-lg text-sm px-2 py-1.5">
          <option value={30}>Últimos 30 días</option><option value={90}>Últimos 90 días</option><option value={180}>Últimos 180 días</option><option value={365}>Último año</option>
        </select>
      </div>
      {error ? <p className="text-sm text-slate-500">{error}</p> : !data ? <Loader2 className="w-5 h-5 animate-spin text-slate-400" /> : data.proveedores.length === 0 ? (
        <p className="text-sm text-slate-500">Sin viajes tercerizados en el período. Se programan en Despacho → Armar ruta → «Tercero».</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-500 uppercase bg-slate-50">
                <tr>
                  <th className="p-2 text-left">Transportista</th><th className="p-2 text-right">Viajes</th><th className="p-2 text-right">Cerrados</th>
                  <th className="p-2 text-right" title={`Salida real hasta ${data.tolerancia_min} min después de la programada`}>Salida puntual</th>
                  <th className="p-2 text-right" title="Entregas hasta la fecha requerida de la solicitud">Entrega a tiempo</th>
                  <th className="p-2 text-right">Horas en ruta</th><th className="p-2 text-right">Flete</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.proveedores.map(p => (
                  <tr key={p.carrier_id || 'x'}>
                    <td className="p-2"><div className="font-semibold text-slate-800">{p.proveedor}</div>{p.ruc && <div className="text-[11px] text-slate-500">RUC {p.ruc}</div>}</td>
                    <td className="p-2 text-right tabular-nums">{p.viajes}</td>
                    <td className="p-2 text-right tabular-nums">{p.cerrados}</td>
                    <td className={`p-2 text-right tabular-nums font-semibold ${pctCls(p.salida_puntual_pct)}`}>{p.salida_puntual_pct == null ? 's/d' : `${p.salida_puntual_pct} %`}</td>
                    <td className={`p-2 text-right tabular-nums font-semibold ${pctCls(p.entrega_a_tiempo_pct)}`}>{p.entrega_a_tiempo_pct == null ? 's/d' : `${p.entrega_a_tiempo_pct} %`} <span className="text-[11px] text-slate-400 font-normal">({p.entregas})</span></td>
                    <td className="p-2 text-right tabular-nums">{p.horas_ruta ?? '—'}</td>
                    <td className="p-2 text-right tabular-nums">{money(p.flete)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary className="text-xs text-blue-700 cursor-pointer">Ver viajes ({data.viajes.length})</summary>
            <div className="overflow-x-auto mt-2">
              <table className="w-full text-xs">
                <thead className="text-slate-500 bg-slate-50"><tr><th className="p-1.5 text-left">Despacho</th><th className="p-1.5 text-left">Transportista</th><th className="p-1.5 text-left">Placa / chofer</th><th className="p-1.5 text-left">Programado</th><th className="p-1.5 text-left">Salida real</th><th className="p-1.5 text-left">Entrega</th><th className="p-1.5 text-left">Estado</th><th className="p-1.5 text-right">Flete</th></tr></thead>
                <tbody className="divide-y">
                  {data.viajes.map(v => (
                    <tr key={v.id}>
                      <td className="p-1.5 font-semibold text-[#002855]">{v.numero}</td><td className="p-1.5">{v.proveedor || '—'}</td>
                      <td className="p-1.5">{v.placa} · {v.conductor || '—'}</td><td className="p-1.5">{fmtDate(v.programado, true)}</td>
                      <td className={`p-1.5 ${v.salida_puntual === false ? 'text-red-700 font-semibold' : ''}`}>{v.salida_at ? fmtDate(v.salida_at, true) : '—'}</td>
                      <td className="p-1.5">{v.entrega_at ? fmtDate(v.entrega_at, true) : '—'}</td><td className="p-1.5">{v.estado}</td>
                      <td className="p-1.5 text-right tabular-nums">{money(v.flete)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </div>
  )
}
