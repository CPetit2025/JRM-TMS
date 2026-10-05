'use client'

import { Fragment, Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight, Loader2, Save, ShieldAlert } from 'lucide-react'
import { fleetApi, fmt, mes, soles } from '@/lib/fleet/api'
import { CLASE_LABEL, GRUPO_LABEL, IPR_CATEGORIAS, type FeIpr, type FeIprActivo, type FeIprCategoria, type FeIprFactorCodigo, type FeRecambios } from '@/lib/fleet/types'
import { LoadingBlock, ErrorBlock, EmptyState } from '@/components/apt/ui'
import { ConfianzaPill, Panel, useFeFilters, useFeQuery } from '@/components/fleet/ui'

// Recambios: Índice de Prioridad de Recambio (IPR) — fe_ipr, migración 20261006140000.
// Combina factores técnicos, económicos y operativos (no solo la antigüedad) en un puntaje 0–100 por unidad.
// La pregunta que responde: ¿qué unidad genera mayor costo para producir cada unidad de transporte y además presenta
// deterioro técnico creciente? Debajo, la historia de actividad de cada activo.

const CAT: Record<FeIprCategoria, { color: string; chip: string; rango: string; accion: string }> = {
  'Recambio prioritario': { color: '#cf152d', chip: 'bg-red-100 text-red-800 border-red-200', rango: '80–100', accion: 'Reemplazar en el próximo presupuesto' },
  'Programar recambio': { color: '#ea580c', chip: 'bg-orange-100 text-orange-800 border-orange-200', rango: '60–79', accion: 'Incluir en el plan de 12 a 24 meses' },
  'Monitorear': { color: '#d97706', chip: 'bg-amber-50 text-amber-800 border-amber-200', rango: '40–59', accion: 'Seguimiento trimestral' },
  'Conservar': { color: '#10b981', chip: 'bg-emerald-50 text-emerald-800 border-emerald-200', rango: '0–39', accion: 'Mantener en operación' },
  'Datos insuficientes': { color: '#94a3b8', chip: 'bg-slate-100 text-slate-600 border-slate-200', rango: '—', accion: 'Completar datos antes de decidir' },
}
const FACTOR_ORDEN: FeIprFactorCodigo[] = ['mantenimiento', 'disponibilidad', 'fallas', 'antiguedad', 'kilometraje', 'consumo', 'costo_km', 'productividad', 'seguridad', 'obsolescencia', 'adecuacion']
const FACTOR_CORTO: Record<FeIprFactorCodigo, string> = {
  mantenimiento: 'Costo de mantenimiento', disponibilidad: 'Disponibilidad', fallas: 'Frecuencia de fallas', antiguedad: 'Antigüedad', kilometraje: 'Kilometraje',
  consumo: 'Consumo de combustible', costo_km: 'Costo por km', productividad: 'Productividad (S/ por t)', seguridad: 'Seguridad / criticidad',
  obsolescencia: 'Obsolescencia (manual)', adecuacion: 'Adecuación a la operación (manual)',
}

function CatPill({ c }: { c: FeIprCategoria }) {
  return <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-bold ${CAT[c].chip}`}>{c}</span>
}
const nombreUnidad = (a: FeIprActivo) => [a.clase === 'TRANSPORTE' ? GRUPO_LABEL[a.grupo] : CLASE_LABEL[a.clase], a.marca, a.anio_fab].filter(Boolean).join(' · ')
// Aporte de cada factor al IPR (puntos del índice)
const aportes = (a: FeIprActivo) => {
  const con = a.factores.filter(f => f.puntaje != null && f.peso > 0)
  const tot = con.reduce((s, f) => s + f.peso, 0)
  return con.map(f => ({ ...f, aporte: tot ? (Number(f.puntaje) * f.peso) / tot : 0 })).sort((x, y) => y.aporte - x.aporte)
}
const valorTxt = (f: { valor: number | null; unidad: string }) => {
  if (f.valor == null) return 'sin dato'
  if (f.unidad === '%') return `${fmt(f.valor, 1)} %`
  if (f.unidad.startsWith('S/')) return `S/ ${fmt(f.valor, f.unidad === 'S/ al año' ? 0 : 2)} ${f.unidad.replace('S/ ', '')}`
  return `${fmt(f.valor)} ${f.unidad}`
}

// Ranking del IPR con las cuatro bandas de decisión
function Ranking({ A }: { A: FeIprActivo[] }) {
  const L = A.filter(a => a.ipr != null)
  const ROW = 26, LBL = 230, W = 900, R = 70
  const plotW = W - LBL - R
  const x = (v: number) => LBL + (v / 100) * plotW
  const H = L.length * ROW + 40
  const bandas: Array<[number, number, string, string]> = [[0, 40, '#ecfdf5', 'Conservar'], [40, 60, '#fffbeb', 'Monitorear'], [60, 80, '#fff7ed', 'Programar recambio'], [80, 100, '#fef2f2', 'Recambio prioritario']]
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="min-w-[640px]" role="img" aria-label="Índice de prioridad de recambio por unidad">
        {bandas.map(([a, b, c, t]) => (
          <g key={t}>
            <rect x={x(a)} y={18} width={x(b) - x(a)} height={H - 36} fill={c} />
            <text x={(x(a) + x(b)) / 2} y={12} textAnchor="middle" className="fill-slate-500" style={{ fontSize: 10, fontWeight: 700 }}>{t}</text>
            <text x={x(a)} y={H - 6} textAnchor="middle" className="fill-slate-400" style={{ fontSize: 10 }}>{a}</text>
          </g>
        ))}
        <text x={x(100)} y={H - 6} textAnchor="middle" className="fill-slate-400" style={{ fontSize: 10 }}>100</text>
        {L.map((a, i) => {
          const y = 22 + i * ROW
          const v = Number(a.ipr)
          return (
            <g key={a.code}>
              <text x={LBL - 8} y={y + 12} textAnchor="end" className="fill-slate-800" style={{ fontSize: 11, fontWeight: 700 }}>{a.code.length > 28 ? `${a.code.slice(0, 27)}…` : a.code}</text>
              <text x={LBL - 8} y={y + 22} textAnchor="end" className="fill-slate-400" style={{ fontSize: 8.5 }}>{nombreUnidad(a)}</text>
              <rect x={x(0)} y={y + 4} width={Math.max(2, x(v) - x(0))} height={14} rx={3} fill={CAT[a.categoria].color} opacity={a.categoria === 'Datos insuficientes' ? 0.5 : 0.9} />
              <text x={x(v) + 6} y={y + 15} className="fill-slate-900" style={{ fontSize: 11, fontWeight: 800 }}>{fmt(v)}</text>
              {a.piso_seguridad != null && <text x={x(v) + 30} y={y + 15} className="fill-[#cf152d]" style={{ fontSize: 10, fontWeight: 700 }}>⚠ seguridad</text>}
              <title>{`${a.code}: IPR ${fmt(v)} · ${a.categoria}. Principales factores: ${aportes(a).slice(0, 3).map(f => `${FACTOR_CORTO[f.codigo]} (+${fmt(f.aporte)})`).join(', ')}`}</title>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// Matriz: costo para producir (eje vertical) vs deterioro técnico (eje horizontal)
function Matriz({ A, onVer }: { A: FeIprActivo[]; onVer: (code: string) => void }) {
  const L = A.filter(a => a.ipr_tecnico != null && a.ipr_economico != null)
  const W = 640, H = 420, P = 46
  const x = (v: number) => P + (v / 100) * (W - P - 16)
  const y = (v: number) => H - P - (v / 100) * (H - P - 16)
  const [hover, setHover] = useState<string | null>(null)
  const cuad: Array<[number, number, string, string, string]> = [
    [50, 100, 'Recambio: caro y deteriorado', '#fef2f2', 'text-red-700'], [0, 100, 'Caro pero sano: revisar asignación y operación', '#fffbeb', 'text-amber-800'],
    [50, 50, 'Deteriorado pero eficiente: programar', '#fff7ed', 'text-orange-800'], [0, 50, 'Conservar', '#ecfdf5', 'text-emerald-800'],
  ]
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,640px)_1fr]">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Matriz de costo para producir frente a deterioro técnico">
        {cuad.map(([cx, cy, t, c]) => (
          <g key={t}>
            <rect x={x(cx)} y={y(cy)} width={x(cx + 50) - x(cx)} height={y(cy - 50) - y(cy)} fill={c} />
            <text x={x(cx) + 8} y={y(cy) + 16} style={{ fontSize: 11, fontWeight: 700 }} className="fill-slate-600">{t}</text>
          </g>
        ))}
        <line x1={x(50)} x2={x(50)} y1={y(100)} y2={y(0)} stroke="#94a3b8" strokeDasharray="4 3" />
        <line x1={x(0)} x2={x(100)} y1={y(50)} y2={y(50)} stroke="#94a3b8" strokeDasharray="4 3" />
        {[0, 25, 50, 75, 100].map(t => (
          <g key={t}>
            <text x={x(t)} y={H - P + 16} textAnchor="middle" className="fill-slate-400" style={{ fontSize: 10 }}>{t}</text>
            <text x={P - 8} y={y(t) + 3} textAnchor="end" className="fill-slate-400" style={{ fontSize: 10 }}>{t}</text>
          </g>
        ))}
        <text x={(x(0) + x(100)) / 2} y={H - 8} textAnchor="middle" className="fill-slate-600" style={{ fontSize: 11, fontWeight: 700 }}>Deterioro técnico → (fallas, disponibilidad, seguridad, edad, km, tendencia del mantenimiento)</text>
        <text transform={`translate(12 ${(y(0) + y(100)) / 2}) rotate(-90)`} textAnchor="middle" className="fill-slate-600" style={{ fontSize: 11, fontWeight: 700 }}>Costo para producir → (S/ por km, por t, consumo)</text>
        {L.map(a => {
          const cx = x(Number(a.ipr_tecnico)), cy = y(Number(a.ipr_economico))
          const on = hover === a.code
          return (
            <g key={a.code} onMouseEnter={() => setHover(a.code)} onMouseLeave={() => setHover(null)} onClick={() => onVer(a.code)} className="cursor-pointer">
              <circle cx={cx} cy={cy} r={on ? 9 : 7} fill={CAT[a.categoria].color} stroke="#fff" strokeWidth={2} />
              {(on || Number(a.ipr) >= 40) && <text x={cx + 10} y={cy + 4} style={{ fontSize: 10, fontWeight: on ? 800 : 600 }} className="fill-slate-800">{a.code}</text>}
              <title>{`${a.code} · IPR ${fmt(a.ipr)} (${a.categoria})\\nDeterioro técnico ${fmt(a.ipr_tecnico)} · Costo para producir ${fmt(a.ipr_economico)}`}</title>
            </g>
          )
        })}
      </svg>
      <div className="space-y-2 text-xs text-slate-600">
        <p><b>Cómo leerla.</b> Cada punto es una unidad. A la derecha, más deterioro técnico; arriba, más costo para producir cada km y cada tonelada frente a las
          unidades de su grupo. Una unidad que gasta más pero también transporta más <b>no sube</b>, porque el costo se mide por unidad producida.</p>
        <ul className="space-y-1">
          <li><b className="text-red-700">Arriba a la derecha:</b> candidata clara a recambio, con sustento técnico y económico.</li>
          <li><b className="text-amber-800">Arriba a la izquierda:</b> sana pero cara: revise la carga, la ruta o el conductor antes de reemplazarla.</li>
          <li><b className="text-orange-800">Abajo a la derecha:</b> aún produce barato pero se deteriora: programe el recambio.</li>
          <li><b className="text-emerald-800">Abajo a la izquierda:</b> conservar.</li>
        </ul>
        <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1">
          {IPR_CATEGORIAS.map(c => <span key={c} className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full" style={{ background: CAT[c].color }} />{c}</span>)}
        </div>
        <p className="text-slate-400">Se rotulan las unidades con IPR de 40 o más; pase el cursor sobre las demás. Haga clic en un punto para ver su detalle.</p>
      </div>
    </div>
  )
}

function Detalle({ a, puedeEditar, onGuardado }: { a: FeIprActivo; puedeEditar: boolean; onGuardado: () => void }) {
  const ap = aportes(a)
  const e = a.economia
  const ec = e.econ
  const [ev, setEv] = useState({ obsolescencia: a.evaluacion.obsolescencia?.toString() ?? '', adecuacion: a.evaluacion.adecuacion?.toString() ?? '', nota: a.evaluacion.nota ?? '' })
  const [saving, setSaving] = useState(false)
  const guardar = async () => {
    setSaving(true)
    try {
      await fleetApi.iprGuardar(null, { code: a.code, obsolescencia: ev.obsolescencia === '' ? null : Number(ev.obsolescencia), adecuacion: ev.adecuacion === '' ? null : Number(ev.adecuacion), nota: ev.nota })
      toast.success('Evaluación guardada'); onGuardado()
    } catch (err) { toast.error(err instanceof Error ? err.message : 'No se pudo guardar') } finally { setSaving(false) }
  }
  return (
    <div className="grid gap-3 bg-slate-50 p-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="overflow-x-auto rounded-lg border bg-white">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-[10px] uppercase text-slate-500"><tr>
            <th className="p-2 text-left">Factor</th><th className="p-2 text-right">Resultado</th><th className="p-2 text-right">Referencia</th>
            <th className="w-32 p-2 text-left">Puntaje</th><th className="p-2 text-right">Peso</th><th className="p-2 text-right">Aporte</th>
          </tr></thead>
          <tbody className="divide-y">
            {FACTOR_ORDEN.map(c => a.factores.find(f => f.codigo === c)).filter(Boolean).map(f => {
              const p = f!.puntaje == null ? null : Number(f!.puntaje)
              const aporte = ap.find(x => x.codigo === f!.codigo)?.aporte
              const d = f!.detalle || {}
              const extra = f!.codigo === 'mantenimiento' && d.tendencia != null ? `últimos 12 meses ${soles(Number(d.m12))} · 13–24: ${soles(Number(d.m13_24))} · 25–36: ${soles(Number(d.m25_36))} · tendencia ${fmt(Number(d.tendencia))} %`
                : f!.codigo === 'fallas' ? [d.mtbf_dias != null ? `MTBF ${fmt(Number(d.mtbf_dias))} días` : null, d.por_10000_km != null ? `${fmt(Number(d.por_10000_km), 2)} por 10 000 km` : null, d.reincidencias ? `${d.reincidencias} sistema(s) reincidente(s)` : null].filter(Boolean).join(' · ')
                : f!.codigo === 'disponibilidad' ? (f!.valor == null ? 'sin registro de días fuera de servicio' : `${fmt(Number(d.dias_fuera))} días fuera · ${fmt(Number(d.horas_inmovil))} h inmovilizada`)
                : f!.codigo === 'kilometraje' ? [d.km_anio ? `${fmt(Number(d.km_anio))} km/año` : null, d.km_12m ? `${fmt(Number(d.km_12m))} km en 12 meses` : null, d.horas_anio ? `${fmt(Number(d.horas_anio))} h/año` : null].filter(Boolean).join(' · ')
                : f!.codigo === 'consumo' && d.variacion != null ? `km/galón 12 meses ${fmt(Number(d.kmgal_12m), 1)} vs ${fmt(Number(d.kmgal_previo), 1)} antes (${fmt(Number(d.variacion))} %)`
                : f!.codigo === 'productividad' && d.ton_12m ? `${fmt(Number(d.ton_12m), 1)} t y ${fmt(Number(d.viajes_12m))} viajes en 12 meses`
                : f!.codigo === 'seguridad' && d.sistemas ? String(d.sistemas) : ''
              return (
                <tr key={f!.codigo} className={f!.peso === 0 ? 'text-slate-400' : ''}>
                  <td className="p-2"><div className="font-semibold text-slate-800">{f!.nombre}</div>{extra && <div className="text-[10px] text-slate-500">{extra}</div>}</td>
                  <td className="whitespace-nowrap p-2 text-right font-semibold">{valorTxt(f!)}</td>
                  <td className="whitespace-nowrap p-2 text-right text-slate-500">{f!.referencia != null ? (f!.unidad.startsWith('S/') ? `S/ ${fmt(f!.referencia, 2)}` : fmt(f!.referencia)) : ''}</td>
                  <td className="p-2">{p == null ? <span className="text-slate-400">sin dato</span> : (
                    <div className="flex items-center gap-1.5"><div className="h-1.5 flex-1 rounded bg-slate-100"><div className="h-1.5 rounded" style={{ width: `${p}%`, background: p >= 80 ? '#cf152d' : p >= 60 ? '#ea580c' : p >= 40 ? '#d97706' : '#10b981' }} /></div><span className="w-7 text-right">{fmt(p)}</span></div>
                  )}</td>
                  <td className="p-2 text-right">{f!.peso}</td>
                  <td className="p-2 text-right font-semibold">{aporte != null ? `+${fmt(aporte, 1)}` : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="p-2 text-[10px] text-slate-500">Puntaje 0–100: 100 = mayor prioridad de recambio. Costos comparados con la mediana del grupo (referencia). Los factores sin dato no cuentan y su peso se reparte.
          {a.piso_seguridad != null && <b className="text-[#cf152d]"> Fallas críticas de seguridad repetidas: el IPR se eleva al menos a {a.piso_seguridad}.</b>}</p>
      </div>
      <div className="space-y-3">
        <div className="rounded-lg border bg-white p-3 text-xs">
          <div className="mb-1 font-bold text-slate-800">Valor residual y CAPEX de reposición</div>
          {ec ? <>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              <span className="text-slate-500">Seguir 1 año más</span><b className="text-right">{soles(ec.seguir)}</b>
              <span className="text-slate-500">+ costo de indisponibilidad</span><b className="text-right">{soles(e.costo_indisponibilidad)}</b>
              <span className="text-slate-500">= costo total de seguir</span><b className="text-right">{soles(e.seguir_total)}</b>
              <span className="text-slate-500">Una nueva (costo anual equivalente)</span><b className="text-right">{soles(ec.nuevo)}</b>
            </div>
            <div className={`mt-2 rounded p-2 font-semibold ${(e.seguir_total ?? 0) > ec.nuevo ? 'bg-red-50 text-red-800' : 'bg-emerald-50 text-emerald-800'}`}>
              {(e.seguir_total ?? 0) > ec.nuevo ? `Reemplazarla ahorra ${soles((e.seguir_total ?? 0) - ec.nuevo)} al año` : `Seguir con ella cuesta ${soles(ec.nuevo - (e.seguir_total ?? 0))} menos al año`}
            </div>
          </> : <p className="text-slate-500">Sin cálculo económico: complete año de fabricación y valor de reposición.</p>}
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
            <span className="text-slate-500">Venderla hoy (valor residual)</span><b className="text-right">{soles(e.venta_hoy)}</b>
            <span className="text-slate-500">Pérdida de valor si sigue un año</span><b className="text-right">{soles(e.perdida_valor_anio)}</b>
            <span className="text-slate-500">Valor de reposición</span><b className="text-right">{soles(e.valor_reposicion)}{e.valor_ref ? ' (ref.)' : ''}</b>
          </div>
          <p className="mt-1 text-[10px] text-slate-400">Indisponibilidad: días fuera en 12 meses × {soles(e.costo_dia_reemplazo)} por día de reemplazo (alquiler, retrasos, reprogramaciones).</p>
        </div>
        <div className="rounded-lg border bg-white p-3 text-xs">
          <div className="mb-1 font-bold text-slate-800">Evaluación manual (0 = sin problema · 100 = crítico)</div>
          <div className="grid grid-cols-2 gap-2">
            <label>Obsolescencia<span className="block text-[10px] text-slate-400">repuestos, soporte, tecnología, emisiones</span>
              <input type="number" min={0} max={100} disabled={!puedeEditar} value={ev.obsolescencia} onChange={x => setEv({ ...ev, obsolescencia: x.target.value })} className="mt-1 w-full rounded border px-2 py-1" /></label>
            <label>Adecuación a la operación<span className="block text-[10px] text-slate-400">tipo de carga, rutas, tonelaje</span>
              <input type="number" min={0} max={100} disabled={!puedeEditar} value={ev.adecuacion} onChange={x => setEv({ ...ev, adecuacion: x.target.value })} className="mt-1 w-full rounded border px-2 py-1" /></label>
          </div>
          <textarea disabled={!puedeEditar} rows={2} placeholder="Sustento (opcional)" value={ev.nota} onChange={x => setEv({ ...ev, nota: x.target.value })} className="mt-2 w-full rounded border px-2 py-1" />
          {puedeEditar && <button disabled={saving} onClick={guardar} className="mt-1 flex items-center gap-1 rounded bg-[#002855] px-3 py-1 font-semibold text-white">{saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}Guardar</button>}
          <p className="mt-1 text-[10px] text-slate-400">Cuentan en el IPR cuando su peso es mayor que 0 (panel de pesos).</p>
        </div>
      </div>
    </div>
  )
}

function Tabla({ A, abierto, setAbierto, puedeEditar, onGuardado }: { A: FeIprActivo[]; abierto: string | null; setAbierto: (c: string | null) => void; puedeEditar: boolean; onGuardado: () => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1000px] text-sm">
        <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
          <tr>
            <th className="w-6 p-2" /><th className="p-2 text-left">Unidad</th><th className="p-2 text-right">IPR</th><th className="p-2 text-left">Decisión</th>
            <th className="p-2 text-right">Técnico</th><th className="p-2 text-right">Económico</th><th className="p-2 text-left">Qué lo empuja</th>
            <th className="p-2 text-right">S/ por km</th><th className="p-2 text-right">S/ por t</th><th className="p-2 text-right">t en 12 m</th><th className="p-2 text-right">Reemplazar ahorra / año</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {A.map(a => {
            const ap = aportes(a).slice(0, 3)
            const e = a.economia
            const dif = e.econ && e.seguir_total != null ? e.seguir_total - e.econ.nuevo : null
            const on = abierto === a.code
            return (
              <Fragment key={a.code}>
                <tr id={`ipr-${a.code}`} onClick={() => setAbierto(on ? null : a.code)} className={`cursor-pointer align-top hover:bg-slate-50 ${on ? 'bg-slate-50' : ''}`}>
                  <td className="p-2 text-slate-400">{on ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</td>
                  <td className="p-2"><div className="font-bold text-[#002855]">{a.code}</div><div className="text-[11px] text-slate-500">{nombreUnidad(a)}</div></td>
                  <td className="p-2 text-right text-lg font-black" style={{ color: CAT[a.categoria].color }}>{a.ipr != null ? fmt(a.ipr) : '—'}
                    {a.cobertura != null && <div className="text-[10px] font-normal text-slate-400">{fmt(a.cobertura)} % medido</div>}</td>
                  <td className="space-y-1 p-2"><CatPill c={a.categoria} />{a.piso_seguridad != null && <div className="flex items-center gap-1 text-[10px] font-bold text-[#cf152d]"><ShieldAlert className="h-3 w-3" />Seguridad</div>}{a.confianza && <div><ConfianzaPill c={a.confianza} /></div>}</td>
                  <td className="p-2 text-right">{fmt(a.ipr_tecnico)}</td>
                  <td className="p-2 text-right">{fmt(a.ipr_economico)}</td>
                  <td className="p-2 text-xs text-slate-600">{ap.map(f => `${FACTOR_CORTO[f.codigo]} +${fmt(f.aporte)}`).join(' · ') || '—'}</td>
                  <td className="whitespace-nowrap p-2 text-right">{a.clase === 'TRANSPORTE' && a.produccion.costo_km != null ? `S/ ${fmt(a.produccion.costo_km, 2)}` : '—'}</td>
                  <td className="whitespace-nowrap p-2 text-right">{a.produccion.costo_ton != null ? `S/ ${fmt(a.produccion.costo_ton, 2)}` : '—'}</td>
                  <td className="whitespace-nowrap p-2 text-right">{a.produccion.ton_12m ? fmt(a.produccion.ton_12m, 1) : '—'}</td>
                  <td className={`whitespace-nowrap p-2 text-right font-bold ${dif == null ? '' : dif > 0 ? 'text-[#cf152d]' : 'text-emerald-700'}`}>{dif == null ? '—' : dif > 0 ? `+${soles(dif)}` : `−${soles(-dif)}`}</td>
                </tr>
                {on && <tr><td colSpan={11} className="p-0"><Detalle a={a} puedeEditar={puedeEditar} onGuardado={onGuardado} /></td></tr>}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Pesos({ d, onGuardado }: { d: FeIpr; onGuardado: () => void }) {
  const [p, setP] = useState<Record<string, string>>(() => Object.fromEntries(FACTOR_ORDEN.map(k => [k, String(d.pesos[k] ?? 0)])))
  const [saving, setSaving] = useState(false)
  const total = FACTOR_ORDEN.reduce((s, k) => s + (Number(p[k]) || 0), 0)
  const guardar = async () => {
    setSaving(true)
    try {
      await fleetApi.iprGuardar(Object.fromEntries(FACTOR_ORDEN.map(k => [k, Number(p[k]) || 0])), null)
      toast.success('Pesos guardados: el IPR se recalculó'); onGuardado()
    } catch (err) { toast.error(err instanceof Error ? err.message : 'No se pudo guardar') } finally { setSaving(false) }
  }
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {FACTOR_ORDEN.map(k => (
          <label key={k} className="rounded-lg border p-2 text-xs">
            <span className="block font-semibold text-slate-700">{FACTOR_CORTO[k]}</span>
            <div className="mt-1 flex items-center gap-1"><input type="number" min={0} max={100} disabled={!d.puede_editar} value={p[k]} onChange={e => setP({ ...p, [k]: e.target.value })} className="w-16 rounded border px-2 py-1 text-right" /><span className="text-slate-400">%</span></div>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className={total === 100 ? 'text-slate-500' : 'font-semibold text-amber-700'}>Suma de pesos: {total} % {total !== 100 && '(se normaliza; se recomienda 100)'}</span>
        {d.puede_editar && <button disabled={saving} onClick={guardar} className="flex items-center gap-1 rounded-lg bg-[#002855] px-3 py-1.5 font-semibold text-white">{saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}Guardar pesos</button>}
      </div>
      <p className="text-[11px] text-slate-500">
        Rangos: {IPR_CATEGORIAS.filter(c => c !== 'Datos insuficientes').map(c => `${CAT[c].rango} ${c.toLowerCase()}`).join(' · ')}. Vida esperada:{' '}
        {Object.entries(d.parametros.km_vida).map(([g, v]) => `${GRUPO_LABEL[g as keyof typeof GRUPO_LABEL] ?? g} ${fmt(v)} km`).join(', ')}; {Object.entries(d.parametros.horas_vida).map(([g, v]) => `${CLASE_LABEL[g as keyof typeof CLASE_LABEL] ?? g} ${fmt(v)} h`).join(', ')}.
        Costo diario de indisponibilidad: {Object.entries(d.parametros.costo_dia).map(([g, v]) => `${GRUPO_LABEL[g as keyof typeof GRUPO_LABEL] ?? g} ${soles(v)}`).join(', ')}.
      </p>
    </div>
  )
}

function Historia() {
  const [res, setRes] = useState<{ data?: FeRecambios; error?: string } | null>(null)
  const [n, setN] = useState(0)
  useEffect(() => { let a = true; fleetApi.recambios().then(d => a && setRes({ data: d })).catch(e => a && setRes({ error: e.message })); return () => { a = false } }, [n])
  if (!res) return <LoadingBlock label="Reconstruyendo altas y bajas…" className="h-40" />
  if (res.error || !res.data) return <ErrorBlock message={res.error || 'Sin datos'} onRetry={() => setN(x => x + 1)} />
  const A = res.data.activos
  if (!A.length) return <EmptyState title="Sin historia de activos">Cargue la historia en Datos y parámetros.</EmptyState>
  const y0 = Math.min(...A.map(a => Number(a.desde.slice(0, 4))))
  const hoy = res.data.hoy
  const t = (iso: string) => { const [y, m] = iso.split('-').map(Number); return (y - y0) * 12 + (m - 1) }
  const span = t(hoy) + 1
  const years = Array.from({ length: Number(hoy.slice(0, 4)) - y0 + 1 }, (_, i) => y0 + i)
  const ult = (iso: string) => t(hoy) - t(iso) <= 2
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[760px]">
        <div className="grid grid-cols-[180px_1fr] text-[10px] font-bold text-slate-400">
          <span />
          <div className="relative h-4">{years.map(y => <span key={y} className="absolute" style={{ left: `${t(`${y}-01`) / span * 100}%` }}>{y}</span>)}</div>
        </div>
        {A.map(a => (
          <div key={a.code} className="grid grid-cols-[180px_1fr] items-center py-0.5 text-sm">
            <span className="truncate pr-3"><b className="text-slate-800">{a.code}</b><span className="ml-1 text-xs text-slate-500">{[CLASE_LABEL[a.clase], a.anio_fab].filter(Boolean).join(' · ')}</span></span>
            <div className="relative h-4 rounded bg-slate-50">
              {years.map(y => <span key={y} className="absolute top-0 h-full w-px bg-slate-200" style={{ left: `${t(`${y}-01`) / span * 100}%` }} />)}
              <span title={`${a.code}: ${mes(a.desde)} a ${mes(a.hasta)} · ${a.meses} meses con datos`}
                className={`absolute top-0.5 h-3 rounded ${ult(a.hasta) ? 'bg-[#2a78d6]' : 'bg-slate-400'}`}
                style={{ left: `${t(a.desde) / span * 100}%`, width: `${Math.max(0.8, (t(a.hasta) - t(a.desde) + 1) / span * 100)}%` }} />
            </div>
          </div>
        ))}
        <p className="mt-2 text-xs text-slate-500">Azul: con actividad en los últimos 3 meses. Gris: sin actividad reciente (posible baja).</p>
      </div>
    </div>
  )
}

function Recambios() {
  const f = useFeFilters()
  const { data, error, loading, reload } = useFeQuery(fleetApi.ipr, f)
  const [abierto, setAbierto] = useState<string | null>(null)
  const [verHistoria, setVerHistoria] = useState(false)
  const [verPesos, setVerPesos] = useState(false)
  const A = useMemo(() => data?.activos ?? [], [data])
  if (loading && !data) return <LoadingBlock label="Calculando el índice de prioridad de recambio…" className="h-80" />
  if (error || !data) return <ErrorBlock message={error || 'Sin datos'} onRetry={reload} />
  if (!A.length) return <EmptyState title="Sin activos con datos">Cargue la historia en Datos y parámetros.</EmptyState>
  const por = (c: FeIprCategoria) => A.filter(a => a.categoria === c)
  const prio = por('Recambio prioritario'), prog = por('Programar recambio')
  const ver = (code: string) => { setAbierto(code); setTimeout(() => document.getElementById(`ipr-${code}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50) }
  const sustento = (a: FeIprActivo) => aportes(a).slice(0, 2).map(x => FACTOR_CORTO[x.codigo].toLowerCase()).join(' y ')
  return (
    <div className="space-y-4">
      <div className={`rounded-xl border p-4 ${prio.length ? 'border-red-200 bg-red-50' : prog.length ? 'border-orange-200 bg-orange-50' : 'border-emerald-200 bg-emerald-50'}`}>
        <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Conclusión · Índice de Prioridad de Recambio · {mes(data.desde)} a {mes(data.hasta)}</div>
        <div className="mt-1 space-y-1 text-sm text-slate-900">
          {prio.length > 0 && <p><b className="text-[#cf152d]">Recambio prioritario:</b> {prio.map(a => <span key={a.code}><b>{a.code}</b> (IPR {fmt(a.ipr)}: {sustento(a)})</span>).reduce<React.ReactNode[]>((acc, x, i) => (i ? [...acc, '; ', x] : [x]), [])}.</p>}
          {prog.length > 0 && <p><b className="text-orange-700">Programar recambio:</b> {prog.map(a => `${a.code} (${fmt(a.ipr)})`).join(', ')}.</p>}
          {!prio.length && !prog.length && <p>Ninguna unidad llega a 60 puntos: no hay sustento para un recambio en este periodo.</p>}
          <p className="text-xs text-slate-600">{por('Monitorear').length} en monitoreo · {por('Conservar').length} para conservar · {por('Datos insuficientes').length} sin datos suficientes.</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {IPR_CATEGORIAS.map(c => {
          const L = por(c)
          return (
            <div key={c} className="rounded-xl border bg-white p-3" style={{ borderTop: `4px solid ${CAT[c].color}` }}>
              <div className="text-xs font-bold uppercase tracking-wide text-slate-600">{c}</div>
              <div className="flex items-baseline gap-2"><span className="text-3xl font-black text-slate-900">{L.length}</span><span className="text-xs text-slate-400">IPR {CAT[c].rango}</span></div>
              <div className="text-[11px] text-slate-500">{CAT[c].accion}</div>
              {L.length > 0 && <div className="mt-1 truncate text-[11px] font-semibold text-slate-700" title={L.map(a => a.code).join(', ')}>{L.map(a => a.code).join(', ')}</div>}
            </div>
          )
        })}
      </div>

      <Panel title="¿Qué unidad cuesta más producir y además se deteriora?" hint="Matriz de deterioro técnico frente a costo para producir (cada eje 0–100, comparado con su grupo)">
        <Matriz A={A} onVer={ver} />
      </Panel>

      <Panel title="Ranking del Índice de Prioridad de Recambio (IPR)"
        hint={<>Promedio ponderado de 9 factores técnicos, económicos y operativos. Rangos: 0–39 conservar · 40–59 monitorear · 60–79 programar recambio · 80–100 recambio prioritario.</>}
        actions={<button onClick={() => setVerPesos(v => !v)} className="rounded-lg border px-3 py-1 text-xs font-semibold text-[#002855]">{verPesos ? 'Ocultar pesos' : 'Ver o ajustar pesos'}</button>}>
        {verPesos && <div className="mb-4 rounded-lg border bg-slate-50 p-3"><Pesos d={data} onGuardado={reload} /></div>}
        <Ranking A={A} />
      </Panel>

      <Panel title="Sustento por unidad" hint="Haga clic en una fila para ver cada factor, su aporte al índice, el valor residual, el CAPEX de reposición y la evaluación manual">
        <Tabla A={A} abierto={abierto} setAbierto={setAbierto} puedeEditar={data.puede_editar} onGuardado={reload} />
      </Panel>

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <button onClick={() => setVerHistoria(v => !v)} className="flex w-full items-center justify-between p-4 text-left">
          <span><span className="text-sm font-black text-slate-800">Historia de actividad de cada activo</span>
            <span className="block text-xs text-slate-500">Primer y último mes con km, combustible, viajes o mantenimiento</span></span>
          <ChevronDown className={`h-4 w-4 text-slate-500 transition-transform ${verHistoria ? 'rotate-180' : ''}`} />
        </button>
        {verHistoria && <div className="border-t p-4"><Historia /></div>}
      </section>

      <p className="text-xs text-slate-500">
        Valor de reposición, vida útil y tasas de capital se ajustan en <Link href="/eficiencia-flota/datos" className="font-semibold text-[#002855] hover:underline">Datos y parámetros</Link>.
        Use cotizaciones reales en lugar de valores referenciales antes de presentar un recambio a gerencia.
      </p>
    </div>
  )
}

export default function RecambiosPage() {
  return <Suspense fallback={<LoadingBlock className="h-80" />}><Recambios /></Suspense>
}
