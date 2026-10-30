'use client'
import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { errorMessage, money } from '@/lib/caja'

// Indicadores de costos de servicios (Etapa 6): variación referencial → acordado y acordado → final (solo sobre lo que ya
// tiene costo final), adicionales, pendientes de cierre documentario y económico, y costos por tipo, proveedor y OT junto a
// la partida de transporte de cada OT.

type Amounts = { items: number; with_final: number; referential_pen: number; agreed_pen: number; agreed_with_final_pen: number; final_pen: number; extras_pen: number }
type Budget = { allocated_pen: number; reserved_pen: number; consumed_pen: number; balance_pen: number } | null
type Data = {
  success: true; routes: number; totals: Amounts
  by_type: (Amounts & { concept: string })[]
  by_supplier: (Amounts & { supplier: string; concepts: string })[]
  by_contract: (Amounts & { contract_id: string | null; code: string; routes: number; budget: Budget })[]
  pending: { routes_open: number; economic_pending: number; economic_review: number; economic_closed: number; documentary_pending_services: number; documentary_complete_economic_pending: number }
}
const LABEL: Record<string, string> = { FLETE: 'Transporte (flete)', MONTACARGAS: 'Montacargas', GRUA: 'Grúa', ESTIBA: 'Estiba', OTROS: 'Otros' }

function Var({ base, value }: { base: number; value: number }) {
  const d = Math.round((Number(value) - Number(base)) * 100) / 100
  if (!Number(base) && !d) return <span className="text-slate-400">—</span>
  const pct = Number(base) ? Math.round(d / Number(base) * 1000) / 10 : null
  return <span className={d > 0 ? 'text-red-700' : d < 0 ? 'text-emerald-700' : 'text-slate-600'}>{d > 0 ? '+' : ''}{money(d)}{pct != null ? ` (${d > 0 ? '+' : ''}${pct}%)` : ''}</span>
}

function AmountsTable({ rows, first, label }: { rows: (Amounts & { key: string; extra?: React.ReactNode })[]; first: string; label: (r: { key: string }) => React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full min-w-[56rem] text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr>
          <th className="px-3 py-2">{first}</th><th className="px-3 py-2 text-right">Referencial</th><th className="px-3 py-2 text-right">Acordado</th>
          <th className="px-3 py-2 text-right">Ref. → acordado</th><th className="px-3 py-2 text-right">Final</th><th className="px-3 py-2 text-right">Acordado → final</th>
          <th className="px-3 py-2 text-right">Adicionales</th><th className="px-3 py-2 text-right">Con final</th>
        </tr></thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map(r => <tr key={r.key}>
            <td className="px-3 py-2">{label(r)}{r.extra}</td>
            <td className="px-3 py-2 text-right tabular-nums">{money(Number(r.referential_pen))}</td>
            <td className="px-3 py-2 text-right tabular-nums">{money(Number(r.agreed_pen))}</td>
            <td className="px-3 py-2 text-right tabular-nums text-xs"><Var base={r.referential_pen} value={r.agreed_pen} /></td>
            <td className="px-3 py-2 text-right tabular-nums">{r.with_final ? money(Number(r.final_pen)) : '—'}</td>
            <td className="px-3 py-2 text-right tabular-nums text-xs">{r.with_final ? <Var base={r.agreed_with_final_pen} value={r.final_pen} /> : '—'}</td>
            <td className="px-3 py-2 text-right tabular-nums">{Number(r.extras_pen) ? money(Number(r.extras_pen)) : '—'}</td>
            <td className="px-3 py-2 text-right text-xs text-slate-600">{r.with_final}/{r.items}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
  )
}

export function ServiceCostIndicators({ from, to }: { from: string; to: string }) {
  const [data, setData] = useState<Data | null>(null)
  useEffect(() => {
    let alive = true
    const supabase = createClient()
    void supabase.rpc('service_cost_indicators', { p_from: from, p_to: to }).then(({ data: out, error }) => {
      if (!alive) return
      if (error || !out?.success) { toast.error(error ? errorMessage(error) : out?.error); return }
      setData(out as Data)
    })
    return () => { alive = false }
  }, [from, to])
  if (!data) return <p className="flex justify-center p-8"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></p>

  const t = data.totals, p = data.pending
  const tile = 'rounded-xl border border-slate-200 bg-white p-3'
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className={tile}><p className="text-xs text-slate-500">Referencial → acordado ({data.routes} rutas)</p>
          <p className="text-lg font-bold tabular-nums">S/ {money(Number(t.agreed_pen))}</p><p className="text-xs"><Var base={t.referential_pen} value={t.agreed_pen} /> sobre S/ {money(Number(t.referential_pen))}</p></div>
        <div className={tile}><p className="text-xs text-slate-500">Acordado → final ({t.with_final}/{t.items} costos con final)</p>
          <p className="text-lg font-bold tabular-nums">S/ {money(Number(t.final_pen))}</p><p className="text-xs"><Var base={t.agreed_with_final_pen} value={t.final_pen} /> sobre S/ {money(Number(t.agreed_with_final_pen))}</p></div>
        <div className={tile}><p className="text-xs text-slate-500">Adicionales</p><p className="text-lg font-bold tabular-nums">S/ {money(Number(t.extras_pen))}</p>
          <p className="text-xs text-slate-500">{Number(t.final_pen) ? `${Math.round(Number(t.extras_pen) / Number(t.final_pen) * 1000) / 10}% del costo final` : '—'}</p></div>
        <div className={tile}><p className="text-xs text-slate-500">Cierres pendientes</p>
          <p className="text-sm"><b>{p.economic_pending}</b> económicos por enviar · <b>{p.economic_review}</b> en revisión · <b>{p.economic_closed}</b> cerrados</p>
          <p className="text-sm"><b>{p.documentary_pending_services}</b> servicios con cierre documentario pendiente</p>
          <p className="text-xs text-slate-500">{p.documentary_complete_economic_pending} rutas con documentación completa y costo pendiente · {p.routes_open} rutas sin cerrar</p></div>
      </div>

      <section><h3 className="mb-2 font-bold text-slate-800">Por tipo de servicio</h3>
        <AmountsTable first="Servicio" rows={data.by_type.map(r => ({ ...r, key: r.concept }))} label={r => LABEL[r.key] || r.key} /></section>
      <section><h3 className="mb-2 font-bold text-slate-800">Por OT y partida de transporte</h3>
        <AmountsTable first="OT" rows={data.by_contract.map(r => ({ ...r, key: r.contract_id || r.code, extra: r.budget ? (
          <span className="block text-[11px] text-slate-500">Partida S/ {money(Number(r.budget.allocated_pen))} · consumido {money(Number(r.budget.consumed_pen))} · reservado {money(Number(r.budget.reserved_pen))} · saldo{' '}
            <b className={Number(r.budget.balance_pen) < 0 ? 'text-red-700' : ''}>{money(Number(r.budget.balance_pen))}</b>
            {Number(r.budget.allocated_pen) > 0 && ` · uso ${Math.round((Number(r.budget.consumed_pen) + Number(r.budget.reserved_pen)) / Number(r.budget.allocated_pen) * 100)}% (operativo 80%)`}</span>
        ) : <span className="block text-[11px] text-slate-500">{r.routes} rutas · sin partida (OC/OS/RQ)</span> }))}
          label={r => <b>{data.by_contract.find(x => (x.contract_id || x.code) === r.key)?.code}</b>} /></section>
      <section><h3 className="mb-2 font-bold text-slate-800">Por proveedor</h3>
        <AmountsTable first="Proveedor" rows={data.by_supplier.map(r => ({ ...r, key: r.supplier, extra: <span className="block text-[11px] text-slate-500">{r.concepts.split(', ').map(c => LABEL[c] || c).join(', ')}</span> }))}
          label={r => r.key} /></section>
      <p className="text-[11px] text-slate-500">La variación acordado → final se calcula solo sobre los costos que ya tienen final. Rutas mixtas: el flete se cuenta una vez, por OT.</p>
    </div>
  )
}
