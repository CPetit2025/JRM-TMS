'use client'

import { Fragment, useMemo } from 'react'
import { ArrowDownRight, ArrowLeft, ArrowUpRight, Minus } from 'lucide-react'
import { fmt } from '@/lib/fleet/api'

// Piezas comunes del módulo Indicadores (KPI): /desempeno (tablero, equipo, mi avance) y el widget de Inicio.

export type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export const ROLES: Array<[string, string]> = [
  ['DESPACHO', 'Supervisor de Despacho'], ['TRANSPORTE', 'Transporte / Jefe de Distribución'], ['DOCUMENTARIO', 'Asistente Documentario'],
  ['CONDUCTOR', 'Conductores'], ['SOPORTE', 'Soporte Mecánico'],
]
export const ROL_CORTO: Record<string, string> = { DESPACHO: 'Despacho', TRANSPORTE: 'Transporte', DOCUMENTARIO: 'Documentario', CONDUCTOR: 'Conductores', SOPORTE: 'Soporte Mecánico' }
// Paleta categórica validada (orden fijo por rol, nunca por posición)
export const ROL_COLOR: Record<string, string> = { DESPACHO: '#2a78d6', TRANSPORTE: '#eb6834', DOCUMENTARIO: '#1baf7a', CONDUCTOR: '#eda100', SOPORTE: '#e87ba4' }

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre']
export const mesTxt = (d?: string) => { if (!d) return ''; const [y, m] = d.slice(0, 7).split('-').map(Number); return `${MESES[m - 1]} ${y}` }
export const mesCorto = (d?: string) => { if (!d) return ''; const [y, m] = d.slice(0, 7).split('-').map(Number); return `${MESES[m - 1].slice(0, 3)} ${String(y).slice(2)}` }
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
export const fecha = (s?: string | null) => (s ? new Date(s.length <= 10 ? `${s}T12:00:00` : s).toLocaleDateString('es-PE') : '—')

export const CALIF: Record<string, [string, string]> = {
  EXCELENTE: ['Excelente', 'bg-emerald-100 text-emerald-800'], BUENO: ['Bueno', 'bg-sky-100 text-sky-800'],
  REGULAR: ['Regular', 'bg-amber-100 text-amber-800'], BAJO: ['Bajo', 'bg-red-100 text-red-800'], SIN_DATOS: ['Sin datos suficientes', 'bg-slate-100 text-slate-600'],
}
export const CALIF_BAR: Record<string, string> = { EXCELENTE: '#10b981', BUENO: '#0ea5e9', REGULAR: '#f59e0b', BAJO: '#cf152d', SIN_DATOS: '#cbd5e1' }
export const INFORME: Record<string, [string, string]> = {
  REVISADO: ['Revisado', 'text-emerald-700'], ENVIADO: ['Enviado, por revisar', 'text-sky-700'], OBSERVADO: ['Observado: corregir', 'text-amber-700'],
  ATRASADO: ['Atrasado', 'text-[#cf152d]'], PENDIENTE: ['Pendiente', 'text-amber-700'], MES_EN_CURSO: ['Mes en curso', 'text-slate-500'],
}
export const valorTxt = (k: Row) => k.valor == null ? '—' : k.unidad === '%' ? `${fmt(k.valor, 1)} %` : k.unidad === 'h' ? `${fmt(k.valor, 1)} h` : fmt(k.valor)
export const metaTxt = (k: Row) => `${k.sentido === 'MAYOR' ? '≥' : '≤'} ${k.unidad === '%' ? `${fmt(k.meta)} %` : k.unidad === 'h' ? `${fmt(k.meta, 1)} h` : fmt(k.meta)}`
export const puntajeColor = (p: number) => (p >= 90 ? 'bg-emerald-500' : p >= 70 ? 'bg-amber-500' : 'bg-[#cf152d]')

export function Calif({ c, className = '' }: { c?: string; className?: string }) {
  const [label, cls] = CALIF[c || 'SIN_DATOS'] || CALIF.SIN_DATOS
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls} ${className}`}>{label}</span>
}

export function Delta({ actual, anterior }: { actual?: number | null; anterior?: number | null }) {
  if (actual == null || anterior == null) return <span className="text-xs text-slate-400">sin comparación</span>
  const d = Number(actual) - Number(anterior)
  if (d === 0) return <span className="inline-flex items-center gap-0.5 text-xs text-slate-500"><Minus className="h-3.5 w-3.5" />igual que el mes anterior</span>
  const Icon = d > 0 ? ArrowUpRight : ArrowDownRight
  return <span className={`inline-flex items-center gap-0.5 text-xs font-semibold ${d > 0 ? 'text-emerald-700' : 'text-[#cf152d]'}`}><Icon className="h-3.5 w-3.5" />{d > 0 ? '+' : ''}{fmt(d)} pts vs. mes anterior</span>
}

// Evolución mensual compacta (barras 0–100 con su valor; vacía = sin datos)
export function MiniBarras({ serie, color = '#002855', alto = 56 }: { serie: Row[]; color?: string; alto?: number }) {
  return (
    <div className="flex items-end gap-1.5" style={{ height: alto + 28 }}>
      {serie.map((p, i) => {
        const v = p.indice == null ? null : Number(p.indice)
        const ultimo = i === serie.length - 1
        return (
          <div key={p.periodo} className="flex flex-1 flex-col items-center justify-end gap-0.5" title={`${mesTxt(p.periodo)}: ${v ?? 'sin datos'}`}>
            <span className={`text-[10px] ${ultimo ? 'font-bold text-slate-800' : 'text-slate-500'}`}>{v ?? '–'}</span>
            <div className="w-full max-w-[28px] rounded-t" style={{ height: v == null ? 2 : Math.max(3, (v / 100) * alto), background: v == null ? '#e2e8f0' : color, opacity: ultimo ? 1 : 0.55 }} />
            <span className="text-[9px] capitalize text-slate-400">{mesCorto(p.periodo).split(' ')[0]}</span>
          </div>
        )
      })}
    </div>
  )
}

// Medidor semicircular del índice
export function Medidor({ indice, calificacion, size = 160 }: { indice?: number | null; calificacion?: string; size?: number }) {
  const r = 70, c = Math.PI * r
  const v = indice == null ? 0 : Math.max(0, Math.min(100, Number(indice)))
  const color = CALIF_BAR[calificacion || 'SIN_DATOS'] || CALIF_BAR.SIN_DATOS
  return (
    <svg viewBox="0 0 180 104" width={size} height={size * 0.58} role="img" aria-label={`Índice ${indice ?? 'sin datos'}`}>
      <path d="M 20 90 A 70 70 0 0 1 160 90" fill="none" stroke="#e2e8f0" strokeWidth="14" strokeLinecap="round" />
      {indice != null && <path d="M 20 90 A 70 70 0 0 1 160 90" fill="none" stroke={color} strokeWidth="14" strokeLinecap="round" strokeDasharray={`${(v / 100) * c} ${c}`} />}
      <text x="90" y="80" textAnchor="middle" className="fill-slate-900" style={{ fontSize: 34, fontWeight: 800 }}>{indice ?? '—'}</text>
      <text x="90" y="98" textAnchor="middle" className="fill-slate-400" style={{ fontSize: 10 }}>de 100</text>
    </svg>
  )
}

export function Indice({ k, compacto }: { k: Row; compacto?: boolean }) {
  return (
    <div className={`flex flex-col items-center justify-center rounded-lg bg-[#002855] text-white ${compacto ? 'p-3' : 'p-5'}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-80">Índice del mes</div>
      <div className={`${compacto ? 'text-3xl' : 'text-5xl'} font-extrabold`}>{k.indice ?? '—'}</div>
      <Calif c={k.calificacion} className="mt-1" />
      {k.cobertura != null && <div className="mt-1 text-[10px] opacity-70">{fmt(k.cobertura)} % del peso medido</div>}
    </div>
  )
}

export function TablaKpis({ k }: { k: Row }) {
  const grupos = useMemo(() => {
    const g: Record<string, Row[]> = {}
    for (const x of k.kpis || []) (g[x.grupo || 'General'] ||= []).push(x)
    return Object.entries(g)
  }, [k])
  return (
    <div className="overflow-x-auto rounded-xl border bg-white">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>
          <th className="p-2 text-left">Indicador</th><th className="p-2 text-right">Resultado</th><th className="p-2 text-right">Meta</th><th className="p-2 text-right">Peso</th><th className="w-40 p-2 text-left">Puntaje</th>
        </tr></thead>
        <tbody>
          {grupos.map(([g, rows]) => (
            <Fragment key={g}>
              <tr className="bg-slate-50/60"><td colSpan={5} className="px-2 pt-2 text-[11px] font-semibold uppercase tracking-wide text-[#002855]">{g}</td></tr>
              {rows.map(x => {
                const p = x.puntaje == null ? null : Number(x.puntaje)
                return (
                  <tr key={x.codigo} className="border-t">
                    <td className="p-2"><div className="font-medium text-slate-800">{x.nombre}</div><div className="text-[11px] text-slate-500">{x.descripcion}</div></td>
                    <td className="whitespace-nowrap p-2 text-right font-semibold">{valorTxt(x)}{x.contexto && <div className="text-[10px] font-normal text-slate-400">{x.contexto}</div>}</td>
                    <td className="whitespace-nowrap p-2 text-right text-slate-500">{x.peso > 0 ? metaTxt(x) : 'informativo'}</td>
                    <td className="p-2 text-right text-slate-500">{x.peso > 0 ? `${fmt(x.peso)}` : '—'}</td>
                    <td className="p-2">{p == null ? <span className="text-xs text-slate-400">{x.peso > 0 ? 'sin datos' : ''}</span> : (
                      <div className="flex items-center gap-2"><div className="h-1.5 flex-1 rounded bg-slate-100"><div className={`h-1.5 rounded ${puntajeColor(p)}`} style={{ width: `${p}%` }} /></div><span className="w-9 text-right text-xs font-semibold">{fmt(p)}</span></div>
                    )}</td>
                  </tr>
                )
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Ficha({ k, onVolver, volverTxt = 'Volver' }: { k: Row; onVolver?: () => void; volverTxt?: string }) {
  const inf = k.informe
  const [est, ecls] = inf ? INFORME[inf.estado] || ['—', ''] : ['', '']
  return (
    <div className="space-y-3">
      {onVolver && <button onClick={onVolver} className="flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm"><ArrowLeft className="h-4 w-4" />{volverTxt}</button>}
      <div className="grid gap-3 md:grid-cols-[200px_1fr]">
        <Indice k={k} />
        <div className="space-y-2 rounded-xl border bg-white p-4 text-sm">
          <div className="text-lg font-semibold text-slate-800">{k.nombre || k.rol_nombre || k.rol} <span className="text-sm font-normal text-slate-500">· {k.rol_nombre && k.nombre ? `${k.rol_nombre} · ` : ''}{mesTxt(k.periodo)}</span></div>
          {k.siniestro_grave && <div className="rounded-lg bg-red-50 p-2 text-red-800">Siniestro grave con responsabilidad del conductor: el índice del mes queda en 0.</div>}
          {inf && <div className={ecls}>Informe mensual: {est}{inf.dias_atraso ? ` · ${inf.dias_atraso} día(s) de atraso` : ''} <span className="text-xs text-slate-500">· vence el {fecha(inf.vence)}</span></div>}
          {inf?.comentario && <div className="text-xs text-slate-600"><b>Comentario del revisor:</b> {inf.comentario}</div>}
          <p className="text-xs text-slate-500">Cada indicador recibe 0–100 puntos según su meta. El índice es el promedio ponderado de los que tienen datos. Con menos del 40 % del peso medido, el índice no se calcula.</p>
          {(k.notas || []).length > 0 && <p className="text-xs text-amber-700">Algunos datos no se pudieron leer: {(k.notas || []).join(' · ')}</p>}
        </div>
      </div>
      <TablaKpis k={k} />
    </div>
  )
}
