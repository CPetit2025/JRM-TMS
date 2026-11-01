"use client"
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { errorMessage, money } from '@/lib/caja'
import { BudgetAuthorizations, type AuthorizationTarget } from '@/components/despacho/BudgetAuthorizations'
import { BudgetDeviations } from '@/components/despacho/BudgetDeviations'
import { ControlPresupuestalTabs } from '@/components/despacho/ControlPresupuestalTabs'

// Pendientes con dato que los respalde (budget_pending): causa, importe, antigüedad, quién registró (si consta) y la acción.
// Los desvíos y las autorizaciones sobre el tope siguen en sus propios flujos, aquí mismo.

type Pending = { kind: string; contract_id: string; contract_code: string; dispatch_id: string | null; dispatch_number: string | null
  ref: string | null; cause: string; amount_pen: number; since: string | null; age_days: number | null; registered_by: string | null; action: string }

const supabase = createClient()
const KIND: Record<string, string> = {
  CONCILIACION: 'Diferencia de conciliación', SIN_IMPUTAR: 'Costo sin imputar', POR_IMPUTAR: 'Por imputar al cierre',
  COMBUSTIBLE_ESTIMADO: 'Combustible estimado', SIN_SUSTENTO: 'Sin sustento', POSIBLE_DUPLICADO: 'Posible duplicado',
}
const link = (p: Pending) => p.dispatch_id ? { href: `/despacho/documentos/economico?despacho=${p.dispatch_id}`, label: `Abrir ruta ${p.dispatch_number || ''}` }
  : p.kind === 'CONCILIACION' ? { href: `/despacho/control-presupuestal/movimientos?ot=${p.contract_id}`, label: 'Ver movimientos' }
  : { href: `/despacho/control-presupuestal/movimientos?ot=${p.contract_id}&q=${encodeURIComponent(p.ref?.slice(4) || '')}`, label: 'Ver el cargo' }

function Pendientes() {
  const params = useSearchParams()
  const requested = params.get('solicitar')
  const [rows, setRows] = useState<Pending[] | null>(null)
  const [kind, setKind] = useState('')
  // Desde el Resumen por OT: abre la solicitud de autorización de esa OT
  const [target, setTarget] = useState<AuthorizationTarget | null>(() => requested ? { contract_id: requested, code: params.get('codigo') || '' } : null)

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('budget_pending')
    if (error || !data?.success) { toast.error(error ? errorMessage(error) : data?.error); setRows([]); return }
    setRows(data.rows as Pending[])
  }, [])
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) }, [load])

  const counts = useMemo(() => (rows || []).reduce<Record<string, number>>((a, r) => ({ ...a, [r.kind]: (a[r.kind] || 0) + 1 }), {}), [rows])
  const shown = (rows || []).filter(r => !kind || r.kind === kind)

  return (
    <div className="min-w-0 space-y-3">
      <PageHeader showTitle title="Control presupuestal" description="Lo que queda por resolver en las partidas: diferencias, costos sin imputar o estimados, cargos sin sustento, desvíos y autorizaciones."
        actions={<button type="button" onClick={() => void load()} className="flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm hover:bg-slate-50"><RefreshCw className="h-4 w-4" />Actualizar</button>} />
      <ControlPresupuestalTabs active="pendientes" />

      <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap items-center gap-1">
          <button type="button" onClick={() => setKind('')} className={`rounded-full px-3 py-1 text-xs font-semibold ${!kind ? 'bg-[#002855] text-white' : 'bg-slate-100 text-slate-700'}`}>Todos ({rows?.length ?? 0})</button>
          {Object.entries(KIND).filter(([k]) => counts[k]).map(([k, label]) => <button key={k} type="button" onClick={() => setKind(k)}
            className={`rounded-full px-3 py-1 text-xs font-semibold ${kind === k ? 'bg-[#002855] text-white' : 'bg-slate-100 text-slate-700'}`}>{label} ({counts[k]})</button>)}
        </div>
        {rows === null ? <p className="p-6 text-center text-sm text-slate-500">Cargando…</p>
          : !shown.length ? <p className="p-6 text-center text-sm text-slate-500">Sin pendientes en las partidas.</p>
          : <div className="overflow-x-auto"><table className="w-full min-w-[56rem] text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr>
              <th className="px-3 py-2">Tipo</th><th className="px-3 py-2">OT</th><th className="px-3 py-2">Causa</th><th className="px-3 py-2 text-right">Importe</th>
              <th className="px-3 py-2">Antigüedad</th><th className="px-3 py-2">Registró</th><th className="px-3 py-2">Acción</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {shown.map((p, i) => { const l = link(p)
                return <tr key={`${p.kind}:${p.ref || p.contract_id}:${i}`} className="hover:bg-slate-50">
                  <td className="px-3 py-2 text-xs font-semibold">{KIND[p.kind] || p.kind}</td>
                  <td className="px-3 py-2"><Link href={`/despacho/control-presupuestal/movimientos?ot=${p.contract_id}`} className="font-bold text-[#002855] underline">{p.contract_code}</Link></td>
                  <td className="px-3 py-2 text-xs">{p.cause}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(Number(p.amount_pen))}</td>
                  <td className="px-3 py-2 text-xs">{p.age_days == null ? '—' : `${p.age_days} día(s)`}</td>
                  <td className="px-3 py-2 text-xs">{p.registered_by || '—'}</td>
                  <td className="px-3 py-2 text-xs">{p.action}<Link href={l.href} className="block font-semibold text-[#002855] underline">{l.label}</Link></td>
                </tr> })}
            </tbody>
          </table></div>}
      </section>

      <div className="grid items-start gap-3 xl:grid-cols-2">
        <BudgetDeviations onChanged={() => void load()} />
        <BudgetAuthorizations target={target} onTargetDone={() => setTarget(null)} onChanged={() => void load()} />
      </div>
    </div>
  )
}

export default function PendientesPage() {
  return <Suspense fallback={null}><Pendientes /></Suspense>
}
