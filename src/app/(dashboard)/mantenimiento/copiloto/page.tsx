'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Bot, Loader2, RefreshCw, MessageSquare } from 'lucide-react'

// Copiloto CMMS (Fase 12): respuestas con datos reales (get_cmms_copilot_brief, SECURITY INVOKER) y
// acceso a JRM IA con herramientas del CMMS. La IA es asistiva: no modifica datos; las acciones pasan
// por las reglas del backend (migración 20260928150000). Reemplaza el copiloto simulado anterior.

const supabase = createClient()
type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const money = (n: unknown) => `S/ ${Number(n || 0).toLocaleString('es-PE', { maximumFractionDigits: 0 })}`

function askAi(question: string) {
  window.dispatchEvent(new CustomEvent('jrm:open-ai', { detail: { question } }))
}

export default function CopilotoPage() {
  const [brief, setBrief] = useState<Row | null>(null)
  const [loading, setLoading] = useState(true)

  const apply = useCallback(({ data, error }: { data: unknown; error: { message: string } | null }) => {
    if (error) toast.error('No se pudo generar el resumen: ' + error.message)
    setBrief((data as Row) || null)
    setLoading(false)
  }, [])
  const refresh = useCallback(() => { setLoading(true); return supabase.rpc('get_cmms_copilot_brief', { p_plates: null }).then(apply) }, [apply])
  useEffect(() => { supabase.rpc('get_cmms_copilot_brief', { p_plates: null }).then(apply) }, [apply])

  const sections: { q: string; key: string; render: (items: Row[]) => React.ReactNode }[] = [
    { q: '¿Qué unidades están bloqueadas y por qué no están disponibles?', key: 'blocked_or_unavailable', render: items => items.map(b => (
      <li key={b.plate}><Link href={`/mantenimiento/flota/${b.plate}`} className="font-semibold text-[#002855]">{b.plate}</Link> · {b.status} · {b.eligibility}
        {(b.motives || []).length > 0 && <ul className="ml-4 list-disc text-slate-600">{b.motives.map((m: string) => <li key={m}>{m}</li>)}</ul>}</li>)) },
    { q: '¿Qué mantenimiento vence?', key: 'maintenance_due', render: items => items.map((m, i) => (
      <li key={i}><b>{m.plate}</b> · {m.plan} · <span className={m.alert === 'VENCIDO' ? 'text-red-600 font-semibold' : 'text-amber-600'}>{m.alert}</span> por {String(m.driver).toLowerCase()}{m.projected_date ? ` · ${m.projected_date}` : ''}{m.open_work_order ? ` · OT ${m.open_work_order}` : ''}</li>)) },
    { q: '¿Qué unidad cuesta más mantener? (365 días)', key: 'top_cost_units', render: items => items.map(u => <li key={u.plate}><b>{u.plate}</b> · TCO {money(u.cost_365d)} · mantenimiento {money(u.maintenance_365d)}</li>) },
    { q: '¿Qué fallas son recurrentes?', key: 'recurrent_failures', render: items => items.map(r => <li key={r.plate}><b>{r.plate}</b> · {r.reports_90d} reportes en 90 días · última: {r.last}</li>) },
    { q: '¿Qué repuestos están por debajo del mínimo?', key: 'parts_below_minimum', render: items => items.map(p => <li key={p.code}><b>{p.code}</b> {p.name} · disponible {p.available} / mínimo {p.minimum}{p.replenishment ? ` · reposición ${p.replenishment}` : ''}</li>) },
    { q: '¿Qué taller presenta más retrabajos?', key: 'provider_reworks', render: items => items.map(p => <li key={p.provider}><b>{p.provider}</b> · {p.reworks} retrabajos · {p.warranty_claims} reclamos · índice de calidad {p.quality_index ?? '—'}</li>) },
    { q: 'Anomalías detectadas (IA predictiva)', key: 'anomalies', render: items => items.map((a, i) => <li key={i}><b>{a.plate}</b> · {String(a.type).replace('_', ' ').toLowerCase()}: {a.detail}</li>) },
  ]

  return (
    <div className="p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2"><Bot className="w-6 h-6" />Copiloto de mantenimiento</h1>
          <p className="text-sm text-slate-500">{brief?.disclaimer || 'Respuestas calculadas con datos reales del CMMS.'}</p>
        </div>
        <button onClick={refresh} className="px-3 py-2 border rounded-lg text-sm flex items-center gap-2"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />Actualizar</button>
      </div>

      {loading ? <div className="p-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div> : !brief ? (
        <p className="text-sm text-slate-500">No hay datos disponibles con sus permisos.</p>
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          {sections.map(s => {
            const items = (brief[s.key] || []) as Row[]
            return (
              <div key={s.key} className="bg-white border rounded-xl p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-semibold text-slate-800">{s.q}</h3>
                  <button onClick={() => askAi(s.q)} title="Preguntar a JRM IA" className="p-1.5 border rounded-lg text-slate-500 hover:text-[#002855]"><MessageSquare className="w-4 h-4" /></button>
                </div>
                {items.length === 0 ? <p className="text-sm text-emerald-700">Sin casos.</p> : <ul className="text-sm space-y-1.5 max-h-64 overflow-y-auto">{s.render(items)}</ul>}
              </div>
            )
          })}
        </div>
      )}
      {brief?.generated_at && <p className="text-xs text-slate-400">Generado: {new Date(brief.generated_at).toLocaleString('es-PE')}</p>}
    </div>
  )
}
