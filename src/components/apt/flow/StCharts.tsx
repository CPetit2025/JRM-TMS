'use client'

import { Bar, CartesianGrid, ComposedChart, LabelList, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { APT_COLORS, fmtDec1, fmtPct, fmtTn } from '@/lib/apt/format'
import { ALMACEN_COLOR, FLOW_COLOR } from '@/lib/apt/flowColors'
import type { FlowSt } from '@/lib/apt/flowTypes'
import { EtapasTip, fmtAxisTn, mesLabel, tipPayload } from './EtapasCharts'

// Gráficos de "ST VENTAS": semáforo del saldo (ideal 0) y guiado mensual por días en ST con retornos.

export const ST_BUCKET = [
  { key: 'd0', label: 'Mismo día', color: ALMACEN_COLOR.ST },
  { key: 'd1_3', label: '1–3 días', color: '#facc15' },
  { key: 'd4_7', label: '4–7 días', color: '#f97316' },
  { key: 'd8', label: '8+ días', color: '#dc2626' },
] as const
const AXIS_TICK = { fontSize: 11, fill: '#64748b' }

export type StTone = 'ok' | 'warn' | 'crit'
export const stSaldoTone = (tn: number): StTone => (tn < 1 ? 'ok' : tn < 10 ? 'warn' : 'crit')
const TONE = {
  ok: { color: '#10b981', label: 'En meta', text: 'ST está prácticamente vacío: lo que entra se guía en el día.' },
  warn: { color: '#f59e0b', label: 'Atención', text: 'Hay material esperando en ST: guiar hoy o devolver a 647.' },
  crit: { color: '#dc2626', label: 'Fuera de meta', text: 'ST acumula stock: revisar lo detenido y devolverlo a 647/540.' },
} as const

// Posición no lineal en el arco: 0–1 TN ocupa el primer tercio, 1–10 el segundo y 10–50 el último
function gaugePos(tn: number) {
  const v = Math.max(0, tn)
  if (v < 1) return v / 3
  if (v < 10) return 1 / 3 + ((v - 1) / 9) / 3
  return 2 / 3 + Math.min(1, (v - 10) / 40) / 3
}
const polar = (cx: number, cy: number, r: number, t: number) => {
  const a = Math.PI * (1 - t)
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)] as const
}
function arc(cx: number, cy: number, r: number, t0: number, t1: number) {
  const [x0, y0] = polar(cx, cy, r, t0)
  const [x1, y1] = polar(cx, cy, r, t1)
  return `M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`
}

export function StSaldoGauge({ saldo, detenido, lotes }: { saldo: number; detenido: number; lotes: number }) {
  const tone = stSaldoTone(saldo)
  const t = TONE[tone]
  const cx = 110, cy = 105, r = 82
  const [nx, ny] = polar(cx, cy, r - 18, gaugePos(saldo))
  return (
    <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-center">
      <svg viewBox="0 0 220 125" className="w-full max-w-[240px]" role="img" aria-label={`Saldo ST ${fmtTn(saldo)} TN: ${t.label}`}>
        <path d={arc(cx, cy, r, 0, 1 / 3)} stroke="#10b981" strokeWidth={16} fill="none" />
        <path d={arc(cx, cy, r, 1 / 3, 2 / 3)} stroke="#f59e0b" strokeWidth={16} fill="none" />
        <path d={arc(cx, cy, r, 2 / 3, 1)} stroke="#dc2626" strokeWidth={16} fill="none" />
        {[[1 / 3, '1'], [2 / 3, '10']].map(([p, l]) => {
          const [x, y] = polar(cx, cy, r + 14, Number(p))
          return <text key={String(l)} x={x} y={y} textAnchor="middle" fontSize={10} fill="#64748b">{l} TN</text>
        })}
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#0f172a" strokeWidth={3} strokeLinecap="round" />
        <circle cx={cx} cy={cy} r={6} fill="#0f172a" />
        <text x={cx} y={cy - 24} textAnchor="middle" fontSize={20} fontWeight={900} fill={t.color}>{fmtTn(saldo)}</text>
        <text x={cx} y={cy - 10} textAnchor="middle" fontSize={10} fill="#64748b">TN en ST</text>
      </svg>
      <div className="min-w-0 space-y-2">
        <div className="flex items-center gap-2">
          <div className="flex gap-1 rounded-full bg-slate-800 px-1.5 py-1">
            {(['ok', 'warn', 'crit'] as const).map(k => (
              <span key={k} className="h-3.5 w-3.5 rounded-full transition-opacity"
                style={{ background: TONE[k].color, opacity: k === tone ? 1 : 0.2, boxShadow: k === tone ? `0 0 8px ${TONE[k].color}` : undefined }} />
            ))}
          </div>
          <span className="text-sm font-black" style={{ color: t.color }}>{t.label}</span>
        </div>
        <p className="text-xs leading-snug text-slate-600">{t.text}</p>
        <p className="text-[11px] text-slate-500">
          Detenido &gt; 1 día: <b className="tabular-nums text-slate-800">{fmtTn(detenido)} TN</b> en <b className="tabular-nums text-slate-800">{lotes}</b> lotes
        </p>
        <p className="text-[11px] text-slate-400">Semáforo: verde &lt; 1 TN · ámbar &lt; 10 TN · rojo ≥ 10 TN</p>
      </div>
    </div>
  )
}

// Guiado mensual desde ST por días de permanencia, con % mismo día y retornos ST → 647/540
export function StMensualChart({ data }: { data: FlowSt['mensual'] }) {
  const rows = data.map(m => ({ ...m, label: mesLabel(m.mes), total: m.d0 + m.d1_3 + m.d4_7 + m.d8 }))
  if (!rows.length) return <p className="flex h-64 items-center justify-center text-xs text-slate-400">Sin guías desde ST en el periodo</p>
  return (
    <ResponsiveContainer width="100%" height={320}>
      <ComposedChart data={rows} margin={{ top: 20, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} />
        <YAxis yAxisId="t" tick={AXIS_TICK} axisLine={false} tickLine={false} width={44} tickFormatter={fmtAxisTn} />
        <YAxis yAxisId="p" orientation="right" domain={[0, 100]} tick={AXIS_TICK} axisLine={false} tickLine={false} width={40} tickFormatter={v => `${v} %`} />
        <Tooltip cursor={{ fill: '#f1f5f9' }} content={a => {
          const r = tipPayload<(typeof rows)[number]>(a)
          return r && <EtapasTip title={r.label} subtitle={`${fmtTn(r.total)} TN guiadas desde ST`} rows={[
            ...ST_BUCKET.map(b => [b.label, `${fmtTn(r[b.key])} TN`, b.color] as [string, string, string]),
            ['% mismo día', fmtPct(r.mismo_dia_pct), APT_COLORS.navy],
            ['Retornos ST → almacén', `${fmtTn(r.retorno_tn)} TN`, FLOW_COLOR.RETORNO],
          ]} />
        }} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
        {ST_BUCKET.map((b, i) => (
          <Bar key={b.key} yAxisId="t" dataKey={b.key} name={b.label} stackId="g" fill={b.color} maxBarSize={44}
            radius={i === ST_BUCKET.length - 1 ? [4, 4, 0, 0] : undefined}>
            {i === ST_BUCKET.length - 1 && (
              <LabelList dataKey="total" position="top" formatter={(v: unknown) => fmtAxisTn(Number(v))} style={{ fontSize: 10, fill: '#334155', fontWeight: 700 }} />
            )}
          </Bar>
        ))}
        <Bar yAxisId="t" dataKey="retorno_tn" name="Retornos (TN)" fill={FLOW_COLOR.RETORNO} fillOpacity={0.75} maxBarSize={10} radius={[3, 3, 0, 0]} />
        <Line yAxisId="p" type="monotone" dataKey="mismo_dia_pct" name="% mismo día" stroke={APT_COLORS.navy} strokeWidth={2}
          dot={{ r: 3, fill: APT_COLORS.navy }} connectNulls />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

export const fmtDiasSt = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${fmtDec1(v)} d`)
