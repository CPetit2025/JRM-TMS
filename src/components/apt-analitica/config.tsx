'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Save } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { suggestClass } from '@/lib/apt-analitica/catalog'
import { AREA_LABEL, CLASS_LABEL, type Area, type DocClass, type LinkKind, type LinkOrigin } from '@/lib/apt-analitica/types'
import { useAnalitica } from './context'
import { Card, Empty, Notice, fmtDateTime, fmtNum } from './ui'

// Configuración: mapeo de áreas y clases de documento (administración), equivalencias de unidades verificadas,
// metodología, vínculos de trazabilidad (operación) y auditoría de cambios.

const KINDS: LinkKind[] = ['LOTE', 'TRASPASO', 'OT', 'OP', 'PEDIDO', 'CONTRATO', 'DESPACHO', 'RECEPCION']
const ORIGIN_LABEL: Record<LinkOrigin, string> = { SISTEMA: 'Sistema fuente', REGLA: 'Regla verificada', MANUAL: 'Asignación manual' }

export function ConfigTab() {
  const { meta, reload, base } = useAnalitica()
  const supabase = useMemo(() => createClient(), [])
  const admin = !!meta?.can_admin, operate = !!meta?.can_operate
  const call = async (fn: string, args: Record<string, unknown>, ok: string) => {
    const { error } = await supabase.rpc(fn, args)
    if (error) { toast.error(error.message); return false }
    toast.success(ok); await reload(); return true
  }
  const seenTipos = useMemo(() => [...new Set(base.all.map(m => m.tipo).filter(Boolean))].sort(), [base])
  const classRows = useMemo(() => {
    const saved = new Map((meta?.class_rows ?? []).map(c => [c.tipo, c]))
    const all = [...new Set([...saved.keys(), ...seenTipos.map(t => t.replace(/\s+/g, ' ').trim().toUpperCase())])].sort()
    return all.map(t => saved.get(t) ?? { tipo: t, clase: suggestClass(t), confirmed: false, suggested: true as const })
  }, [meta, seenTipos])
  const bodegas = useMemo(() => {
    const saved = new Map((meta?.areas ?? []).map(a => [a.bodega, a]))
    for (const b of meta?.bodegas_sin_area ?? []) if (!saved.has(b)) saved.set(b, { bodega: b, area: null, confirmed: false, note: null })
    return [...saved.values()].sort((a, b) => (a.area ? 0 : 1) - (b.area ? 0 : 1) || a.bodega.localeCompare(b.bodega))
  }, [meta])

  return <div className="space-y-4">
    {!admin && <Notice>El mapeo de áreas, la clasificación de documentos, las equivalencias de unidades y la metodología solo los cambia un administrador (permiso apt-admin). Usted puede consultarlos.</Notice>}
    <Card title="Bodegas y áreas" subtitle="Bodega (mayúsculas, espacios simples) → área del análisis. Una asociación no confirmada se muestra como pendiente de confirmación del negocio.">
      <div className="max-h-96 overflow-auto"><table className="w-full min-w-[40rem] text-xs">
        <thead className="sticky top-0 bg-white"><tr className="text-left text-slate-600"><th className="py-1">Bodega</th><th>Área</th><th>Confirmada</th><th>Nota</th><th></th></tr></thead>
        <tbody>{bodegas.map(a => <AreaRow key={a.bodega} row={a} admin={admin} onSave={(area, confirmed, note) => call('apa_area_set', { p_bodega: a.bodega, p_area: area, p_confirmed: confirmed, p_note: note }, 'Mapeo actualizado')} />)}</tbody>
      </table></div>
    </Card>

    <Card title="Clases de documento" subtitle="Define qué es producción, traspaso, despacho de ventas, consumo… Los traspasos no cuentan como producción ni ventas; un despacho no es una entrega.">
      <div className="max-h-96 overflow-auto"><table className="w-full min-w-[36rem] text-xs">
        <thead className="sticky top-0 bg-white"><tr className="text-left text-slate-600"><th className="py-1">TipoDocto</th><th>Clase</th><th>Estado</th><th></th></tr></thead>
        <tbody>{classRows.map(c => <ClassRow key={c.tipo} row={c} admin={admin} onSave={(clase, confirmed) => call('apa_class_set', { p_tipo: c.tipo, p_clase: clase, p_confirmed: confirmed }, 'Clase actualizada')} />)}</tbody>
      </table></div>
    </Card>

    <div className="grid gap-4 xl:grid-cols-2">
      <Conversions admin={admin} call={call} units={base.units} />
      <Methodology admin={admin} call={call} />
    </div>
    <Links operate={operate} admin={admin} call={call} />
    <Audit />
  </div>
}

function AreaRow({ row, admin, onSave }: { row: { bodega: string; area: Area | null; confirmed: boolean; note?: string | null }; admin: boolean; onSave: (a: Area | null, c: boolean, n: string) => Promise<boolean> }) {
  const [area, setArea] = useState<Area | ''>(row.area ?? '')
  const [conf, setConf] = useState(row.confirmed)
  const [note, setNote] = useState(row.note ?? '')
  const dirty = (area || null) !== row.area || conf !== row.confirmed || note !== (row.note ?? '')
  return <tr className="border-t border-slate-100">
    <td className="py-1.5 font-medium">{row.bodega}</td>
    <td><select disabled={!admin} value={area} onChange={e => setArea(e.target.value as Area | '')} className="h-8 rounded border border-slate-300 bg-white px-1 disabled:bg-slate-50" aria-label={`Área de ${row.bodega}`}>
      <option value="">Fuera del análisis</option>{(['APT', 'APT_LB', 'DIST'] as Area[]).map(a => <option key={a} value={a}>{AREA_LABEL[a]}</option>)}</select></td>
    <td><label className="flex items-center gap-1"><input type="checkbox" disabled={!admin} checked={conf} onChange={e => setConf(e.target.checked)} />{conf ? 'Confirmada' : <span className="font-semibold text-violet-800">Pendiente de confirmación</span>}</label></td>
    <td><input disabled={!admin} value={note} onChange={e => setNote(e.target.value)} className="h-8 w-full rounded border border-slate-300 px-1 disabled:bg-slate-50" aria-label={`Nota de ${row.bodega}`} /></td>
    <td>{admin && dirty && <button type="button" onClick={() => void onSave(area || null, conf, note)} className="flex items-center gap-1 font-semibold text-[#002855]"><Save className="h-3.5 w-3.5" aria-hidden />Guardar</button>}</td>
  </tr>
}

function ClassRow({ row, admin, onSave }: { row: { tipo: string; clase: DocClass; confirmed: boolean; suggested?: true }; admin: boolean; onSave: (c: DocClass, conf: boolean) => Promise<boolean> }) {
  const [clase, setClase] = useState<DocClass>(row.clase)
  const [conf, setConf] = useState(row.confirmed)
  const dirty = clase !== row.clase || conf !== row.confirmed || !!row.suggested
  return <tr className="border-t border-slate-100">
    <td className="py-1.5 font-medium">{row.tipo}</td>
    <td><select disabled={!admin} value={clase} onChange={e => setClase(e.target.value as DocClass)} className="h-8 rounded border border-slate-300 bg-white px-1 disabled:bg-slate-50" aria-label={`Clase de ${row.tipo}`}>
      {(Object.keys(CLASS_LABEL) as DocClass[]).map(c => <option key={c} value={c}>{CLASS_LABEL[c]}</option>)}</select></td>
    <td>{row.suggested ? <span className="text-violet-800">Sugerida (sin guardar)</span> : <label className="flex items-center gap-1"><input type="checkbox" disabled={!admin} checked={conf} onChange={e => setConf(e.target.checked)} />{conf ? 'Confirmada' : 'Por confirmar'}</label>}</td>
    <td>{admin && dirty && <button type="button" onClick={() => void onSave(clase, row.suggested ? false : conf)} className="flex items-center gap-1 font-semibold text-[#002855]"><Save className="h-3.5 w-3.5" aria-hidden />Guardar</button>}</td>
  </tr>
}

type Call = (fn: string, args: Record<string, unknown>, ok: string) => Promise<boolean>

function Conversions({ admin, call, units }: { admin: boolean; call: Call; units: string[] }) {
  const { meta } = useAnalitica()
  const [f, setF] = useState({ producto: '', fromUnit: units[1] ?? 'CIEN', toUnit: units[0] ?? 'UND', factor: '', verified: false, note: '' })
  return <Card title="Equivalencias de unidades" subtitle="Solo las verificadas se usan para convertir. Sin equivalencia, cada unidad se muestra por separado.">
    {(meta?.conversions ?? []).length === 0 ? <Empty title="Sin equivalencias registradas" /> : <ul className="space-y-1 text-xs">
      {meta!.conversions.map(c => <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 px-2 py-1">
        <span>1 {c.fromUnit} = <b>{fmtNum(Number(c.factor), 6)}</b> {c.toUnit} · {c.producto ?? 'todos los productos'} · {c.verified ? <b className="text-emerald-800">verificada</b> : <span className="text-amber-800">sin verificar (no se usa)</span>}</span>
        {admin && <span className="flex gap-2">{!c.verified && <button type="button" className="font-semibold text-[#002855]" onClick={() => void call('apa_conversion_save', { p: { ...c, verified: true } }, 'Equivalencia verificada')}>Marcar verificada</button>}
          <button type="button" className="text-[#cf152d]" onClick={() => void call('apa_conversion_delete', { p_id: c.id }, 'Equivalencia eliminada')}>Eliminar</button></span>}
      </li>)}</ul>}
    {admin && <form className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3" onSubmit={e => { e.preventDefault(); void call('apa_conversion_save', { p: { ...f, factor: Number(f.factor) } }, 'Equivalencia registrada') }}>
      <input value={f.producto} onChange={e => setF({ ...f, producto: e.target.value })} placeholder="Producto (vacío = todos)" className="h-8 rounded border border-slate-300 px-2" aria-label="Producto" />
      <input value={f.fromUnit} onChange={e => setF({ ...f, fromUnit: e.target.value.toUpperCase() })} placeholder="De unidad" className="h-8 rounded border border-slate-300 px-2" aria-label="De unidad" />
      <input value={f.toUnit} onChange={e => setF({ ...f, toUnit: e.target.value.toUpperCase() })} placeholder="A unidad" className="h-8 rounded border border-slate-300 px-2" aria-label="A unidad" />
      <input value={f.factor} onChange={e => setF({ ...f, factor: e.target.value })} inputMode="decimal" placeholder="Factor (1 de = factor a)" className="h-8 rounded border border-slate-300 px-2" aria-label="Factor" />
      <input value={f.note} onChange={e => setF({ ...f, note: e.target.value })} placeholder="Fuente de la verificación" className="h-8 rounded border border-slate-300 px-2" aria-label="Fuente" />
      <label className="flex items-center gap-1"><input type="checkbox" checked={f.verified} onChange={e => setF({ ...f, verified: e.target.checked })} />Verificada</label>
      <button type="submit" disabled={!(Number(f.factor) > 0)} className="col-span-2 flex h-8 items-center justify-center gap-1 rounded bg-[#002855] font-semibold text-white disabled:opacity-50 sm:col-span-1"><Plus className="h-3.5 w-3.5" aria-hidden />Agregar</button>
    </form>}
  </Card>
}

function Methodology({ admin, call }: { admin: boolean; call: Call }) {
  const { settings } = useAnalitica()
  const [order, setOrder] = useState(settings.sameDayOrder)
  const [buckets, setBuckets] = useState(settings.ageBuckets.join(', '))
  const [ref, setRef] = useState(settings.defaultRefDate)
  const [note, setNote] = useState('')
  return <Card title="Metodología" subtitle="Hipótesis que afectan las estimaciones. Cada cambio queda auditado.">
    <div className="space-y-3 text-xs">
      <fieldset disabled={!admin}><legend className="font-semibold">Orden de movimientos de una misma fecha (FIFO)</legend>
        <label className="mt-1 flex items-center gap-2"><input type="radio" checked={order === 'ENTRADAS_PRIMERO'} onChange={() => setOrder('ENTRADAS_PRIMERO')} />Entradas antes que salidas (por defecto)</label>
        <label className="flex items-center gap-2"><input type="radio" checked={order === 'SALIDAS_PRIMERO'} onChange={() => setOrder('SALIDAS_PRIMERO')} />Salidas antes que entradas (conservador)</label>
        <p className="mt-1 text-slate-600">Los reportes solo traen fecha: las diferencias se miden en días calendario. Dentro de un mismo lado se respeta el orden del archivo.</p></fieldset>
      <label className="block"><span className="font-semibold">Rangos de antigüedad (límites inferiores en días)</span>
        <input disabled={!admin} value={buckets} onChange={e => setBuckets(e.target.value)} className="mt-1 h-8 w-full rounded border border-slate-300 px-2 disabled:bg-slate-50" /></label>
      <label className="block"><span className="font-semibold">Valor predeterminado de RefFecha (no se usa para permanencia)</span>
        <input disabled={!admin} type="date" value={ref} onChange={e => setRef(e.target.value)} className="mt-1 h-8 rounded border border-slate-300 px-2 disabled:bg-slate-50" /></label>
      {admin && <><input value={note} onChange={e => setNote(e.target.value)} placeholder="Motivo del cambio" className="h-8 w-full rounded border border-slate-300 px-2" aria-label="Motivo del cambio" />
        <button type="button" onClick={() => void call('apa_settings_set', { p: { sameDayOrder: order, ageBuckets: buckets.split(/[,\s]+/).filter(Boolean), defaultRefDate: ref, note } }, 'Metodología actualizada')}
          className="flex h-8 items-center gap-1 rounded bg-[#002855] px-3 font-semibold text-white"><Save className="h-3.5 w-3.5" aria-hidden />Guardar metodología</button></>}
    </div>
  </Card>
}

function Links({ operate, admin, call }: { operate: boolean; admin: boolean; call: Call }) {
  const { meta } = useAnalitica()
  const [f, setF] = useState({ fromKind: 'LOTE' as LinkKind, fromRef: '', toKind: 'LOTE' as LinkKind, toRef: '', qty: '', unidad: '', origin: 'MANUAL' as LinkOrigin, rule: '', note: '' })
  const links = meta?.links ?? []
  return <Card title="Equivalencias de trazabilidad" subtitle="Lote origen → traspaso → lote/asignación destino → OT/pedido → despacho → recepción. Admite cantidades parciales, divisiones y consolidaciones (varios vínculos). Cada vínculo indica su origen y conserva historial.">
    {links.length === 0 ? <Empty title="Sin vínculos registrados">Los cambios de lote en traspasos aparecen como vínculos inferidos en Trazabilidad hasta que se registren aquí.</Empty>
      : <div className="max-h-80 overflow-auto"><table className="w-full min-w-[44rem] text-xs">
        <thead className="sticky top-0 bg-white"><tr className="text-left text-slate-600"><th className="py-1">Desde</th><th>Hacia</th><th className="text-right">Cantidad</th><th>Origen</th><th>Nota</th><th>Estado</th><th></th></tr></thead>
        <tbody>{links.map(l => <tr key={l.id} className={`border-t border-slate-100 ${l.status === 'ANULADO' ? 'text-slate-400 line-through' : ''}`}>
          <td className="py-1">{l.fromKind} <b>{l.fromRef}</b></td><td>{l.toKind} <b>{l.toRef}</b></td><td className="text-right tabular-nums">{l.qty ? `${fmtNum(Number(l.qty))} ${l.unidad ?? ''}` : 'total'}</td>
          <td>{ORIGIN_LABEL[l.origin]}{l.rule ? ` · ${l.rule}` : ''}</td><td className="max-w-[14rem] truncate" title={l.note ?? ''}>{l.note}</td><td>{l.status === 'VIGENTE' ? 'Vigente' : 'Anulado'}</td>
          <td>{operate && l.status === 'VIGENTE' && <button type="button" className="text-[#cf152d]" onClick={() => { const r = window.prompt('Motivo de la anulación'); if (r) void call('apa_link_annul', { p_id: l.id, p_reason: r }, 'Vínculo anulado') }}>Anular</button>}</td>
        </tr>)}</tbody></table></div>}
    {operate && <form className="mt-3 grid grid-cols-2 gap-2 text-xs md:grid-cols-4" onSubmit={e => { e.preventDefault(); void call('apa_link_save', { p: f }, 'Vínculo registrado') }}>
      <select value={f.fromKind} onChange={e => setF({ ...f, fromKind: e.target.value as LinkKind })} className="h-8 rounded border border-slate-300 bg-white" aria-label="Tipo de origen">{KINDS.map(k => <option key={k}>{k}</option>)}</select>
      <input value={f.fromRef} onChange={e => setF({ ...f, fromRef: e.target.value })} placeholder="Referencia de origen" className="h-8 rounded border border-slate-300 px-2" aria-label="Referencia de origen" />
      <select value={f.toKind} onChange={e => setF({ ...f, toKind: e.target.value as LinkKind })} className="h-8 rounded border border-slate-300 bg-white" aria-label="Tipo de destino">{KINDS.map(k => <option key={k}>{k}</option>)}</select>
      <input value={f.toRef} onChange={e => setF({ ...f, toRef: e.target.value })} placeholder="Referencia de destino" className="h-8 rounded border border-slate-300 px-2" aria-label="Referencia de destino" />
      <input value={f.qty} onChange={e => setF({ ...f, qty: e.target.value })} inputMode="decimal" placeholder="Cantidad (vacío = total)" className="h-8 rounded border border-slate-300 px-2" aria-label="Cantidad" />
      <input value={f.unidad} onChange={e => setF({ ...f, unidad: e.target.value.toUpperCase() })} placeholder="Unidad" className="h-8 rounded border border-slate-300 px-2" aria-label="Unidad" />
      <select value={f.origin} onChange={e => setF({ ...f, origin: e.target.value as LinkOrigin })} className="h-8 rounded border border-slate-300 bg-white" aria-label="Origen del vínculo">
        <option value="MANUAL">Asignación manual</option>{admin && <option value="REGLA">Regla verificada</option>}<option value="SISTEMA">Sistema fuente</option></select>
      <input value={f.note} onChange={e => setF({ ...f, note: e.target.value })} placeholder="Nota / sustento" className="h-8 rounded border border-slate-300 px-2" aria-label="Nota" />
      <button type="submit" disabled={!f.fromRef.trim() || !f.toRef.trim()} className="col-span-2 flex h-8 items-center justify-center gap-1 rounded bg-[#002855] font-semibold text-white disabled:opacity-50 md:col-span-1"><Plus className="h-3.5 w-3.5" aria-hidden />Registrar vínculo</button>
    </form>}
  </Card>
}

function Audit() {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<Array<{ id: number; entity: string; entity_id: string; action: string; note: string | null; at: string; by: string | null }>>([])
  const load = useCallback(async () => { const { data } = await supabase.rpc('apa_audit_list', { p_entity: null, p_entity_id: null, p_limit: 100 }); setRows((data ?? []) as never) }, [supabase])
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) }, [load])
  return <Card title="Auditoría" subtitle="Cargas, reversiones, revisiones, equivalencias y cambios de configuración (últimos 100)">
    {rows.length === 0 ? <Empty title="Sin registros" /> : <div className="max-h-72 overflow-auto"><table className="w-full min-w-[36rem] text-xs">
      <thead className="sticky top-0 bg-white"><tr className="text-left text-slate-600"><th className="py-1">Fecha</th><th>Usuario</th><th>Elemento</th><th>Acción</th><th>Nota</th></tr></thead>
      <tbody>{rows.map(r => <tr key={r.id} className="border-t border-slate-100"><td className="whitespace-nowrap py-1">{fmtDateTime(r.at)}</td><td>{r.by ?? '—'}</td>
        <td>{r.entity} <span className="text-slate-500">{r.entity_id?.slice(0, 24)}</span></td><td>{r.action}</td><td className="max-w-[18rem] truncate" title={r.note ?? ''}>{r.note}</td></tr>)}</tbody>
    </table></div>}
  </Card>
}
