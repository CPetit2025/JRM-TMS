'use client'

import { Fragment, type ReactNode } from 'react'

// Formato liviano y seguro de las respuestas de JRM IA (sin HTML): títulos, **negritas**, viñetas, listas numeradas y
// rutas internas del TMS (/despacho, /apt/datos…) como enlaces que abren la pantalla.
const ROUTE = /(^|[\s(«"'])(\/(?:[a-z0-9-]+)(?:\/[a-z0-9-]+)*)(?=$|[\s).,;:»"'])/g

function inline(text: string, onRoute: (href: string) => void, key: string): ReactNode[] {
  const out: ReactNode[] = []
  text.split(/(\*\*[^*]+\*\*)/g).forEach((chunk, i) => {
    if (/^\*\*[^*]+\*\*$/.test(chunk)) { out.push(<strong key={`${key}b${i}`} className="font-semibold text-slate-900">{chunk.slice(2, -2)}</strong>); return }
    let last = 0
    for (const m of chunk.matchAll(ROUTE)) {
      const start = (m.index ?? 0) + m[1].length
      if (start > last) out.push(<Fragment key={`${key}t${i}-${last}`}>{chunk.slice(last, start)}</Fragment>)
      const href = m[2]
      out.push(<button key={`${key}r${i}-${start}`} type="button" onClick={() => onRoute(href)} className="font-semibold text-[#002855] underline decoration-dotted underline-offset-2 hover:decoration-solid">{href}</button>)
      last = start + href.length
    }
    if (last < chunk.length) out.push(<Fragment key={`${key}t${i}-end`}>{chunk.slice(last)}</Fragment>)
  })
  return out
}

export function AiRichText({ text, onRoute }: { text: string; onRoute: (href: string) => void }) {
  const blocks: ReactNode[] = []
  let list: { ordered: boolean; items: ReactNode[] } | null = null
  const flush = (k: number) => {
    if (!list) return
    blocks.push(list.ordered
      ? <ol key={`l${k}`} className="my-1 list-decimal space-y-0.5 pl-5">{list.items}</ol>
      : <ul key={`l${k}`} className="my-1 list-disc space-y-0.5 pl-5">{list.items}</ul>)
    list = null
  }
  text.split('\n').forEach((raw, k) => {
    const line = raw.trimEnd()
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/)
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (bullet || numbered) {
      const ordered = !!numbered
      if (!list || list.ordered !== ordered) { flush(k); list = { ordered, items: [] } }
      list.items.push(<li key={k}>{inline((bullet ?? numbered)![1], onRoute, `i${k}`)}</li>)
      return
    }
    flush(k)
    const heading = line.match(/^#{1,4}\s+(.*)$/)
    if (heading) { blocks.push(<p key={k} className="mt-2 font-bold text-[#002855]">{inline(heading[1], onRoute, `h${k}`)}</p>); return }
    if (!line.trim()) { blocks.push(<div key={k} className="h-1.5" />); return }
    blocks.push(<p key={k}>{inline(line, onRoute, `p${k}`)}</p>)
  })
  flush(text.length + 1)
  return <div className="space-y-0.5 leading-relaxed">{blocks}</div>
}
