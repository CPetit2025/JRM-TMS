'use client'

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Plus, Save, Trash2, Wand2 } from 'lucide-react'
import { aptApi } from '@/lib/apt/api'
import { agingColor, fmtDate, fmtDateTime } from '@/lib/apt/format'
import type { AptSettings } from '@/lib/apt/types'
import { ChartCard } from './ui'

// Parámetros del modelo (fecha de corte, tolerancia, alerta y rangos de aging) y definiciones de cálculo

interface RangeRow { id: number; desde: string; label: string; auto: boolean }

// Etiqueta sugerida según el siguiente “desde”: "a-b días", "n días" o "> n días" (último rango)
function suggestLabels(rows: RangeRow[]): Map<number, string> {
  const valid = rows.map(r => ({ id: r.id, d: Number(r.desde) }))
    .filter(r => r.d >= 0 && Number.isInteger(r.d) && rows.find(x => x.id === r.id)?.desde.trim() !== '')
    .sort((a, b) => a.d - b.d)
  const out = new Map<number, string>()
  valid.forEach((r, i) => {
    const next = valid[i + 1]?.d
    if (next === undefined) out.set(r.id, r.d === 0 ? 'Todos' : `> ${r.d - 1} días`)
    else if (next - 1 <= r.d) out.set(r.id, `${r.d} días`)
    else out.set(r.id, `${r.d}-${next - 1} días`)
  })
  return out
}

function applyAuto(rows: RangeRow[]): RangeRow[] {
  const sug = suggestLabels(rows)
  return rows.map(r => (r.auto && sug.has(r.id) ? { ...r, label: sug.get(r.id)! } : r))
}

let seq = 0
function toRows(ranges: AptSettings['ranges']): RangeRow[] {
  const rows = ranges.map(r => ({ id: ++seq, desde: String(r.desde), label: r.label, auto: false }))
  const sug = suggestLabels(rows)
  return rows.map(r => ({ ...r, auto: sug.get(r.id) === r.label }))
}

function validate(cutoff: string, tol: string, alert: string, rows: RangeRow[]): string[] {
  const errs: string[] = []
  if (cutoff && !/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) errs.push('La fecha de corte no es válida.')
  const t = Number(tol)
  if (tol.trim() === '' || !Number.isFinite(t) || t < 0 || t > 49.9) errs.push('La tolerancia debe estar entre 0 % y 49,9 %.')
  const a = Number(alert)
  if (!Number.isInteger(a) || a < 1) errs.push('Los días de alerta deben ser un entero mayor a 0.')
  if (rows.length < 2 || rows.length > 15) errs.push('Debe haber entre 2 y 15 rangos.')
  const ds = rows.map(r => (r.desde.trim() === '' ? NaN : Number(r.desde)))
  if (ds.some(d => !Number.isInteger(d) || d < 0)) errs.push('Cada “desde” debe ser un número entero de días (0 o más).')
  if (!ds.includes(0)) errs.push('Un rango debe empezar en 0 días.')
  if (new Set(ds).size !== ds.length) errs.push('Hay rangos con el mismo “desde”.')
  if (rows.some(r => !r.label.trim())) errs.push('Todos los rangos necesitan etiqueta.')
  return errs
}

export function SettingsPanel({ data, canLoad }: { data: AptSettings; canLoad: boolean }) {
  const s = data.settings
  const [cutoff, setCutoff] = useState(s.cutoff_date || '')
  const [tol, setTol] = useState(String(Math.round(Number(s.tolerance) * 1000) / 10))
  const [alert, setAlert] = useState(String(s.alert_days))
  const [rows, setRows] = useState<RangeRow[]>(() => toRows(data.ranges))
  const [saving, setSaving] = useState(false)

  const errors = useMemo(() => validate(cutoff, tol, alert, rows), [cutoff, tol, alert, rows])
  const dirty = (cutoff || null) !== (s.cutoff_date || null)
    || Number(tol) !== Math.round(Number(s.tolerance) * 1000) / 10
    || Number(alert) !== s.alert_days
    || JSON.stringify(rows.map(r => [Number(r.desde), r.label.trim()]).sort((a, b) => Number(a[0]) - Number(b[0])))
      !== JSON.stringify(data.ranges.map(r => [r.desde, r.label]))
  const st = data.state
  const outOfData = cutoff && st.data_max && (cutoff > st.data_max || (st.data_min && cutoff < st.data_min))

  const setRange = (id: number, patch: Partial<RangeRow>) => setRows(rs => applyAuto(rs.map(r => (r.id === id ? { ...r, ...patch } : r))))
  const sortRows = () => setRows(rs => [...rs].sort((a, b) => (Number(a.desde) || 0) - (Number(b.desde) || 0)))
  const addRow = () => setRows(rs => {
    const max = Math.max(...rs.map(r => Number(r.desde) || 0), 0)
    return applyAuto([...rs, { id: ++seq, desde: String(max + 30), label: '', auto: true }])
  })

  const save = async () => {
    if (errors.length) return
    setSaving(true)
    try {
      const ranges = [...rows].sort((a, b) => Number(a.desde) - Number(b.desde)).map(r => ({ desde: Number(r.desde), label: r.label.trim() }))
      await aptApi.saveSettings({ cutoff_date: cutoff || null, tolerance: Math.round(Number(tol) * 10) / 1000, alert_days: Number(alert), ranges })
      toast.success('Parámetros guardados', { description: 'El FIFO, los estados y los rangos se recalcularon.' })
      window.dispatchEvent(new Event('apt:updated'))
    } catch (e) {
      toast.error('No se guardaron los parámetros', { description: e instanceof Error ? e.message : undefined })
    } finally {
      setSaving(false)
    }
  }

  const ro = !canLoad
  const input = 'w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm tabular-nums text-slate-800 focus:border-[#002855] focus:outline-none focus:ring-2 focus:ring-[#002855]/15 disabled:bg-slate-50 disabled:text-slate-500'

  return (
    <ChartCard
      title="Parámetros del cálculo"
      subtitle={`Última modificación: ${fmtDateTime(s.updated_at)}${ro ? ' · solo lectura' : ''}`}
      actions={canLoad && (
        <button onClick={save} disabled={saving || !dirty || errors.length > 0}
          className="flex items-center gap-1.5 rounded-lg bg-[#002855] px-3 py-1.5 text-xs font-bold text-white shadow-sm hover:bg-[#0b3d7a] disabled:cursor-not-allowed disabled:opacity-40">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          {saving ? 'Guardando y recalculando…' : 'Guardar'}
        </button>
      )}>
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="text-xs font-bold text-slate-600">Fecha de corte</span>
            <div className="mt-1 flex gap-1">
              <input type="date" value={cutoff} disabled={ro} onChange={e => setCutoff(e.target.value)} className={input} aria-label="Fecha de corte manual" />
              {cutoff && !ro && (
                <button onClick={() => setCutoff('')} className="whitespace-nowrap rounded-lg border border-slate-200 px-2 text-[11px] font-semibold text-slate-500 hover:bg-slate-50">
                  Automática
                </button>
              )}
            </div>
            <span className="mt-1 block text-[11px] leading-snug text-slate-500">
              Vacía = fecha máxima de los datos ({fmtDate(st.data_max)}). Efectiva hoy: <b className="text-slate-700">{fmtDate(st.cutoff)}</b>
              {s.cutoff_date ? ' (manual)' : ' (automática)'}. Los movimientos posteriores al corte no se consideran.
            </span>
            {outOfData && <span className="mt-1 block text-[11px] text-amber-700">Está fuera del rango de datos ({fmtDate(st.data_min)} – {fmtDate(st.data_max)}).</span>}
          </label>
          <label className="block">
            <span className="text-xs font-bold text-slate-600">Tolerancia de despacho (%)</span>
            <input type="number" min={0} max={49.9} step={0.1} value={tol} disabled={ro} onChange={e => setTol(e.target.value)} className={`mt-1 ${input}`} />
            <span className="mt-1 block text-[11px] leading-snug text-slate-500">Una capa con saldo ≤ este % de su ingreso se considera Despachada.</span>
          </label>
          <label className="block">
            <span className="text-xs font-bold text-slate-600">Días de alerta</span>
            <input type="number" min={1} step={1} value={alert} disabled={ro} onChange={e => setAlert(e.target.value)} className={`mt-1 ${input}`} />
            <span className="mt-1 block text-[11px] leading-snug text-slate-500">Sin ninguna salida y más días que esto → “Sin salida identificada”.</span>
          </label>
        </div>

        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-bold text-slate-600">Rangos de aging (días del saldo)</p>
            {!ro && (
              <div className="flex gap-1.5">
                <button onClick={() => setRows(rs => applyAuto(rs.map(r => ({ ...r, auto: true }))))}
                  className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50">
                  <Wand2 className="h-3 w-3" /> Etiquetas automáticas
                </button>
                <button onClick={addRow} disabled={rows.length >= 15}
                  className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40">
                  <Plus className="h-3 w-3" /> Agregar rango
                </button>
              </div>
            )}
          </div>
          <div className="overflow-hidden rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="w-8 px-2 py-1.5" />
                  <th className="w-28 px-2 py-1.5 text-left font-semibold">Desde (días)</th>
                  <th className="px-2 py-1.5 text-left font-semibold">Etiqueta</th>
                  {!ro && <th className="w-10 px-2 py-1.5" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r, i) => (
                  <tr key={r.id}>
                    <td className="px-2 py-1.5"><span className="block h-3 w-3 rounded-sm" style={{ background: agingColor(i, rows.length) }} /></td>
                    <td className="px-2 py-1.5">
                      <input type="number" min={0} step={1} value={r.desde} disabled={ro} aria-label="Desde días"
                        onChange={e => setRange(r.id, { desde: e.target.value })} onBlur={sortRows} className={input} />
                    </td>
                    <td className="px-2 py-1.5">
                      <input value={r.label} disabled={ro} maxLength={40} aria-label="Etiqueta del rango"
                        onChange={e => setRange(r.id, { label: e.target.value, auto: false })} className={`${input} ${r.auto ? 'text-slate-500' : ''}`} />
                    </td>
                    {!ro && (
                      <td className="px-2 py-1.5 text-center">
                        <button onClick={() => setRows(rs => applyAuto(rs.filter(x => x.id !== r.id)))} disabled={rows.length <= 2}
                          aria-label="Eliminar rango" className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!ro && errors.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-[11px] text-red-600">{errors.map(e => <li key={e}>· {e}</li>)}</ul>
          )}
        </div>
      </div>
    </ChartCard>
  )
}

const DEFS: Array<[string, string]> = [
  ['Lote (NumRel padre)', 'ENTRADA usa la columna Lote; si falta, el NumRel de la OP sin su último tramo (16325-S002-033 → 16325-S002). SALIDA usa NumRel; las salidas “ERROR DE CONTRATO” van a su Lote. -S = subcontrato, -E = error de contrato.'],
  ['Clave Lote|Producto', 'Las salidas solo descuentan ingresos del mismo lote y del mismo producto.'],
  ['Peso como base', 'Se usa |PesoTotalProduccido| en KG y TN = KG / 1000. La Cantidad tiene unidades mezcladas y no se suma.'],
  ['FIFO', 'Cada fila de ENTRADA es una capa; las salidas consumen primero las capas más antiguas. El saldo conserva la fecha de su ingreso.'],
  ['Días del saldo', 'Fecha de corte − fecha de ingreso de la capa. Una capa cerrada mide última salida − ingreso.'],
  ['TN×Días', 'Saldo TN × días del saldo: combina volumen y antigüedad; prioriza qué liberar primero.'],
  ['Aging ponderado', 'Σ(TN×Días) / Σ TN de saldo: la antigüedad promedio de cada tonelada que sigue en APT.'],
  ['Estados', 'En APT (sin salidas, dentro de la alerta) · Salida parcial (queda saldo) · Despachado (saldo dentro de la tolerancia) · Sin salida identificada (sin salidas y supera la alerta) · Problema de información (sin peso o salida antes del ingreso).'],
  ['Reemplazo en cada carga', 'Por tipo, una carga borra los movimientos ya cargados cuyo día está dentro del rango de fechas del archivo y deja los de otros días. Así sirve tanto el acumulado como solo el día nuevo. Las filas originales se guardan intactas.'],
]

export function HowItWorks() {
  return (
    <ChartCard title="Cómo se calcula" subtitle="Definiciones usadas en todas las pestañas del módulo">
      <dl className="space-y-2.5">
        {DEFS.map(([t, d]) => (
          <div key={t} className="grid gap-0.5 sm:grid-cols-[150px_1fr] sm:gap-3">
            <dt className="text-xs font-bold text-[#002855]">{t}</dt>
            <dd className="text-xs leading-relaxed text-slate-600">{d}</dd>
          </div>
        ))}
      </dl>
    </ChartCard>
  )
}
