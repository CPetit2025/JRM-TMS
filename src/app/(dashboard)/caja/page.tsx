'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  AlertTriangle, Banknote, BarChart3, ClipboardCheck, FileCheck2, FileText, Fuel, Loader2, RefreshCw, UserRound, Wallet,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { daysAgo, money, type Row } from '@/lib/caja'

// Panel de la caja de transporte: saldos de cajas, dinero por rendir, bandeja de aprobación,
// viajes por liquidar y gasto aprobado del mes por categoría y unidad.

const supabase = createClient()

export default function CajaDashboardPage() {
  const { hasAccess } = usePermissions()
  const [loading, setLoading] = useState(true)
  const [boxes, setBoxes] = useState<Row[]>([])
  const [pending, setPending] = useState<Row[]>([])
  const [trips, setTrips] = useState<Row[]>([])
  const [accounts, setAccounts] = useState<Row[]>([])
  const [month, setMonth] = useState<Row[]>([])
  const [cats, setCats] = useState<Record<string, string>>({})
  const [appRequests, setAppRequests] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    const since = daysAgo(30)
    const [b, p, t, a, m, c, ar] = await Promise.all([
      supabase.from('vw_cash_box_balances').select('*').eq('is_active', true),
      supabase.from('dispatch_expenses').select('id, amount, alerts, status').in('status', ['PENDIENTE', 'OBSERVADO']),
      supabase.from('vw_caja_trip_status').select('dispatch_id, trip_finished, settlement_status, overdue, advances_delivered, expenses_count').gte('created_at', new Date(Date.now() - 120 * 864e5).toISOString()),
      supabase.from('vw_driver_cash_account').select('driver_id, balance, overdue_trips'),
      supabase.from('dispatch_expenses').select('expense_type, vehicle_plate, amount, approved_amount').eq('status', 'APROBADO').gte('expense_date', since),
      supabase.from('expense_categories').select('code, label'),
      supabase.from('trip_advances').select('id', { count: 'exact', head: true }).eq('source', 'APP').eq('status', 'SOLICITADO'),
    ])
    if (b.error && p.error) toast.error('Error al cargar el panel de caja')
    setBoxes(b.data || []); setPending(p.data || []); setTrips(t.data || []); setAccounts(a.data || []); setMonth(m.data || [])
    setCats(Object.fromEntries((c.data || []).map(x => [x.code, x.label])))
    setAppRequests(ar.count || 0)
    setLoading(false)
  }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  const k = useMemo(() => {
    const pend = pending.filter(e => e.status === 'PENDIENTE')
    return {
      cash: boxes.reduce((s, b) => s + Number(b.balance), 0),
      lowBoxes: boxes.filter(b => Number(b.balance) < Number(b.min_balance)).length,
      toRender: accounts.filter(a => Number(a.balance) > 0).reduce((s, a) => s + Number(a.balance), 0),
      owed: accounts.filter(a => Number(a.balance) < 0).reduce((s, a) => s - Number(a.balance), 0),
      pendingCount: pend.length,
      pendingAmount: pend.reduce((s, e) => s + Number(e.amount), 0),
      withAlerts: pend.filter(e => (e.alerts || []).length > 0).length,
      observed: pending.filter(e => e.status === 'OBSERVADO').length,
      toSettle: trips.filter(t => t.trip_finished && t.settlement_status !== 'CERRADA' && (Number(t.advances_delivered) > 0 || t.expenses_count > 0)).length,
      overdue: trips.filter(t => t.overdue).length,
      overdueDrivers: accounts.filter(a => a.overdue_trips > 0).length,
    }
  }, [boxes, pending, trips, accounts])

  const byCat = useMemo(() => {
    const g: Record<string, number> = {}
    month.forEach(e => { g[e.expense_type] = (g[e.expense_type] || 0) + Number(e.approved_amount ?? e.amount) })
    return Object.entries(g).sort(([, a], [, b]) => b - a)
  }, [month])
  const byPlate = useMemo(() => {
    const g: Record<string, number> = {}
    month.forEach(e => { if (e.vehicle_plate) g[e.vehicle_plate] = (g[e.vehicle_plate] || 0) + Number(e.approved_amount ?? e.amount) })
    return Object.entries(g).sort(([, a], [, b]) => b - a).slice(0, 8)
  }, [month])
  const monthTotal = byCat.reduce((s, [, v]) => s + v, 0)
  const maxCat = Math.max(1, ...byCat.map(([, v]) => v))
  const maxPlate = Math.max(1, ...byPlate.map(([, v]) => v))

  return (
    <div className="p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2"><Wallet className="w-6 h-6" />Caja de transporte</h1>
          <p className="text-sm text-slate-500">Dinero de cada viaje de principio a fin: presupuesto, anticipo, gastos, aprobación, liquidación y costo real.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className="px-3 py-2 border rounded-lg text-sm flex items-center gap-2 hover:bg-slate-50"><RefreshCw className="w-4 h-4" />Actualizar</button>
          {hasAccess('caja-gastos') && <Link href="/caja/gastos" className="px-4 py-2 border rounded-lg text-sm font-semibold flex items-center gap-2 bg-white"><FileText className="w-4 h-4" />Registrar gasto</Link>}
          {hasAccess('caja-anticipos') && <Link href="/caja/anticipos" className="px-4 py-2 bg-[#002855] text-white rounded-lg text-sm font-semibold flex items-center gap-2"><Banknote className="w-4 h-4" />Anticipos</Link>}
        </div>
      </div>

      {loading ? <div className="p-12 flex justify-center"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div> : <>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Tile href="/caja/cajas" icon={<Wallet className="w-4 h-4" />} label="Saldo en cajas" value={money(k.cash)} sub={k.lowBoxes ? `${k.lowBoxes} caja(s) bajo el mínimo` : `${boxes.length} cajas activas`} alert={k.lowBoxes > 0} />
          <Tile href="/caja/conductores" icon={<UserRound className="w-4 h-4" />} label="Por rendir (conductores)" value={money(k.toRender)} sub={k.owed ? `La empresa debe ${money(k.owed)}` : 'Anticipos sin rendir'} />
          <Tile href="/caja/aprobaciones" icon={<ClipboardCheck className="w-4 h-4" />} label="Gastos por aprobar" value={`${k.pendingCount}`} sub={`${money(k.pendingAmount)}${k.withAlerts ? ` · ${k.withAlerts} con alertas` : ''}`} alert={k.withAlerts > 0} />
          <Tile href="/caja/liquidaciones" icon={<FileCheck2 className="w-4 h-4" />} label="Viajes por liquidar" value={`${k.toSettle}`} sub={k.overdue ? `${k.overdue} vencidos` : 'Al día'} alert={k.overdue > 0} />
        </div>

        {appRequests > 0 && (
          <Link href="/caja/anticipos" className="block bg-violet-50 border border-violet-200 rounded-xl p-3 text-sm text-violet-900 hover:border-violet-400">
            <Banknote className="inline w-4 h-4 mr-1" /><b>{appRequests}</b> solicitud(es) de anticipo de conductores esperan atención.
          </Link>
        )}

        {(k.overdueDrivers > 0 || k.observed > 0) && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-900 flex flex-wrap gap-x-6 gap-y-1">
            <AlertTriangle className="w-4 h-4" />
            {k.overdueDrivers > 0 && <span><b>{k.overdueDrivers}</b> conductor(es) con rendición vencida: no reciben anticipos nuevos.</span>}
            {k.observed > 0 && <span><b>{k.observed}</b> gasto(s) observados esperan corrección.</span>}
          </div>
        )}

        <div className="grid lg:grid-cols-2 gap-4">
          <div className="bg-white border rounded-xl p-4">
            <div className="text-sm font-semibold text-slate-800 mb-3 flex justify-between"><span>Gasto aprobado por categoría · 30 días</span><span>{money(monthTotal, 0)}</span></div>
            {byCat.length === 0 ? <p className="text-sm text-slate-400">Sin gastos aprobados</p> : byCat.map(([c, v]) => (
              <div key={c} className="grid grid-cols-[9rem_1fr_6rem] gap-2 items-center text-xs mb-1.5">
                <span className="truncate">{cats[c] || c}</span>
                <div className="h-3 bg-slate-100 rounded"><div className="h-3 rounded bg-[#002855]" style={{ width: `${(v / maxCat) * 100}%` }} /></div>
                <span className="text-right font-semibold">{money(v, 0)}</span>
              </div>
            ))}
          </div>
          <div className="bg-white border rounded-xl p-4">
            <div className="text-sm font-semibold text-slate-800 mb-3">Unidades con mayor gasto · 30 días</div>
            {byPlate.length === 0 ? <p className="text-sm text-slate-400">Sin gastos aprobados</p> : byPlate.map(([p, v]) => (
              <div key={p} className="grid grid-cols-[6rem_1fr_6rem] gap-2 items-center text-xs mb-1.5">
                <span className="font-semibold">{p}</span>
                <div className="h-3 bg-slate-100 rounded"><div className="h-3 rounded bg-emerald-600" style={{ width: `${(v / maxPlate) * 100}%` }} /></div>
                <span className="text-right font-semibold">{money(v, 0)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          {hasAccess('caja-combustible') && <QuickLink href="/caja/combustible" icon={<Fuel className="w-4 h-4" />} label="Control de combustible" />}
          {hasAccess('caja-tarifario') && <QuickLink href="/caja/tarifario" icon={<BarChart3 className="w-4 h-4" />} label="Tarifario y reglas" />}
          <QuickLink href="/caja/reportes" icon={<BarChart3 className="w-4 h-4" />} label="Rentabilidad y exportación contable" />
          <QuickLink href="/mantenimiento/finanzas" icon={<BarChart3 className="w-4 h-4" />} label="TCO por unidad (Mantenimiento)" />
        </div>
      </>}
    </div>
  )
}

function Tile({ href, icon, label, value, sub, alert }: { href: string; icon: React.ReactNode; label: string; value: string; sub?: string; alert?: boolean }) {
  return (
    <Link href={href} className={`bg-white border rounded-xl p-4 hover:border-blue-300 transition ${alert ? 'border-red-200' : ''}`}>
      <div className="flex items-center gap-2 text-xs text-slate-500">{icon}{label}</div>
      <div className="text-2xl font-bold text-slate-900 mt-1">{value}</div>
      {sub && <div className={`text-xs ${alert ? 'text-red-600' : 'text-slate-400'}`}>{sub}</div>}
    </Link>
  )
}

function QuickLink({ href, icon, label }: { href: string; icon: React.ReactNode; label: string }) {
  return <Link href={href} className="bg-white border rounded-xl p-3 flex items-center gap-2 hover:border-blue-300">{icon}{label}</Link>
}
