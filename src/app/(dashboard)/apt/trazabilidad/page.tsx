'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ArrowRight, GitBranch, Search } from 'lucide-react'
import { ChartCard, EmptyState, ErrorBlock, LoadingBlock } from '@/components/apt/ui'
import { DiasPill, KindBadge, Table, td, tdNum, th } from '@/components/inventario/parts'
import { useInvQuery } from '@/components/inventario/useInvQuery'
import { invApi } from '@/lib/inventario/api'
import { CLASE_COLOR, CLASE_LABEL, KIND_COLOR, fmtN, fmtPeso, fmtQty } from '@/lib/inventario/format'
import type { InvTrace } from '@/lib/inventario/types'
import { fmtDate } from '@/lib/apt/format'

function Chips({ label, items, tone }: { label: string; items?: string[]; tone: string }) {
  if (!items?.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</span>
      {items.slice(0, 40).map(l => <Link key={l} href={`/apt/trazabilidad?q=${encodeURIComponent(l)}`} className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${tone}`}>{l}</Link>)}
      {items.length > 40 && <span className="text-xs text-slate-400">+{items.length - 40}</span>}
    </div>
  )
}

// Trazabilidad: busca un lote, OT, guía o número de documento y muestra su recorrido por las bodegas, de dónde vino
// (stock reasignado, servicio de terceros) y en qué terminó (despacho, consumo, saldo actual)
export default function InventarioTrazabilidadPage() {
  const sp = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const qParam = sp.get('q') ?? ''
  const [text, setText] = useState(qParam)
  const [bodega, setBodega] = useState('')
  const q = useInvQuery(`trace|${qParam}`, () => (qParam ? invApi.trace(qParam) : Promise.resolve(null as InvTrace | null)))
  const d = q.data
  const estadia = useMemo(() => new Map((d?.estadia ?? []).map(e => [e.bodega, e])), [d])
  const moves = useMemo(() => (d?.movimientos ?? []).filter(m => !bodega || m.bodega === bodega), [d, bodega])
  const reasig = useMemo(() => (d?.enlaces ?? []).filter(e => e.lote_origen !== e.lote_destino), [d])
  const search = (e: React.FormEvent) => { e.preventDefault(); setBodega(''); router.push(`${pathname}?q=${encodeURIComponent(text.trim())}`) }
  return (
    <div className="space-y-4">
      <form onSubmit={search} className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <label className="min-w-64 flex-1 text-xs font-semibold text-slate-600">Lote, OT, guía, número de documento u OP
          <span className="mt-1 flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 px-2"><Search className="h-4 w-4 text-slate-400" />
            <input value={text} onChange={e => setText(e.target.value)} placeholder="Ej.: 16339-S005, 16339, T001-00006734, 2870, 5293-30" className="w-full text-sm outline-none" /></span>
        </label>
        <button type="submit" disabled={text.trim().length < 3} className="min-h-11 rounded-lg bg-[#002855] px-5 text-sm font-semibold text-white disabled:opacity-50">Rastrear</button>
      </form>
      {!qParam ? <EmptyState title="Busque un lote, una OT o un documento">Verá en qué bodegas estuvo, cuánto tiempo, de qué stock vino (por ejemplo, pernería o 540 reasignados al contrato) y cómo salió.</EmptyState>
        : q.loading ? <LoadingBlock label="Rastreando…" /> : q.error ? <ErrorBlock message={q.error} onRetry={q.reload} />
        : !d?.encontrado ? <EmptyState title={`No se encontraron movimientos para «${qParam}»`}>Revise el lote o el número. Se buscan lotes, OT (contrato), números de documento y OP (NumRel).</EmptyState>
        : <>
          <ChartCard title={`Recorrido de «${d.q}»`} subtitle={`${fmtN(d.movimientos?.length)} movimientos${d.truncado ? ' (se muestran los primeros 3 000)' : ''}`}>
            <div className="space-y-2">
              <Chips label="Lotes buscados" items={d.lotes_buscados} tone="border-[#002855]/30 bg-blue-50 text-[#002855]" />
              <Chips label="Vino de" items={d.lotes_origen} tone="border-violet-200 bg-violet-50 text-violet-800" />
              <Chips label="Se convirtió en" items={d.lotes_derivados} tone="border-emerald-200 bg-emerald-50 text-emerald-800" />
              <Chips label="OP de producción" items={d.ops} tone="border-orange-200 bg-orange-50 text-orange-800" />
            </div>
            <div className="mt-4 flex flex-wrap items-stretch gap-2">
              {(d.etapas ?? []).map((e, i) => {
                const st = estadia.get(e.bodega)
                return <div key={e.bodega} className="flex items-center gap-2">
                  {i > 0 && <ArrowRight className="h-4 w-4 shrink-0 text-slate-300" />}
                  <button type="button" onClick={() => setBodega(bodega === e.bodega ? '' : e.bodega)} aria-pressed={bodega === e.bodega}
                    className={`min-w-44 rounded-xl border-2 bg-white p-3 text-left shadow-sm ${bodega === e.bodega ? 'ring-2 ring-[#002855]/30' : ''}`} style={{ borderColor: KIND_COLOR[e.kind] }}>
                    <p className="text-sm font-bold text-slate-800">{e.bodega}</p>
                    <KindBadge kind={e.kind} />
                    <p className="mt-1 text-[11px] text-slate-500">{fmtDate(e.primera)} – {fmtDate(e.ultima)}</p>
                    <p className="text-[11px] text-slate-600">Entra {fmtPeso(e.entradas_kg)} ({e.entradas}) · Sale {fmtPeso(e.salidas_kg)} ({e.salidas})</p>
                    {st && <p className="mt-1 flex items-center gap-1 text-[11px] text-slate-600">Estadía <DiasPill dias={st.prom_dias} title={`Máximo ${st.max_dias ?? '—'} d`} /></p>}
                  </button>
                </div>
              })}
            </div>
          </ChartCard>
          {reasig.length > 0 && <ChartCard title="Reasignaciones de lote" subtitle="Traspasos donde el stock cambió de lote (p. ej. pernería o 540 asignados a un contrato)">
            <Table head={<tr><th className={th}>Fecha</th><th className={th}>Documento</th><th className={th}>Origen</th><th className={th}>Lote origen</th><th className={th} /><th className={th}>Destino</th><th className={th}>Lote destino</th><th className={`${th} text-right`}>Cantidad</th></tr>}>
              {reasig.slice(0, 200).map(e => <tr key={`${e.out_id}-${e.in_id}`}>
                <td className={td}>{fmtDate(e.fecha)}</td><td className={td}>{e.numero}</td><td className={td}>{e.origen}</td>
                <td className={td}>{e.lote_origen ?? 'Sin lote'}</td><td className={td}><GitBranch className="h-3.5 w-3.5 text-slate-400" /></td>
                <td className={td}>{e.destino}</td><td className={`${td} font-semibold`}>{e.lote_destino ?? 'Sin lote'}</td><td className={tdNum}>{fmtQty(e.qty)}</td>
              </tr>)}
            </Table>
          </ChartCard>}
          {(d.saldo?.length ?? 0) > 0 && <ChartCard title="Saldo actual de estos lotes" subtitle="Lo que todavía está en alguna bodega">
            <Table head={<tr><th className={th}>Bodega</th><th className={th}>Producto</th><th className={th}>Lote</th><th className={`${th} text-right`}>Cantidad</th><th className={`${th} text-right`}>Peso</th><th className={th}>Ingreso</th></tr>}>
              {d.saldo!.map((s, i) => <tr key={i}><td className={td}>{s.bodega}</td><td className={`${td} font-mono text-[11px]`}>{s.producto}</td><td className={td}>{s.lote ?? '—'}</td>
                <td className={tdNum}>{fmtQty(s.qty)}{s.inferido > 0 && <span className="ml-1 text-[10px] text-amber-700">({fmtQty(s.inferido)} inferido)</span>}</td>
                <td className={tdNum}>{fmtPeso(s.kg)}</td><td className={td}>{s.fecha_ingreso ? fmtDate(s.fecha_ingreso) : 'Saldo inicial'}</td></tr>)}
            </Table>
          </ChartCard>}
          <ChartCard title="Movimientos" subtitle={bodega ? `Solo ${bodega} · toque la tarjeta otra vez para ver todos` : 'En orden cronológico · toque una bodega para filtrar'}>
            <Table empty={!moves.length} head={<tr><th className={th}>Fecha</th><th className={th}>Bodega</th><th className={th}>Movimiento</th><th className={th}>Documento</th><th className={th}>Producto</th><th className={th}>Lote</th><th className={`${th} text-right`}>Cantidad</th><th className={`${th} text-right`}>Peso</th><th className={th}>Cliente / proveedor</th></tr>}>
              {moves.map(m => <tr key={m.id} className="hover:bg-slate-50">
                <td className={`${td} whitespace-nowrap`}>{fmtDate(m.fecha)}</td><td className={td}>{m.bodega}</td>
                <td className={td}><span className="inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-bold text-white" style={{ background: CLASE_COLOR[m.clase] ?? '#94a3b8' }}>{m.side === 'E' ? '↓' : '↑'} {CLASE_LABEL[m.clase] ?? m.clase}</span>
                  <p className="mt-0.5 text-[10px] text-slate-500">{m.tipodocto}</p></td>
                <td className={td}>{m.numero}{m.num_rel && <p className="text-[10px] text-slate-500">{m.doc_rel ? `${m.doc_rel}: ` : 'Ref.: '}{m.num_rel}</p>}</td>
                <td className={td}><p className="font-mono text-[11px] text-slate-500">{m.producto}</p><p className="max-w-72 text-slate-700">{m.glosa}</p></td>
                <td className={td}>{m.lote ?? '—'}</td>
                <td className={`${tdNum} ${m.cantidad < 0 ? 'text-red-700' : 'text-emerald-700'}`}>{fmtQty(m.cantidad)} <span className="text-slate-400">{m.unidad}</span></td>
                <td className={tdNum}>{m.kg ? fmtPeso(m.kg) : '—'}</td><td className={td}>{m.razon_social ?? '—'}</td>
              </tr>)}
            </Table>
          </ChartCard>
        </>}
    </div>
  )
}
