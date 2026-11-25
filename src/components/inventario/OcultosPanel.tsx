'use client'

import { useState } from 'react'
import { EyeOff } from 'lucide-react'
import { ChartCard, ErrorBlock } from '@/components/apt/ui'
import { Table, td, tdNum, th } from '@/components/inventario/parts'
import { useInvQuery } from '@/components/inventario/useInvQuery'
import { invApi, notifyInvUpdated } from '@/lib/inventario/api'
import { fmtPeso } from '@/lib/inventario/format'
import { fmtDateTime } from '@/lib/apt/format'

// Contratos u OT ocultos del modelo APT por errores del sistema: no se borran, el recálculo los deja fuera
export function OcultosPanel() {
  const q = useInvQuery('ocultos', () => invApi.ocultos())
  const [codigo, setCodigo] = useState('')
  const [motivo, setMotivo] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const guardar = async (p: { codigo: string; motivo?: string; ocultar: boolean }) => {
    setBusy(true); setMsg(null)
    try {
      const r = await invApi.saveOculto(p)
      setMsg({ ok: true, text: `${r.codigo} ${p.ocultar ? 'oculto' : 'visible de nuevo'}: se aplica en el próximo recálculo (unos minutos).` })
      if (p.ocultar) { setCodigo(''); setMotivo('') }
      q.reload(); notifyInvUpdated()
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : 'No se pudo guardar' }) } finally { setBusy(false) }
  }
  const puede = q.data?.puede_editar ?? false
  return (
    <ChartCard title="Contratos ocultos" subtitle="Contratos u OT excluidos del APT por errores del sistema"
      info="Un contrato oculto sale de Resumen, Contratos / OT, Stock, Estadía, Trazabilidad y Flujo en el próximo recálculo. No se borra nada: sus movimientos del ERP quedan guardados y al volver a mostrarlo reaparece igual. Un código de OT (15603) oculta también sus subcontratos (15603-S001…); un código completo (15603-S002) oculta solo ese lote.">
      {q.error ? <ErrorBlock message={q.error} onRetry={q.reload} /> : <div className="space-y-3">
        {puede && <form onSubmit={e => { e.preventDefault(); guardar({ codigo, motivo, ocultar: true }) }} className="flex flex-wrap items-end gap-2">
          <label className="text-xs font-semibold text-slate-600">Contrato u OT
            <input required value={codigo} onChange={e => setCodigo(e.target.value)} placeholder="Ej. 15603-S002" className="mt-1 block min-h-10 w-40 rounded-lg border border-slate-300 px-2 text-sm" />
          </label>
          <label className="min-w-64 flex-1 text-xs font-semibold text-slate-600">Motivo
            <input required minLength={3} value={motivo} onChange={e => setMotivo(e.target.value)} placeholder="Ej. ingreso duplicado en el ERP" className="mt-1 block min-h-10 w-full rounded-lg border border-slate-300 px-2 text-sm" />
          </label>
          <button type="submit" disabled={busy} className="flex min-h-10 items-center gap-2 rounded-lg bg-[#002855] px-3 text-sm font-semibold text-white disabled:opacity-50"><EyeOff className="h-4 w-4" /> Ocultar</button>
        </form>}
        {msg && <p role="status" className={`text-xs font-semibold ${msg.ok ? 'text-emerald-700' : 'text-red-700'}`}>{msg.text}</p>}
        <Table empty={!q.loading && !q.data?.filas.length} head={<tr><th className={th}>Contrato / OT</th><th className={th}>Motivo</th><th className={th}>Ocultó</th><th className={th}>Fecha</th><th className={`${th} text-right`}>Stock en APT</th>{puede && <th className={th} />}</tr>}>
          {q.data?.filas.map(o => <tr key={o.codigo} className="hover:bg-slate-50">
            <td className={`${td} font-semibold text-slate-800`}>{o.codigo}</td><td className={td}>{o.motivo}</td>
            <td className={td}>{o.usuario ?? '—'}</td><td className={`${td} whitespace-nowrap`}>{fmtDateTime(o.fecha)}</td><td className={tdNum}>{fmtPeso(o.stock_kg)}</td>
            {puede && <td className={td}><button type="button" disabled={busy} onClick={() => guardar({ codigo: o.codigo, ocultar: false })} className="min-h-8 rounded-lg border border-slate-300 px-2 text-xs font-semibold text-[#002855] disabled:opacity-50">Mostrar de nuevo</button></td>}
          </tr>)}
        </Table>
      </div>}
    </ChartCard>
  )
}
