'use client'

import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, FileText, Layers, Loader2, MapPin, Pencil, UserCog } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from '@/components/ui/modal'

// Vista rápida de un contrato/OT al hacer clic en la tabla: partida, componentes y últimas solicitudes,
// con accesos a editar, asignar responsable y abrir la ficha completa.

export type QuickContract = {
  id: string
  code: string
  type: string
  status: string
  created_at: string
  total_weight_kg?: number
  destination_district?: string
  destination_address?: string
  clients?: { business_name: string }
}

type Budget = { allocated_pen: number | null; reserved_pen: number | null; consumed_pen: number | null; balance_pen: number | null }
type Child = { id: string; code: string; type: string; status: string }
type Req = { id: string; request_number: string; status: string; required_date: string | null; delivery_district: string | null }

const money = (n: number | null | undefined) => `S/ ${Number(n || 0).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const TYPE_LABEL: Record<string, string> = { CONTRATO: 'Contrato madre', SUBCONTRATO: 'Subcontrato', ERROR: 'Error', OT_INDEPENDIENTE: 'OT independiente' }

export function ContractQuickView({ contract, responsible, isAdmin, onClose, onEdit, onAssign, onOpen }: {
  contract: QuickContract | null
  responsible?: string
  isAdmin: boolean
  onClose: () => void
  onEdit: () => void
  onAssign: () => void
  onOpen: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [data, setData] = useState<{ budget: Budget | null; children: Child[]; requests: Req[] } | null>(null)
  const contractId = contract?.id

  useEffect(() => {
    if (!contractId) return
    let cancel = false
    const run = async () => {
      setData(null)
      const [b, c, r] = await Promise.all([
        supabase.from('contract_budgets').select('allocated_pen, reserved_pen, consumed_pen, balance_pen')
          .eq('contract_id', contractId).eq('concept', 'PARTIDA_TRANSPORTE').maybeSingle(),
        supabase.from('contracts').select('id, code, type, status').eq('parent_contract_id', contractId).order('code'),
        supabase.from('transport_requests').select('id, request_number, status, required_date, delivery_district')
          .eq('contract_id', contractId).order('created_at', { ascending: false }).limit(5),
      ])
      if (cancel) return
      setData({ budget: (b.data as Budget) || null, children: (c.data || []) as Child[], requests: (r.data || []) as Req[] })
    }
    void run()
    return () => { cancel = true }
  }, [supabase, contractId])

  const budget = data?.budget
  const allocated = Number(budget?.allocated_pen || 0)
  const pct = (n: number | null | undefined) => (allocated > 0 ? Math.min(100, (Number(n || 0) / allocated) * 100) : 0)
  const balance = Number(budget?.balance_pen || 0)

  return (
    <Modal isOpen={!!contract} onClose={onClose} title={contract ? `${contract.code} · ${TYPE_LABEL[contract.type] || contract.type}` : ''} maxWidth="max-w-2xl">
      {contract && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-lg font-semibold text-[#002855]">{contract.clients?.business_name || 'Sin cliente'}</div>
              {(contract.destination_district || contract.destination_address) && (
                <div className="mt-0.5 flex items-center gap-1 text-sm text-slate-500">
                  <MapPin className="h-3.5 w-3.5" />{[contract.destination_district, contract.destination_address].filter(Boolean).join(' · ')}
                </div>
              )}
            </div>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${contract.status === 'ACTIVO' ? 'bg-emerald-50 text-emerald-700' : contract.status === 'SUSPENDIDO' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>{contract.status}</span>
          </div>

          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <div><dt className="text-xs text-slate-500">Fecha de alta</dt><dd className="font-medium text-slate-800">{new Date(contract.created_at).toLocaleDateString('es-PE')}</dd></div>
            <div><dt className="text-xs text-slate-500">Carga contractual</dt><dd className="font-medium text-slate-800">{Number(contract.total_weight_kg || 0).toLocaleString('es-PE')} kg</dd></div>
            <div><dt className="text-xs text-slate-500">Responsable</dt><dd className={`font-medium ${responsible ? 'text-slate-800' : 'text-slate-400'}`}>{responsible || 'Sin asignar'}</dd></div>
          </dl>

          <div className="rounded-lg border border-slate-200 p-3">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-sm font-semibold text-slate-800">Partida de transporte</span>
              {data && <span className={`text-lg font-bold tabular-nums ${balance < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{money(balance)} <span className="text-xs font-normal text-slate-500">saldo</span></span>}
            </div>
            {!data ? <Loader2 className="h-4 w-4 animate-spin text-slate-400" /> : !budget ? <p className="text-sm text-slate-400">Sin partida asignada.</p> : <>
              <div className="flex h-2 overflow-hidden rounded-full bg-slate-100">
                <div className="bg-slate-500" style={{ width: `${pct(budget.consumed_pen)}%` }} title="Consumido" />
                <div className="bg-amber-400" style={{ width: `${pct(budget.reserved_pen)}%` }} title="Reservado" />
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                <div><span className="text-slate-500">Asignado</span><div className="font-semibold tabular-nums text-slate-800">{money(budget.allocated_pen)}</div></div>
                <div><span className="inline-flex items-center gap-1 text-slate-500"><span className="h-2 w-2 rounded-full bg-amber-400" />Reservado</span><div className="font-semibold tabular-nums text-slate-800">{money(budget.reserved_pen)}</div></div>
                <div><span className="inline-flex items-center gap-1 text-slate-500"><span className="h-2 w-2 rounded-full bg-slate-500" />Consumido</span><div className="font-semibold tabular-nums text-slate-800">{money(budget.consumed_pen)}</div></div>
              </div>
            </>}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-slate-800"><Layers className="h-4 w-4" />Subcontratos y errores</div>
              {!data ? <Loader2 className="h-4 w-4 animate-spin text-slate-400" /> : data.children.length === 0 ? <p className="text-xs text-slate-400">Sin componentes.</p> : (
                <ul className="space-y-1 text-sm">
                  {data.children.map(c => (
                    <li key={c.id} className="flex items-center gap-2">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${c.type === 'ERROR' ? 'bg-red-100 text-red-800' : 'bg-purple-100 text-purple-800'}`}>{c.type === 'ERROR' ? 'Error' : 'Sub'}</span>
                      <span className="font-medium text-slate-700">{c.code}</span>
                      <span className="text-xs text-slate-400">{c.status}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-slate-800"><FileText className="h-4 w-4" />Últimas solicitudes</div>
              {!data ? <Loader2 className="h-4 w-4 animate-spin text-slate-400" /> : data.requests.length === 0 ? <p className="text-xs text-slate-400">Sin solicitudes.</p> : (
                <ul className="space-y-1 text-sm">
                  {data.requests.map(r => (
                    <li key={r.id} className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-700">{r.request_number}</span>
                      <span className="truncate text-xs text-slate-500">{r.status}{r.required_date ? ` · ${new Date(r.required_date).toLocaleDateString('es-PE')}` : ''}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
            {isAdmin && <button type="button" onClick={onAssign} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"><UserCog className="h-4 w-4" />Responsable</button>}
            <button type="button" onClick={onEdit} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"><Pencil className="h-4 w-4" />Editar</button>
            <button type="button" onClick={onOpen} className="inline-flex items-center gap-1.5 rounded-lg bg-[#002855] px-3 py-2 text-sm font-semibold text-white hover:bg-[#001d3d]"><ExternalLink className="h-4 w-4" />Abrir ficha completa</button>
          </div>
        </div>
      )}
    </Modal>
  )
}
