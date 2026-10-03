'use client'

import { Suspense, useEffect, useMemo, useState, type ChangeEvent } from 'react'
import { FileUp, Save } from 'lucide-react'
import { toast } from 'sonner'
import { fecha, fleetApi, fmt, mes } from '@/lib/fleet/api'
import { FLEET_KIND_LABEL, parseFleetWorkbook, type FleetParseResult } from '@/lib/fleet/parseFleetWorkbook'
import { CLASE_LABEL, type FeAsset, type FeClase, type FeDatos, type FeParams } from '@/lib/fleet/types'
import { LoadingBlock, ErrorBlock } from '@/components/apt/ui'
import { Note, Panel } from '@/components/fleet/ui'

// Datos y parámetros: carga del Excel histórico, cobertura por fuente y mes, calidad de los registros,
// parámetros de decisión y ficha de cada activo (capacidad, valor de reposición, vida útil y unidad del TMS)

const CHUNK = 2000

function Carga({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [parsed, setParsed] = useState<FleetParseResult | null>(null)
  const [step, setStep] = useState<string | null>(null)
  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = ''
    if (!f) return
    setFile(f); setParsed(null); setStep('Leyendo el archivo…')
    try {
      const r = parseFleetWorkbook(new Uint8Array(await f.arrayBuffer()))
      if (!r.sheets.length) toast.error('No se reconoció ninguna hoja: se esperan CONSOLIDADO (mantenimiento), KM_Combustible y consolidado rutas')
      setParsed(r)
    } catch (err) { toast.error(err instanceof Error ? err.message : 'No se pudo leer el archivo') }
    finally { setStep(null) }
  }
  const aplicar = async () => {
    if (!file || !parsed) return
    let id: string | null = null
    try {
      setStep('Creando la carga…')
      id = (await fleetApi.uploadBegin(file.name)).id
      for (const s of parsed.sheets) {
        for (let i = 0; i < s.rows.length; i += CHUNK) {
          setStep(`Enviando ${FLEET_KIND_LABEL[s.kind]}: ${fmt(Math.min(i + CHUNK, s.rows.length))} de ${fmt(s.rows.length)}`)
          await fleetApi.uploadRows(id, s.kind, s.rows.slice(i, i + CHUNK))
        }
      }
      setStep('Validando y reemplazando la historia…')
      const r = await fleetApi.uploadApply(id)
      toast.success(`Historia actualizada: ${fmt(r.summary.mantenimiento)} registros de mantenimiento, ${fmt(r.summary.combustible_meses)} meses de combustible y ${fmt(r.summary.viajes)} viajes`)
      setFile(null); setParsed(null); onDone(); window.dispatchEvent(new Event('fe:updated'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo aplicar la carga')
      if (id) fleetApi.uploadDiscard(id).catch(() => undefined)
    } finally { setStep(null) }
  }
  return (
    <Panel title="Cargar historia desde Excel" hint="El archivo reemplaza toda la historia anterior. Desde el mes siguiente al último de cada hoja, el módulo usa los datos del TMS.">
      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg bg-[#cf152d] px-4 text-sm font-bold text-white hover:bg-[#b01226]">
          <FileUp className="h-4 w-4" /> Elegir archivo
          <input type="file" accept=".xlsx,.xls" onChange={pick} className="sr-only" />
        </label>
        {file && <span className="text-sm text-slate-600">{file.name}</span>}
        {step && <span className="text-sm font-semibold text-[#002855]">{step}</span>}
      </div>
      {parsed && (
        <div className="mt-3 space-y-2">
          <div className="grid gap-2 md:grid-cols-3">
            {parsed.sheets.map(s => (
              <div key={s.kind} className="rounded-lg border border-slate-200 p-3 text-sm">
                <p className="font-bold text-slate-800">{FLEET_KIND_LABEL[s.kind]}</p>
                <p className="text-xs text-slate-500">Hoja “{s.sheet}” · {fmt(s.rows.length)} filas · {mes(s.desde)} → {mes(s.hasta)}{s.descartadas ? ` · ${s.descartadas} filas vacías omitidas` : ''}</p>
              </div>
            ))}
          </div>
          {parsed.ignoradas.length > 0 && <Note>Hojas no usadas: {parsed.ignoradas.join(', ')}.</Note>}
          <button type="button" onClick={aplicar} disabled={!!step || !parsed.sheets.length} className="h-9 rounded-lg bg-[#002855] px-4 text-sm font-bold text-white hover:bg-[#0b3d7a] disabled:opacity-50">Aplicar carga</button>
        </div>
      )}
    </Panel>
  )
}

function Cobertura({ d }: { d: FeDatos }) {
  const meses = useMemo(() => Array.from(new Set(d.cobertura.map(c => c.mes))).sort(), [d])
  const codes = useMemo(() => d.activos.filter(a => d.cobertura.some(c => c.code === a.code)).sort((a, b) => a.clase.localeCompare(b.clase) || a.code.localeCompare(b.code)), [d])
  const cell = (code: string, m: string) => d.cobertura.find(c => c.code === code && c.mes === m)
  return (
    <Panel title="Cobertura por mes" hint="K km · C combustible · M mantenimiento · R rutas. Fondo azul: mes completo para costo por km (km, combustible y mantenimiento cubierto).">
      <div className="overflow-x-auto">
        <table className="text-[10px]">
          <thead><tr><th className="sticky left-0 bg-white px-2 py-1 text-left">Activo</th>{meses.map(m => <th key={m} className="px-0.5 py-1 font-mono font-normal text-slate-500">{mes(m)}</th>)}</tr></thead>
          <tbody>
            {codes.map(a => (
              <tr key={a.code}>
                <td className="sticky left-0 whitespace-nowrap bg-white px-2 py-0.5 font-semibold text-slate-700">{a.code}</td>
                {meses.map(m => {
                  const c = cell(a.code, m)
                  const full = !!(c && c.k && c.c && c.mc)
                  const txt = c ? `${c.k ? 'K' : ''}${c.c ? 'C' : ''}${c.m ? 'M' : ''}${c.r ? 'R' : ''}` : ''
                  return <td key={m} title={c ? `${a.code} ${mes(m)} · ${c.f}` : ''} className={`h-5 min-w-[34px] border border-white px-0.5 text-center font-mono ${full ? 'bg-sky-100 text-sky-900' : c ? 'bg-slate-100 text-slate-600' : 'bg-slate-50'}`}>{txt}</td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function Parametros({ d, onSaved }: { d: FeDatos; onSaved: () => void }) {
  const [desde, setDesde] = useState(d.settings.desde.slice(0, 7))
  const [corte, setCorte] = useState(d.settings.corte?.slice(0, 7) ?? '')
  const [p, setP] = useState<FeParams>(d.settings.params)
  const [saving, setSaving] = useState(false)
  const n = (k: keyof FeParams, label: string, step = '1', hint?: string) => (
    <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">{label}
      <input type="number" step={step} value={String(p[k] as number)} onChange={e => setP({ ...p, [k]: Number(e.target.value) })} className="h-9 w-32 rounded-lg border border-slate-200 px-2 text-sm" />
      {hint && <span className="font-normal text-slate-400">{hint}</span>}
    </label>
  )
  const save = async () => {
    setSaving(true)
    try { await fleetApi.saveSettings({ desde: `${desde}-01`, corte: corte ? `${corte}-01` : null, params: p }); toast.success('Parámetros guardados'); onSaved(); window.dispatchEvent(new Event('fe:updated')) }
    catch (e) { toast.error(e instanceof Error ? e.message : 'No se pudo guardar') } finally { setSaving(false) }
  }
  return (
    <Panel title="Parámetros de análisis y decisión" actions={<button type="button" onClick={save} disabled={saving} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#002855] px-3 text-xs font-bold text-white disabled:opacity-50"><Save className="h-3.5 w-3.5" />{saving ? 'Guardando…' : 'Guardar'}</button>}>
      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">Base del análisis (desde)
          <input type="month" value={desde} onChange={e => setDesde(e.target.value)} className="h-9 rounded-lg border border-slate-200 px-2 text-sm" /></label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">Corte Excel → TMS
          <input type="month" value={corte} onChange={e => setCorte(e.target.value)} className="h-9 rounded-lg border border-slate-200 px-2 text-sm" />
          <span className="font-normal text-slate-400">Vacío: cada fuente usa el Excel hasta su último mes</span></label>
        {(['TRANSPORTE', 'MONTACARGA', 'ELEVACION'] as FeClase[]).map(c => (
          <label key={c} className="flex flex-col gap-1 text-xs font-semibold text-slate-600">Vida útil {CLASE_LABEL[c].toLowerCase()} (años)
            <input type="number" value={p.vida_util[c]} onChange={e => setP({ ...p, vida_util: { ...p.vida_util, [c]: Number(e.target.value) } })} className="h-9 w-28 rounded-lg border border-slate-200 px-2 text-sm" /></label>
        ))}
        {n('horas_min_anio', 'Uso mínimo de equipos (h/año)')}
        {n('factor_costo', 'Costo por hora alto (× mediana)', '0.1')}
        {n('factor_tkm', 'Costo por t·km alto (× mediana)', '0.1')}
        {n('tendencia_mant_km', 'Alza de mant. por km (S/ por año)', '0.01')}
        {n('volumen_min', 'Llenado mínimo (0–1)', '0.05')}
      </div>
    </Panel>
  )
}

function Activos({ d, onSaved }: { d: FeDatos; onSaved: () => void }) {
  const [rows, setRows] = useState<FeAsset[]>(d.activos)
  const [dirty, setDirty] = useState<Set<string>>(new Set())
  const upd = (code: string, patch: Partial<FeAsset>) => { setRows(r => r.map(x => (x.code === code ? { ...x, ...patch } : x))); setDirty(s => new Set(s).add(code)) }
  const save = async (a: FeAsset) => {
    try { await fleetApi.saveAsset(a); toast.success(`${a.code} guardado`); setDirty(s => { const n = new Set(s); n.delete(a.code); return n }); onSaved(); window.dispatchEvent(new Event('fe:updated')) }
    catch (e) { toast.error(e instanceof Error ? e.message : 'No se pudo guardar') }
  }
  const num = (v: string) => (v === '' ? null : Number(v))
  const inp = 'h-8 rounded border border-slate-200 px-1.5 text-xs'
  return (
    <Panel title="Ficha de cada activo" hint="La capacidad mejora el control de peso; el valor de reposición y la vida útil afinan la decisión. Vincule cada activo con su unidad del TMS para que los datos nuevos se sumen solos.">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1150px] text-sm">
          <thead className="text-left text-[10px] font-bold uppercase tracking-wider text-slate-500"><tr className="border-b border-slate-200">
            <th className="px-2 py-2">Código</th><th className="px-2 py-2">Clase</th><th className="px-2 py-2">Tipo</th><th className="px-2 py-2">Año fab.</th><th className="px-2 py-2">Capacidad (kg)</th>
            <th className="px-2 py-2">Valor reposición S/</th><th className="px-2 py-2">Vida útil</th><th className="px-2 py-2">Unidad TMS</th><th className="px-2 py-2">Activo</th><th /></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(a => (
              <tr key={a.code}>
                <td className="px-2 py-1.5 font-bold text-[#002855]">{a.code}{a.alias?.length ? <span className="block text-[10px] font-normal text-slate-400">{a.alias.join(', ')}</span> : null}</td>
                <td className="px-2 py-1.5"><select value={a.clase} onChange={e => upd(a.code, { clase: e.target.value as FeClase })} className={inp}>{(['TRANSPORTE', 'MONTACARGA', 'ELEVACION'] as FeClase[]).map(c => <option key={c} value={c}>{CLASE_LABEL[c]}</option>)}</select></td>
                <td className="px-2 py-1.5"><input value={a.tipo ?? ''} onChange={e => upd(a.code, { tipo: e.target.value || null })} className={`${inp} w-40`} /></td>
                <td className="px-2 py-1.5"><input type="number" value={a.anio_fab ?? ''} onChange={e => upd(a.code, { anio_fab: num(e.target.value) })} className={`${inp} w-20`} /></td>
                <td className="px-2 py-1.5"><input type="number" value={a.capacidad_kg ?? ''} onChange={e => upd(a.code, { capacidad_kg: num(e.target.value) })} className={`${inp} w-24`} /></td>
                <td className="px-2 py-1.5"><input type="number" value={a.valor_reposicion ?? ''} onChange={e => upd(a.code, { valor_reposicion: num(e.target.value) })} className={`${inp} w-28`} /></td>
                <td className="px-2 py-1.5"><input type="number" value={a.vida_util ?? ''} placeholder="Clase" onChange={e => upd(a.code, { vida_util: num(e.target.value) })} className={`${inp} w-16`} /></td>
                <td className="px-2 py-1.5"><select value={a.vehicle_plate ?? ''} onChange={e => upd(a.code, { vehicle_plate: e.target.value || null })} className={`${inp} w-32`}>
                  <option value="">Misma placa</option>{d.unidades_tms.map(u => <option key={u.plate} value={u.plate}>{u.plate}{u.type ? ` · ${u.type.toLowerCase()}` : ''}</option>)}</select></td>
                <td className="px-2 py-1.5"><input type="checkbox" checked={a.activo} onChange={e => upd(a.code, { activo: e.target.checked })} className="h-4 w-4 accent-[#002855]" aria-label={`${a.code} activo`} /></td>
                <td className="px-2 py-1.5">{dirty.has(a.code) && <button type="button" onClick={() => save(a)} className="rounded bg-[#002855] px-2 py-1 text-xs font-bold text-white">Guardar</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function Datos() {
  const [res, setRes] = useState<{ data?: FeDatos; error?: string } | null>(null)
  const [n, setN] = useState(0)
  useEffect(() => { let a = true; fleetApi.datos().then(d => a && setRes({ data: d })).catch(e => a && setRes({ error: e.message })); return () => { a = false } }, [n])
  const reload = () => setN(x => x + 1)
  if (!res) return <LoadingBlock label="Cargando datos del módulo…" className="h-80" />
  if (res.error || !res.data) return <ErrorBlock message={res.error || 'Sin datos'} onRetry={reload} />
  const d = res.data
  const calidad = [...(d.calidad_excel ?? []).map(q => ({ ...q, origen: 'Excel' })), ...d.calidad_tms.map(q => ({ ...q, origen: 'TMS' }))]
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 text-xs text-slate-600">
        <span className="rounded-lg bg-slate-100 px-2.5 py-1">Excel hasta → TMS desde: mantenimiento {mes(d.corte.mantenimiento)} · combustible {mes(d.corte.combustible)} · rutas {mes(d.corte.rutas)}{d.corte.manual ? ' (corte fijado)' : ''}</span>
        {d.cargas[0] && <span className="rounded-lg bg-slate-100 px-2.5 py-1">Última carga: {d.cargas[0].archivo} · {fecha(d.cargas[0].fecha)} · {d.cargas[0].estado.toLowerCase()}</span>}
      </div>
      {d.can_load && <Carga onDone={reload} />}
      <Panel title="Calidad de los datos" hint="Excel: lo corregido al cargar. TMS: registros que faltan para calcular los meses nuevos.">
        {calidad.length ? (
          <div className="overflow-x-auto"><table className="w-full min-w-[700px] text-sm">
            <thead className="text-left text-[10px] font-bold uppercase tracking-wider text-slate-500"><tr className="border-b border-slate-200"><th className="px-2 py-2">Origen</th><th className="px-2 py-2">Fuente</th><th className="px-2 py-2">Hallazgo</th><th className="px-2 py-2 text-right">Casos</th><th className="px-2 py-2">Efecto</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{calidad.map((q, i) => (
              <tr key={i}><td className="px-2 py-2 text-xs font-bold">{q.origen}</td><td className="px-2 py-2">{q.fuente}</td><td className="px-2 py-2">{q.problema}</td>
                <td className="px-2 py-2 text-right font-mono">{fmt(q.casos)}</td><td className="px-2 py-2 text-xs text-slate-600">{q.efecto ?? q.tratamiento}</td></tr>))}</tbody>
          </table></div>
        ) : <Note>Sin observaciones.</Note>}
      </Panel>
      <Cobertura d={d} />
      {d.can_load ? <><Parametros key={d.settings.updated_at} d={d} onSaved={reload} /><Activos key={`a-${n}`} d={d} onSaved={reload} /></> : (
        <Note>Para cargar datos, editar parámetros o la ficha de los activos se requiere el permiso “Eficiencia de Flota — carga y parámetros”.</Note>
      )}
      {d.lecturas.length > 0 && (
        <Panel title="Últimas lecturas de horómetro">
          <div className="flex flex-wrap gap-2 text-xs">{d.lecturas.map((l, i) => <span key={i} className="rounded-lg bg-slate-100 px-2 py-1"><b>{l.code}</b> · {fmt(l.horas)} h · {fecha(l.fecha)}</span>)}</div>
        </Panel>
      )}
      {d.cargas.length > 0 && (
        <Panel title="Historial de cargas">
          <ul className="space-y-1 text-sm">{d.cargas.map(c => <li key={c.id}><b>{c.archivo}</b> · {fecha(c.fecha)} · {c.estado.toLowerCase()}{c.resumen ? ` · ${fmt(c.resumen.mantenimiento)} mant. · ${fmt(c.resumen.combustible_meses)} meses comb. · ${fmt(c.resumen.viajes)} viajes` : ''}</li>)}</ul>
        </Panel>
      )}
    </div>
  )
}

export default function DatosPage() {
  return <Suspense fallback={<LoadingBlock className="h-80" />}><Datos /></Suspense>
}
