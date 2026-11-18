'use client'

import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, Link2, Loader2, Save, Undo2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { DataTable } from '@/components/ui/data-table'
import * as api from '@/lib/indicadores/api'
import type { CorreccionBandeja, DefCambio, Enlace, Equipo, EstadoCorreccion, KpiDefConfig } from '@/lib/indicadores/api'
import { EQUIPOS, equipoTxt, ESTADOS_DATOS, fechaHoraTxt, fechaTxt, motivoTxt, num } from '@/lib/indicadores/format'

const msg = (e: unknown, def: string) => e instanceof Error ? e.message : def
const boton = 'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#002855] disabled:opacity-50'
const campo = 'w-full rounded-lg border px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#002855]'

/** Carga una lista y expone recargar; los errores salen por toast. */
function useLista<T>(fn: () => Promise<T[]>, deps: unknown[]) {
  const [items, setItems] = useState<T[] | null>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let vivo = true
    fn().then(x => { if (vivo) setItems(x) }).catch(e => { if (vivo) { setItems([]); toast.error(msg(e, 'No se pudo cargar la lista.')) } })
    return () => { vivo = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps explícitas del llamador
  }, [...deps, nonce])
  return { items, recargar: useCallback(() => setNonce(n => n + 1), []) }
}

const valorCorr = (n: number | null, d: number | null) => n == null ? '—' : d == null || d === 1 ? num(n) : `${num(n)} / ${num(d)}`

export function CorreccionesPanel({ onChange }: { onChange: () => void }) {
  const [estado, setEstado] = useState<EstadoCorreccion | 'TODAS'>('PROPUESTA')
  const { items, recargar } = useLista(() => api.correcciones(estado), [estado])
  const [rechazo, setRechazo] = useState<CorreccionBandeja | null>(null)
  // El mismo diálogo sirve para rechazar una propuesta o revertir una aprobada: ambos exigen motivo.
  const [revertir, setRevertir] = useState(false)
  const [comentario, setComentario] = useState('')
  const [busy, setBusy] = useState('')
  const ejecutar = async (id: string, op: () => Promise<unknown>, ok: string) => {
    setBusy(id)
    try { await op(); toast.success(ok); recargar(); onChange(); return true }
    catch (e) { toast.error(msg(e, 'No se pudo completar la acción.')); return false }
    finally { setBusy('') }
  }
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-2"><label htmlFor="corr-estado" className="text-sm text-slate-600">Estado</label>
      <select id="corr-estado" className="rounded-lg border px-3 py-1.5 text-sm" value={estado} onChange={e => setEstado(e.target.value as EstadoCorreccion | 'TODAS')}>
        <option value="PROPUESTA">Propuestas</option><option value="APROBADA">Aprobadas</option><option value="RECHAZADA">Rechazadas</option><option value="ANULADA">Anuladas o revertidas</option><option value="TODAS">Todas</option></select></div>
    {!items ? <p role="status" className="flex items-center gap-2 p-6 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Cargando…</p>
      : !items.length ? <p className="rounded-xl border bg-white p-8 text-center text-sm text-slate-500">No hay correcciones en este estado.</p>
      : <div className="overflow-x-auto rounded-xl border bg-white"><DataTable dense className="w-full min-w-[900px] text-xs">
        <thead className="bg-slate-50 text-left text-slate-600"><tr><th className="p-2">Indicador</th><th className="p-2">Registro</th><th className="p-2">Cambio</th><th className="p-2">Motivo</th><th className="p-2">Propuesto</th><th className="p-2">Estado</th><th className="p-2"><span className="sr-only">Acciones</span></th></tr></thead>
        <tbody>{items.map(c => <tr key={c.id} className="border-t align-top">
          <td className="p-2"><p className="font-semibold text-[#002855]">{c.kpi_nombre}</p><p className="text-slate-500">{equipoTxt(c.equipo)}</p></td>
          <td className="p-2"><p className="font-mono">{c.ref}</p><p>{c.etiqueta} · {fechaTxt(c.fecha)}</p></td>
          <td className="p-2">{c.accion === 'EXCLUIR' ? 'Excluir del cálculo' : `${valorCorr(c.num_orig, c.den_orig)} → ${valorCorr(c.num_nuevo, c.den_nuevo)}`}</td>
          <td className="p-2"><p>{motivoTxt(c.motivo)}</p>{c.detalle && <p className="text-slate-500">{c.detalle}</p>}</td>
          <td className="p-2"><p>{c.propuesto_por_nombre}</p><p className="text-slate-500">{fechaHoraTxt(c.propuesto_at)}</p></td>
          <td className="p-2"><p className="font-semibold">{c.estado === 'PROPUESTA' ? 'Pendiente' : c.estado === 'APROBADA' ? 'Aprobada' : c.estado === 'ANULADA' ? 'Anulada' : 'Rechazada'}</p>{c.resuelto_por_nombre && <p className="text-slate-500">{c.resuelto_por_nombre} · {fechaHoraTxt(c.resuelto_at)}</p>}{c.comentario && <p className="text-slate-500">«{c.comentario}»</p>}</td>
          <td className="p-2"><div className="flex flex-wrap gap-1">
            {c.puede_resolver && <><button disabled={!!busy} onClick={() => ejecutar(c.id, () => api.resolver(c.id, true, ''), 'Corrección aprobada.')} className={`${boton} border-emerald-300 text-emerald-800`}><Check className="h-3.5 w-3.5" aria-hidden />Aprobar</button>
              <button disabled={!!busy} onClick={() => { setComentario(''); setRevertir(false); setRechazo(c) }} className={`${boton} border-red-300 text-red-800`}><X className="h-3.5 w-3.5" aria-hidden />Rechazar</button></>}
            {c.puede_revertir && <button disabled={!!busy} onClick={() => { setComentario(''); setRevertir(true); setRechazo(c) }} className={`${boton} border-amber-300 text-amber-800`}><Undo2 className="h-3.5 w-3.5" aria-hidden />Revertir</button>}
            {c.puede_anular && <button disabled={!!busy} onClick={() => ejecutar(c.id, () => api.anular(c.id), 'Propuesta anulada.')} className={boton}><Undo2 className="h-3.5 w-3.5" aria-hidden />Anular</button>}
            {busy === c.id && <Loader2 className="h-4 w-4 animate-spin" aria-label="Procesando" />}
          </div></td>
        </tr>)}</tbody>
      </DataTable></div>}
    {rechazo && <Modal isOpen onClose={() => setRechazo(null)} title={revertir ? 'Revertir corrección aprobada' : 'Rechazar corrección'} maxWidth="max-w-md">
      <form className="space-y-3 text-sm" onSubmit={async e => {
        e.preventDefault()
        if (comentario.trim().length < 5) return void toast.error(revertir ? 'Indique el motivo de la reversión.' : 'Indique el motivo del rechazo.')
        const op = revertir ? () => api.revertir(rechazo.id, comentario.trim()) : () => api.resolver(rechazo.id, false, comentario.trim())
        if (await ejecutar(rechazo.id, op, revertir ? 'Corrección revertida: el registro vuelve a su valor original.' : 'Corrección rechazada.')) setRechazo(null)
      }}>
        <p className="text-slate-600">{rechazo.kpi_nombre} · {rechazo.ref}</p>
        {revertir && <p className="text-slate-600">La corrección queda anulada con su motivo (no se borra) y el registro vuelve a contar con su valor original.</p>}
        <label className="block font-semibold text-slate-700">Motivo (obligatorio)<textarea className={`${campo} mt-1`} rows={3} maxLength={500} value={comentario} onChange={e => setComentario(e.target.value)} required /></label>
        <div className="flex justify-end gap-2"><button type="button" onClick={() => setRechazo(null)} className="rounded-lg border px-4 py-2">Cancelar</button><button disabled={!!busy} className="rounded-lg bg-[#cf152d] px-4 py-2 font-semibold text-white">{revertir ? 'Revertir' : 'Rechazar'}</button></div>
      </form>
    </Modal>}
  </div>
}

export function EnlacesPanel({ equipos }: { equipos: Equipo[] }) {
  const { items, recargar } = useLista(api.enlaces, [])
  const [etiqueta, setEtiqueta] = useState('')
  const [sel, setSel] = useState<Equipo[]>(equipos)
  const [nuevo, setNuevo] = useState<{ url: string; pin: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const urlDe = (token: string) => `${window.location.origin}/tracking/indicadores/${token}`
  const copiar = (texto: string) => navigator.clipboard.writeText(texto).then(() => toast.success('Copiado.'), () => toast.error('No se pudo copiar; selecciónelo manualmente.'))
  const crear = async (e: React.FormEvent) => {
    e.preventDefault()
    if (etiqueta.trim().length < 3) return toast.error('Indique una etiqueta (mín. 3 caracteres).')
    if (!sel.length) return toast.error('Seleccione al menos un equipo.')
    setBusy(true)
    try { const r = await api.enlaceCrear(etiqueta.trim(), sel); setNuevo({ url: urlDe(r.token), pin: r.pin }); setEtiqueta(''); recargar() }
    catch (err) { toast.error(msg(err, 'No se pudo crear el enlace.')) }
    finally { setBusy(false) }
  }
  const revocar = async (l: Enlace) => {
    if (!window.confirm(`¿Revocar el enlace «${l.etiqueta}»? Quien lo tenga dejará de ver los indicadores.`)) return
    try { await api.enlaceRevocar(l.token); toast.success('Enlace revocado.'); recargar() } catch (e) { toast.error(msg(e, 'No se pudo revocar.')) }
  }
  return <div className="space-y-4">
    <form onSubmit={crear} className="space-y-3 rounded-xl border bg-white p-4 text-sm">
      <h2 className="font-semibold text-[#002855]">Nuevo enlace de solo lectura</h2>
      <p className="text-xs text-slate-500">Muestra solo periodos cerrados, sin detalle por registro ni nombres de personas. Se pide nombre y PIN al ingresar.</p>
      <label className="block font-semibold text-slate-700">Etiqueta<input className={`${campo} mt-1`} maxLength={80} value={etiqueta} onChange={e => setEtiqueta(e.target.value)} placeholder="Ej.: Gerencia de Operaciones" /></label>
      <fieldset><legend className="font-semibold text-slate-700">Equipos visibles</legend><div className="mt-1 flex flex-wrap gap-4">
        {EQUIPOS.filter(([id]) => equipos.includes(id)).map(([id, l]) => <label key={id} className="flex items-center gap-2"><input type="checkbox" checked={sel.includes(id)} onChange={e => setSel(s => e.target.checked ? [...s, id] : s.filter(x => x !== id))} />{l}</label>)}</div></fieldset>
      <button disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-[#002855] px-4 py-2 font-semibold text-white disabled:opacity-60">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" aria-hidden />}Crear enlace</button>
    </form>
    {nuevo && <div role="status" className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm">
      <p className="font-semibold text-amber-900">Guarde el PIN ahora: no se volverá a mostrar.</p>
      <div className="flex min-w-0 flex-wrap items-center gap-2"><code className="min-w-0 break-all rounded bg-white px-2 py-1">{nuevo.url}</code><button type="button" onClick={() => copiar(nuevo.url)} className={`${boton} bg-white`}><Copy className="h-3.5 w-3.5" aria-hidden />Copiar enlace</button></div>
      <div className="flex flex-wrap items-center gap-2">PIN: <code className="rounded bg-white px-2 py-1 text-lg font-bold tracking-widest">{nuevo.pin}</code><button type="button" onClick={() => copiar(nuevo.pin)} className={`${boton} bg-white`}><Copy className="h-3.5 w-3.5" aria-hidden />Copiar PIN</button>
        <button type="button" onClick={() => setNuevo(null)} className={`${boton} ml-auto bg-white`}>Ya lo guardé</button></div>
    </div>}
    {!items ? <p role="status" className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Cargando enlaces…</p>
      : !items.length ? <p className="text-sm text-slate-500">Aún no hay enlaces.</p>
      : <div className="overflow-x-auto rounded-xl border bg-white"><DataTable dense className="w-full min-w-[640px] text-xs">
        <thead className="bg-slate-50 text-left text-slate-600"><tr><th className="p-2">Etiqueta</th><th className="p-2">Equipos</th><th className="p-2">Creado</th><th className="p-2">Visitas</th><th className="p-2">Última visita</th><th className="p-2">Estado</th></tr></thead>
        <tbody>{items.map(l => <tr key={l.token} className="border-t">
          <td className="p-2 font-semibold">{l.etiqueta}</td><td className="p-2">{l.equipos.map(equipoTxt).join(', ')}</td><td className="p-2">{fechaHoraTxt(l.created_at)}</td>
          <td className="p-2">{l.visitas}</td><td className="p-2">{fechaHoraTxt(l.ultima_visita)}</td>
          <td className="p-2">{l.revoked_at ? <span className="text-slate-500">Revocado {fechaTxt(l.revoked_at)}</span> : <div className="flex flex-wrap gap-1">
            <button onClick={() => copiar(urlDe(l.token))} className={boton}><Copy className="h-3.5 w-3.5" aria-hidden />Copiar enlace</button>
            <button onClick={() => revocar(l)} className={`${boton} border-red-300 text-red-800`}>Revocar</button></div>}</td>
        </tr>)}</tbody>
      </DataTable></div>}
  </div>
}

type FilaDef = { codigo: string; nombre: string; equipo: string; unidad: string; frecuencias: string; actualizado: string; meta: string; tolerancia: string; responsable: string; estado_datos: DefCambio['estado_datos']; nota_datos: string }
const aFila = (k: KpiDefConfig): FilaDef => ({ codigo: k.codigo, nombre: k.nombre, equipo: k.equipo, unidad: k.unidad,
  frecuencias: (k.frecuencias || []).map(f => f.charAt(0) + f.slice(1).toLowerCase()).join(', '), actualizado: k.updated_at ? `Editado ${fechaHoraTxt(k.updated_at)}${k.updated_by_nombre ? ` por ${k.updated_by_nombre}` : ''}` : '',
meta: k.meta == null ? '' : String(k.meta), tolerancia: k.tolerancia == null ? '' : String(k.tolerancia), responsable: k.responsable || '', estado_datos: k.estado_datos, nota_datos: k.nota_datos || '' })

export function ConfigPanel({ onSaved }: { onSaved: () => void }) {
  const { items, recargar } = useLista(api.defs, [])
  if (!items) return <p role="status" className="flex items-center gap-2 p-6 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Cargando definiciones…</p>
  // Al recargar tras guardar cambia updated_at y el editor se reinicia con los valores del servidor.
  return <ConfigEditor key={items.map(i => `${i.codigo}:${i.updated_at}`).join('|')} kpis={items} onSaved={() => { recargar(); onSaved() }} />
}

function ConfigEditor({ kpis, onSaved }: { kpis: KpiDefConfig[]; onSaved: () => void }) {
  const [filas, setFilas] = useState(() => kpis.map(aFila))
  const [busy, setBusy] = useState(false)
  const original = new Map(kpis.map(k => [k.codigo, JSON.stringify(aFila(k))]))
  const cambiadas = filas.filter(f => original.get(f.codigo) !== JSON.stringify(f))
  const set = (codigo: string, patch: Partial<FilaDef>) => setFilas(fs => fs.map(f => f.codigo === codigo ? { ...f, ...patch } : f))
  const aNum = (s: string) => s.trim() === '' ? null : Number(s.replace(',', '.'))
  const guardar = async () => {
    const items: DefCambio[] = cambiadas.map(f => ({ codigo: f.codigo, meta: aNum(f.meta), tolerancia: aNum(f.tolerancia), responsable: f.responsable.trim() || null, estado_datos: f.estado_datos, nota_datos: f.nota_datos.trim() || null }))
    if (items.some(i => (i.meta != null && !Number.isFinite(i.meta)) || (i.tolerancia != null && !Number.isFinite(i.tolerancia)))) return toast.error('Meta y tolerancia deben ser numéricas.')
    setBusy(true)
    try { await api.guardarDef(items); toast.success(`${items.length} indicador(es) actualizado(s).`); onSaved() }
    catch (e) { toast.error(msg(e, 'No se pudo guardar.')) }
    finally { setBusy(false) }
  }
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm text-slate-500">Todos los indicadores, sin importar la frecuencia. Los cambios aplican a los periodos abiertos.</p>
      <button onClick={guardar} disabled={busy || !cambiadas.length} className="inline-flex items-center gap-2 rounded-lg bg-[#002855] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" aria-hidden />}Guardar{cambiadas.length ? ` (${cambiadas.length})` : ''}</button></div>
    <div className="overflow-x-auto rounded-xl border bg-white"><DataTable dense sortable={false} className="w-full min-w-[1000px] text-xs">
      <thead className="bg-slate-50 text-left text-slate-600"><tr><th className="p-2">Indicador</th><th className="p-2">Meta</th><th className="p-2">Tolerancia</th><th className="p-2">Responsable</th><th className="p-2">Estado de datos</th><th className="p-2">Nota de datos</th></tr></thead>
      <tbody>{filas.map(f => <tr key={f.codigo} className="border-t align-top">
        <td className="p-2"><p className="font-semibold text-[#002855]">{f.nombre}</p><p className="text-slate-500">{equipoTxt(f.equipo)} · {f.unidad} · {f.frecuencias}</p>{f.actualizado && <p className="text-slate-400">{f.actualizado}</p>}</td>
        <td className="w-24 p-2"><input aria-label={`Meta de ${f.nombre}`} inputMode="decimal" className={campo} value={f.meta} onChange={e => set(f.codigo, { meta: e.target.value })} /></td>
        <td className="w-24 p-2"><input aria-label={`Tolerancia de ${f.nombre}`} inputMode="decimal" className={campo} value={f.tolerancia} onChange={e => set(f.codigo, { tolerancia: e.target.value })} /></td>
        <td className="w-40 p-2"><input aria-label={`Responsable de ${f.nombre}`} className={campo} maxLength={120} value={f.responsable} onChange={e => set(f.codigo, { responsable: e.target.value })} /></td>
        <td className="w-44 p-2"><select aria-label={`Estado de datos de ${f.nombre}`} className={campo} value={f.estado_datos} onChange={e => set(f.codigo, { estado_datos: e.target.value as FilaDef['estado_datos'] })}>{ESTADOS_DATOS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td>
        <td className="p-2"><textarea aria-label={`Nota de datos de ${f.nombre}`} rows={2} className={campo} maxLength={500} value={f.nota_datos} onChange={e => set(f.codigo, { nota_datos: e.target.value })} /></td>
      </tr>)}</tbody>
    </DataTable></div>
  </div>
}
