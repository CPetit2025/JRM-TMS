'use client'
import { DataTable } from '@/components/ui/data-table'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Copy, Link2, Loader2, MessageCircle, PlayCircle, RefreshCw, Truck, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { errorMessage, fmtDate, money } from '@/lib/caja'
import { Modal } from '@/components/ui/modal'
import { SearchableSelect } from '@/components/ui/SearchableSelect'
import { DeliveryReview, type DeliveryReviewTarget } from '@/components/delivery/DeliveryReview'

// Despacho tercerizado: la unidad es de un transportista que no usa el app. Despacho / Torre de Control registra la
// salida y consulta las guías. El proveedor sube el sustento mediante su acceso exclusivo
// desde el portal público, sin instalar nada (/tracking/entregas).

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
          <label className="block text-xs font-semibold text-slate-700 mb-1">DNI / CE del conductor</label>
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
        firmada y el Packing List los sube el proveedor desde su portal al entregar; la salida no depende de documentos. El acceso se genera al programar y se comparte desde «Acceso tercero».
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
  const [loadedData, setData] = useState<Avance | null>(null)
  const data = loadedData?.despacho.id === dispatchId ? loadedData : null
  const [loadError, setLoadError] = useState<{ id: string; message: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [salidaAt, setSalidaAt] = useState(nowLocal())
  const [review, setReview] = useState<DeliveryReviewTarget | null>(null)

  const [version, setVersion] = useState(0)
  const load = useCallback(() => setVersion(v => v + 1), [])
  useEffect(() => {
    if (!dispatchId) return
    let cancel = false
    void (async () => {
      const { data: r, error } = await supabase.rpc('tercero_avance', { p_dispatch_id: dispatchId })
      if (cancel) return
      if (error || !r?.success) { setLoadError({ id: dispatchId, message: error?.message || r?.error || 'No se pudo cargar el avance' }); return }
      setLoadError(null)
      if (!cancel) setData(r as Avance)
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

  const generarEnlace = () => run('enlace', async () => {
    const { data: r, error } = await supabase.rpc('tercero_generar_enlace', { p_dispatch_id: dispatchId })
    if (error) throw error
    return r
  }, 'Acceso generado: comparte enlace, placa y código con el proveedor.')

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
  const code = data?.enlace?.codigo || ''
  const enabled = data?.paradas.some(p => ['PENDIENTE', 'OBSERVADA', 'RECHAZADA'].includes(p.conformidad)) ?? false
  const mensaje = d && code ? [
    `JRM S.A.C. · Servicio ${d.numero}`,
    `Portal de transportistas: ${portal}`,
    `Placa: ${d.placa}`, `Código de acceso: ${code.toUpperCase()}`,
    `Vigencia: ${fmtDate(data!.enlace!.expires_at, true)} (hora de Lima).`,
    '1. Ingresa al portal con tu placa y código. No necesitas instalar el app.',
    '2. Después de entregar, adjunta fotos legibles de la guía de remisión completa con firma o sello de recepción en destino, número de guía y nombre del receptor. Este enlace solo permite subir esa guía.',
    '3. El Supervisor de Transporte valida la guía. Sin aprobación, el servicio no avanza.',
    'Al enviar, esa entrega queda bloqueada. Solo una observación o rechazo permite corregirla. Las demás entregas pendientes siguen disponibles.',
    'Si necesitas ayuda, contacta al responsable de Transporte de JRM que coordinó el servicio.',
  ].join('\n\n') : ''
  const copy = async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); toast.success(label) }
    catch { toast.error('No se pudo copiar. Selecciona el texto y cópialo manualmente.') }
  }


  return (
    <>
    <Modal isOpen={!!dispatchId} onClose={() => { setData(null); setLoadError(null); onClose() }} title={`Acceso GR y avance del tercero${d ? ` · ${d.numero}` : ''}`} maxWidth="max-w-3xl">
      {loadError?.id === dispatchId ? <div role="alert" className="rounded-lg bg-red-50 p-4 text-sm text-red-800">{loadError.message}<button type="button" onClick={() => { setLoadError(null); load() }} className="ml-3 min-h-11 font-semibold underline">Reintentar</button></div> : !data || !d ? <div className="p-8 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div> : (
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
                  <button type="button" onClick={() => setReview({ dispatch_id: d.id, request_id: p.request_id, request_number: p.solicitud, ot_code: 'Servicio', plate: d.placa, delivery_address: p.destino || '' })}
                    className="min-h-10 rounded-lg border px-3 text-xs font-semibold text-[#002855]">Consultar guía y validación</button>
                </div>
                {enRuta && ['PENDIENTE', 'OBSERVADA', 'RECHAZADA'].includes(p.conformidad) && <p className="mt-2 text-xs text-slate-500">El proveedor debe subir o corregir la guía desde su portal. Comparte el acceso de este servicio.</p>}

              </div>
            ))}
            {d.estado === 'ENTREGADO' && <p className="text-xs text-emerald-700">Todas las paradas están entregadas: use «Cerrar ruta» en la lista para consumir la partida.</p>}
          </div>

          {abierto && (
            <div className="border rounded-xl p-4 space-y-2">
              <h4 className="font-semibold text-slate-800 flex items-center gap-2"><Link2 className="w-4 h-4 text-blue-600" />Acceso del tercero por placa</h4>
              <p className="text-sm leading-6 text-slate-600">El código se genera automáticamente al programar este servicio. Comparte el portal, la placa y el código con el proveedor registrado; no se envían mensajes automáticamente.</p>
              {link && code ? <div className="space-y-3">
                <div className="grid gap-3 rounded-xl bg-slate-50 p-4 sm:grid-cols-2"><div><p className="text-xs text-slate-500">Placa del servicio</p><p className="mt-1 text-lg font-bold text-[#002855]">{d.placa}</p></div><div><p className="text-xs text-slate-500">Código de acceso</p><p className="mt-1 break-all font-mono text-lg font-bold tracking-wider text-[#002855]">{code.toUpperCase()}</p></div></div>
                <p className="text-sm">Portal: <a href={portal} target="_blank" rel="noreferrer" className="break-all text-blue-700 underline">{portal}</a></p>
                {code.length !== 4 && <p className="text-xs text-slate-500">Usa «Renovar acceso» para generar un código de 4 caracteres y compartirlo nuevamente.</p>}
                <p className="text-xs text-slate-500">Vence {fmtDate(data.enlace!.expires_at, true)} · Solo para este servicio y las entregas habilitadas.</p>
                {!enabled && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">No quedan entregas habilitadas para subir guías. Una observación o rechazo del Supervisor de Transporte vuelve a abrir únicamente la entrega afectada.</p>}
                <textarea readOnly value={mensaje} aria-label="Instrucciones para compartir con el proveedor" className="min-h-36 w-full rounded-xl border border-slate-200 bg-white p-3 text-xs leading-5 text-slate-600" onFocus={e => e.currentTarget.select()} />
                <div className="flex flex-wrap gap-2">
                  <button disabled={!enabled} onClick={() => void copy(mensaje, 'Portal, placa, código e instrucciones copiados')} className="flex min-h-11 items-center gap-2 rounded-lg bg-[#002855] px-3 text-sm font-semibold text-white disabled:opacity-50"><Copy className="h-4 w-4" />Copiar instrucciones</button>
                  {enabled && <a href={whatsappUrl(d.telefono, mensaje)} target="_blank" rel="noreferrer" className="flex min-h-11 items-center gap-2 rounded-lg bg-emerald-600 px-3 text-sm font-semibold text-white"><MessageCircle className="h-4 w-4" />Compartir por WhatsApp</a>}
                  <button disabled={!enabled} onClick={() => void copy(portal, 'Portal copiado')} className="min-h-11 rounded-lg border px-3 text-sm disabled:opacity-50">Copiar portal</button>
                  <button disabled={!enabled} onClick={() => void copy(code.toUpperCase(), 'Código copiado')} className="min-h-11 rounded-lg border px-3 text-sm disabled:opacity-50">Copiar código</button>
                </div>
                <p className="text-xs text-slate-500">WhatsApp abre un mensaje preparado para {d.telefono || 'el contacto que selecciones'}. Revisa el destinatario y envíalo desde WhatsApp.</p>
                <div className="flex flex-wrap items-center gap-2 border-t pt-3"><button onClick={generarEnlace} disabled={!!busy} className="flex min-h-10 items-center gap-1 rounded-lg border px-3 text-xs"><RefreshCw className="h-3.5 w-3.5" />Renovar acceso</button><button onClick={revocarEnlace} disabled={!!busy} className="flex min-h-10 items-center gap-1 rounded-lg border border-red-200 px-3 text-xs text-red-700"><XCircle className="h-3.5 w-3.5" />Revocar acceso</button><span className="text-xs text-slate-500">Renovar invalida el enlace y código anteriores: comparte los nuevos datos.</span></div>
              </div> : <button onClick={generarEnlace} disabled={!!busy} className="flex min-h-11 items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 text-sm font-semibold text-blue-700">{busy === 'enlace' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}Generar acceso para este servicio</button>}

            </div>
          )}
        </div>
      )}
    </Modal>
    <DeliveryReview row={review} onClose={() => setReview(null)} onChanged={() => { load(); onChanged() }} />
    </>
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
            <DataTable className="w-full text-sm">
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
            </DataTable>
          </div>
          <details>
            <summary className="text-xs text-blue-700 cursor-pointer">Ver viajes ({data.viajes.length})</summary>
            <div className="overflow-x-auto mt-2">
              <DataTable className="w-full text-xs">
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
              </DataTable>
            </div>
          </details>
        </>
      )}
    </div>
  )
}
