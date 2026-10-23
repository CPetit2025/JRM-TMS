'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Gauge, Loader2, Pencil, Plus, RefreshCw, Save } from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/ui/page-header'
import { Modal } from '@/components/ui/modal'
import { createClient } from '@/lib/supabase/client'

// Activos de mantenimiento y equivalencias (migración 20261023100000). Los activos son las unidades de Flota (`vehicles`)
// con clase, tipo de medidor, área y baja. Las equivalencias unen los nombres del Excel histórico con el activo y el
// proveedor del sistema; se revisan aquí. Importación del Excel: docs/mantenimiento-flota.md.

const CLASES = [['VEHICULAR', 'Unidad vehicular'], ['MONTACARGAS', 'Montacargas'], ['ELEVACION', 'Equipo de elevación'], ['APILADOR', 'Apilador'], ['TRANSPALETA', 'Transpaleta']] as const
const claseLabel = (c: string | null) => CLASES.find(x => x[0] === c)?.[1] ?? 'Sin clase'
const soles = (n: number | null | undefined) => n === null || n === undefined ? '—' : `S/ ${Number(n).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fdate = (d: string | null | undefined) => d ? new Date(d.length === 10 ? `${d}T12:00:00` : d).toLocaleDateString('es-PE') : '—'

interface Activo {
  id: string; plate: string; type: string | null; brand: string | null; model: string | null; internal_code: string | null; serial_number: string | null
  asset_class: string | null; display_name: string | null; meter_type: 'KM' | 'HORAS' | null; assigned_area: string | null; manufacture_year: number | null
  status: string | null; decommissioned_at: string | null; decommission_reason: string | null; registros: number; monto: number | null
  ultima_lectura: { valor: number; fecha: string; obs: string } | null
}
interface Alias { nombre_norm: string; nombre_origen: string; vehicle_id?: string | null; plate?: string | null; provider_id?: string | null; proveedor?: string | null; revisado: boolean; nota: string | null; registros: number }
interface Importacion { id: string; archivo: string; filas: number; insertados: number; actualizados: number; sin_cambio: number; rechazados: number; dudosos: number; estado: string; created_at: string }

export default function ActivosMantenimientoPage() {
  const supabase = useMemo(() => createClient(), [])
  const [activos, setActivos] = useState<Activo[] | null>(null)
  const [alias, setAlias] = useState<{ activos: Alias[]; proveedores: Alias[]; importaciones: Importacion[] } | null>(null)
  const [providers, setProviders] = useState<Array<{ id: string; business_name: string }>>([])
  const [edit, setEdit] = useState<Partial<Activo> | null>(null)
  const [lectura, setLectura] = useState<Activo | null>(null)
  const [tab, setTab] = useState<'activos' | 'equivalencias'>('activos')

  const load = useCallback(async () => {
    const [a, b, c] = await Promise.all([supabase.rpc('mant_activos_lista'), supabase.rpc('mant_alias_lista'),
      supabase.from('maintenance_providers').select('id, business_name').order('business_name')])
    if (a.error) toast.error(a.error.message); else setActivos(a.data as Activo[])
    if (!b.error) setAlias(b.data as never)
    setProviders((c.data ?? []) as never)
  }, [supabase])
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) }, [load])

  const revisar = async (tipo: 'ACTIVO' | 'PROVEEDOR', a: Alias, destino: string) => {
    const { error } = await supabase.rpc('mant_alias_revisar', { p_tipo: tipo, p_nombre_norm: a.nombre_norm, p_destino: destino || null, p_nota: a.nota })
    if (error) { toast.error(error.message); return }
    toast.success('Equivalencia revisada'); void load()
  }

  return (
    <div className="space-y-4 pb-10">
      <PageHeader title="Activos y equivalencias" description="Clase, medidor (km u horas), área asignada y baja de cada activo; equivalencias de nombres del historial con los activos y proveedores." />
      <div className="flex flex-wrap items-center gap-2">
        {(['activos', 'equivalencias'] as const).map(t => <button key={t} type="button" onClick={() => setTab(t)} aria-pressed={tab === t}
          className={`rounded-lg px-3 py-2 text-xs font-bold uppercase ${tab === t ? 'bg-[#002855] text-white' : 'border border-slate-300 bg-white text-slate-700'}`}>{t === 'activos' ? 'Activos' : 'Equivalencias e importaciones'}</button>)}
        <button type="button" onClick={() => void load()} className="ml-auto flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold"><RefreshCw className="h-3.5 w-3.5" />Actualizar</button>
        {tab === 'activos' && <button type="button" onClick={() => setEdit({ asset_class: 'MONTACARGAS', meter_type: 'HORAS' })} className="flex items-center gap-1 rounded-lg bg-[#002855] px-3 py-2 text-xs font-semibold text-white"><Plus className="h-3.5 w-3.5" />Registrar activo</button>}
      </div>

      {tab === 'activos' && (activos === null ? <p className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Cargando…</p> :
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white"><table className="w-full min-w-[72rem] text-sm [&_td]:px-2 [&_th]:px-2">
          <thead className="bg-slate-50 text-left text-xs text-slate-600"><tr><th className="py-2">Activo</th><th>Clase</th><th>Marca / modelo</th><th>Año</th><th>Medidor</th><th>Área</th><th>Estado</th>
            <th className="text-right">Registros</th><th className="whitespace-nowrap text-right">Gasto histórico</th><th className="whitespace-nowrap">Última lectura</th><th></th></tr></thead>
          <tbody>{activos.map(a => <tr key={a.id} className={`border-t border-slate-100 ${a.decommissioned_at ? 'text-slate-400' : ''}`}>
            <td className="p-2"><b>{a.display_name || a.plate}</b><span className="block text-xs text-slate-500">{a.plate}{a.serial_number ? ` · serie ${a.serial_number}` : ''}</span></td>
            <td>{claseLabel(a.asset_class)}</td><td className="min-w-[12rem]">{[a.brand, a.model].filter(Boolean).join(' ') || '—'}</td><td>{a.manufacture_year ?? '—'}</td>
            <td className="whitespace-nowrap">{a.meter_type === 'HORAS' ? 'Horómetro (h)' : a.meter_type === 'KM' ? 'Odómetro (km)' : <span className="text-amber-700">Sin definir</span>}</td>
            <td>{a.assigned_area ?? '—'}</td>
            <td>{a.decommissioned_at ? <span title={a.decommission_reason ?? ''}>De baja ({fdate(a.decommissioned_at)})</span> : a.status ?? '—'}</td>
            <td className="text-right tabular-nums">{a.registros}</td><td className="whitespace-nowrap text-right tabular-nums">{soles(a.monto)}</td>
            <td className="whitespace-nowrap text-xs">{a.ultima_lectura ? `${Number(a.ultima_lectura.valor).toLocaleString('es-PE')} · ${fdate(a.ultima_lectura.fecha)}${a.ultima_lectura.obs !== 'OK' ? ` · ${a.ultima_lectura.obs}` : ''}` : '—'}</td>
            <td className="whitespace-nowrap p-2 text-right">
              <button type="button" onClick={() => setLectura(a)} className="mr-2 inline-flex items-center gap-1 text-xs font-semibold text-[#002855]"><Gauge className="h-3.5 w-3.5" />Lectura</button>
              <button type="button" onClick={() => setEdit(a)} className="inline-flex items-center gap-1 text-xs font-semibold text-[#002855]"><Pencil className="h-3.5 w-3.5" />Editar</button></td>
          </tr>)}</tbody>
        </table></div>)}

      {tab === 'equivalencias' && alias && <div className="space-y-4">
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="font-bold text-slate-800">Activos del historial</h2>
          <p className="text-xs text-slate-600">Nombre en el Excel → activo del sistema. Sin activo, sus registros no se atribuyen a ninguna unidad.</p>
          <table className="mt-2 w-full text-sm"><thead className="text-left text-xs text-slate-600"><tr><th className="py-1">Nombre en el Excel</th><th>Activo</th><th className="text-right">Registros</th><th>Estado</th></tr></thead>
            <tbody>{alias.activos.map(a => <tr key={a.nombre_norm} className="border-t border-slate-100">
              <td className="py-1.5">{a.nombre_origen}</td>
              <td><select defaultValue={a.vehicle_id ?? ''} onChange={e => void revisar('ACTIVO', a, e.target.value)} className="h-8 max-w-xs rounded border border-slate-300 bg-white text-xs" aria-label={`Activo para ${a.nombre_origen}`}>
                <option value="">Sin asignar</option>{(activos ?? []).map(v => <option key={v.id} value={v.id}>{v.display_name || v.plate}</option>)}</select></td>
              <td className="text-right tabular-nums">{a.registros}</td><td className="text-xs">{a.revisado ? 'Revisado' : <span className="text-violet-700">Por revisar</span>}</td></tr>)}</tbody></table>
        </section>
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="font-bold text-slate-800">Proveedores</h2>
          <p className="text-xs text-slate-600">Los nombres equivalentes (p. ej. «BECERRA DONAYRES MAURO» y «BECERRA DONAIRES MAURO») apuntan al mismo proveedor. Los creados desde el historial tienen RUC «PENDIENTE-…» para completar.</p>
          <table className="mt-2 w-full text-sm"><thead className="text-left text-xs text-slate-600"><tr><th className="py-1">Nombre en el Excel</th><th>Proveedor</th><th className="text-right">Registros</th><th>Estado</th></tr></thead>
            <tbody>{alias.proveedores.map(a => <tr key={a.nombre_norm} className="border-t border-slate-100">
              <td className="py-1.5">{a.nombre_origen}{a.nota && <span className="block text-[11px] text-amber-700">{a.nota}</span>}</td>
              <td><select defaultValue={a.provider_id ?? ''} onChange={e => void revisar('PROVEEDOR', a, e.target.value)} className="h-8 max-w-xs rounded border border-slate-300 bg-white text-xs" aria-label={`Proveedor para ${a.nombre_origen}`}>
                <option value="">Sin asignar</option>{providers.map(p => <option key={p.id} value={p.id}>{p.business_name}</option>)}</select></td>
              <td className="text-right tabular-nums">{a.registros}</td><td className="text-xs">{a.revisado ? 'Revisado' : <span className="text-violet-700">Por revisar</span>}</td></tr>)}</tbody></table>
        </section>
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="font-bold text-slate-800">Importaciones del historial</h2>
          <table className="mt-2 w-full text-sm"><thead className="text-left text-xs text-slate-600"><tr><th className="py-1">Fecha</th><th>Archivo</th><th className="text-right">Filas</th><th className="text-right">Nuevos</th><th className="text-right">Actualizados</th>
            <th className="text-right">Sin cambio</th><th className="text-right">Dudosos</th><th className="text-right">Rechazados</th><th>Estado</th></tr></thead>
            <tbody>{alias.importaciones.map(i => <tr key={i.id} className="border-t border-slate-100"><td className="py-1.5">{new Date(i.created_at).toLocaleString('es-PE')}</td><td>{i.archivo}</td>
              <td className="text-right">{i.filas}</td><td className="text-right">{i.insertados}</td><td className="text-right">{i.actualizados}</td><td className="text-right">{i.sin_cambio}</td>
              <td className="text-right">{i.dudosos}</td><td className="text-right">{i.rechazados}</td><td>{i.estado}</td></tr>)}</tbody></table>
        </section>
      </div>}

      {edit && <ActivoModal value={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void load() }} />}
      {lectura && <LecturaModal activo={lectura} onClose={() => setLectura(null)} onSaved={() => { setLectura(null); void load() }} />}
    </div>
  )
}

function ActivoModal({ value, onClose, onSaved }: { value: Partial<Activo>; onClose: () => void; onSaved: () => void }) {
  const supabase = useMemo(() => createClient(), [])
  const [f, setF] = useState({
    plate: value.plate ?? '', display_name: value.display_name ?? '', asset_class: value.asset_class ?? 'MONTACARGAS', meter_type: value.meter_type ?? 'HORAS',
    assigned_area: value.assigned_area ?? '', brand: value.brand ?? '', model: value.model ?? '', serial_number: value.serial_number ?? '', internal_code: value.internal_code ?? '',
    manufacture_year: value.manufacture_year?.toString() ?? '', decommissioned_at: value.decommissioned_at ?? '', decommission_reason: value.decommission_reason ?? '',
  })
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    const { error } = await supabase.rpc('mant_activo_guardar', { p: { ...f, id: value.id ?? null } })
    setBusy(false)
    if (error) { toast.error(error.message); return }
    toast.success(value.id ? 'Activo actualizado' : 'Activo registrado'); onSaved()
  }
  const fld = 'h-10 w-full rounded-lg border border-slate-300 px-2 text-sm'
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value })
  return <Modal isOpen onClose={onClose} title={value.id ? `Editar ${value.display_name || value.plate}` : 'Registrar activo'} maxWidth="max-w-2xl"
    footer={<div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-slate-300 px-4 text-sm">Cancelar</button>
      <button type="button" disabled={busy} onClick={() => void save()} className="flex min-h-10 items-center gap-2 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white disabled:opacity-50">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Guardar</button></div>}>
    <div className="grid gap-3 text-sm sm:grid-cols-2">
      <label><span className="mb-1 block text-xs font-semibold text-slate-600">Placa o código *</span><input disabled={!!value.id} value={f.plate} onChange={set('plate')} placeholder="p. ej. ERE120" className={fld} /></label>
      <label><span className="mb-1 block text-xs font-semibold text-slate-600">Nombre</span><input value={f.display_name} onChange={set('display_name')} placeholder="p. ej. Transpaleta eléctrica ERE120" className={fld} /></label>
      <label><span className="mb-1 block text-xs font-semibold text-slate-600">Clase *</span><select value={f.asset_class} onChange={e => setF({ ...f, asset_class: e.target.value, meter_type: e.target.value === 'VEHICULAR' ? 'KM' : 'HORAS' })} className={fld}>
        {CLASES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <label><span className="mb-1 block text-xs font-semibold text-slate-600">Medidor *</span><select value={f.meter_type} onChange={set('meter_type')} className={fld}><option value="KM">Odómetro (km)</option><option value="HORAS">Horómetro (horas)</option></select></label>
      <label><span className="mb-1 block text-xs font-semibold text-slate-600">Área asignada</span><input list="areas-mant" value={f.assigned_area} onChange={set('assigned_area')} className={fld} />
        <datalist id="areas-mant"><option value="Distribución" /><option value="Producción" /><option value="Almacén" /><option value="Mantenimiento" /></datalist></label>
      <label><span className="mb-1 block text-xs font-semibold text-slate-600">Año de fabricación</span><input inputMode="numeric" value={f.manufacture_year} onChange={set('manufacture_year')} className={fld} /></label>
      <label><span className="mb-1 block text-xs font-semibold text-slate-600">Marca</span><input value={f.brand} onChange={set('brand')} className={fld} /></label>
      <label><span className="mb-1 block text-xs font-semibold text-slate-600">Modelo</span><input value={f.model} onChange={set('model')} className={fld} /></label>
      <label><span className="mb-1 block text-xs font-semibold text-slate-600">Serie</span><input value={f.serial_number} onChange={set('serial_number')} className={fld} /></label>
      <label><span className="mb-1 block text-xs font-semibold text-slate-600">Código interno</span><input value={f.internal_code} onChange={set('internal_code')} className={fld} /></label>
      {value.id && <>
        <label><span className="mb-1 block text-xs font-semibold text-slate-600">Fecha de baja</span><input type="date" value={f.decommissioned_at} onChange={set('decommissioned_at')} className={fld} /></label>
        <label><span className="mb-1 block text-xs font-semibold text-slate-600">Motivo de la baja</span><input value={f.decommission_reason} onChange={set('decommission_reason')} className={fld} /></label>
      </>}
    </div>
  </Modal>
}

function LecturaModal({ activo, onClose, onSaved }: { activo: Activo; onClose: () => void; onSaved: () => void }) {
  const supabase = useMemo(() => createClient(), [])
  const [valor, setValor] = useState('')
  const [motivo, setMotivo] = useState('')
  const [pide, setPide] = useState<string | null>(null)
  const save = async () => {
    const { data, error } = await supabase.rpc('mant_registrar_lectura', { p_vehicle: activo.id, p_fecha: new Date().toISOString(), p_valor: Number(valor), p_origen: 'MANUAL', p_motivo: motivo || null })
    if (error) { toast.error(error.message); return }
    if (!data?.success) { setPide(data?.error ?? 'Lectura fuera de rango'); return }
    toast.success('Lectura registrada'); onSaved()
  }
  return <Modal isOpen onClose={onClose} title={`Lectura de ${activo.display_name || activo.plate}`} maxWidth="max-w-md"
    footer={<div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-slate-300 px-4 text-sm">Cancelar</button>
      <button type="button" disabled={!valor} onClick={() => void save()} className="min-h-10 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white disabled:opacity-50">Registrar</button></div>}>
    <div className="space-y-3 text-sm">
      <label className="block"><span className="mb-1 block text-xs font-semibold text-slate-600">{activo.meter_type === 'HORAS' ? 'Horómetro (h)' : 'Odómetro (km)'}</span>
        <input inputMode="decimal" value={valor} onChange={e => { setValor(e.target.value.replace(',', '.')); setPide(null) }} className="h-10 w-full rounded-lg border border-slate-300 px-2" /></label>
      {pide && <><p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900">{pide}</p>
        <label className="block"><span className="mb-1 block text-xs font-semibold text-amber-800">Motivo para confirmar (p. ej. cambio de medidor)</span>
          <input value={motivo} onChange={e => setMotivo(e.target.value)} className="h-10 w-full rounded-lg border border-slate-300 px-2" /></label></>}
    </div>
  </Modal>
}
