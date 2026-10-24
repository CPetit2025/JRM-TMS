'use client'

import { useState } from 'react'
import { fmtN, fmtPeso } from '@/lib/inventario/format'
import { fmtDateTime } from '@/lib/apt/format'
import { ERP_KIND_LABEL, parseErpWorkbooks, type ErpParseResult } from '@/lib/erp/parse'
import type { ErpEstado } from '@/lib/erp/types'

// Lee en un worker; si el navegador no puede crearlo, en el hilo principal
export function readErpFiles(files: File[], onProgress: (m: string) => void): Promise<ErpParseResult> {
  return new Promise((resolve, reject) => {
    const fallback = () => {
      setTimeout(async () => {
        try {
          const inputs = await Promise.all(files.map(async f => ({ name: f.name, data: await f.arrayBuffer() })))
          resolve(parseErpWorkbooks(inputs, onProgress))
        } catch (e) { reject(e) }
      }, 50)
    }
    let worker: Worker
    try { worker = new Worker(new URL('../../lib/erp/parse.worker.ts', import.meta.url), { type: 'module' }) } catch { fallback(); return }
    worker.onmessage = (e: MessageEvent<{ type: string; message?: string; result?: ErpParseResult }>) => {
      if (e.data.type === 'progress') onProgress(e.data.message || 'Leyendo…')
      else {
        worker.terminate()
        if (e.data.type === 'done' && e.data.result) resolve(e.data.result)
        else reject(new Error(e.data.message || 'No se pudo leer el archivo'))
      }
    }
    worker.onerror = ev => { ev.preventDefault(); worker.terminate(); fallback() }
    worker.postMessage({ files })
  })
}

const STALE_H = 24

export function ErpVigencia({ estado }: { estado: ErpEstado }) {
  const [now] = useState(() => Date.now())
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {(['CONTRATOS', 'STOCK'] as const).map(kind => {
        const a = estado.activas[kind]
        const hours = a?.cut_at ? (now - new Date(a.cut_at).getTime()) / 3600000 : null
        const s = (a?.summary || {}) as Record<string, number>
        return (
          <div key={kind} className={`rounded-xl border p-3 ${!a ? 'border-red-200 bg-red-50' : hours !== null && hours > STALE_H ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}>
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{ERP_KIND_LABEL[kind]}</p>
            {!a ? <p className="mt-1 text-sm font-semibold text-red-800">Sin cargar</p> : <>
              <p className="mt-1 text-sm font-semibold text-slate-900">Corte del ERP: {a.cut_at ? fmtDateTime(a.cut_at) : '—'}
                {hours !== null && hours > STALE_H && <span className="ml-2 text-xs font-bold text-amber-800">hace {Math.round(hours / 24 * 10) / 10} día(s): actualice el Excel</span>}</p>
              <p className="text-xs text-slate-600">{kind === 'CONTRATOS'
                ? `${fmtN(s.ots)} OT · ${fmtN(s.lineas)} líneas · ${fmtN(s.lineas_pendientes)} con pendiente · ${fmtN(s.guias)} guías`
                : `${fmtN(s.lotes)} lotes · ${fmtN(s.productos)} productos · ${fmtPeso(s.kg)}`}</p>
            </>}
          </div>
        )
      })}
    </div>
  )
}
