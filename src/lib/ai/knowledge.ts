import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { HOME_ITEM, NAV_SECTIONS, SEGUIMIENTO_ITEM, normalize, type Has } from '@/lib/nav/navConfig'

// Base de conocimiento de JRM IA: cómo funciona el TMS (reglas de negocio, flujos y pantallas) a partir de la
// documentación funcional de docs/ y del menú. Responde «¿cómo hago…?», «¿dónde veo…?», «¿qué significa…?».
// La documentación técnica (infraestructura, despliegue, auditorías de seguridad, diseño) queda fuera.

const DOCS_DIR = path.join(process.cwd(), 'docs')
const EXCLUDED = [/^infra-connections\.md$/, /^configurar-openai-vercel\.md$/, /^despliegue-automatico\.md$/, /^auditorias\//, /^ui\//,
  /^cmms\/00-auditoria-actual\.md$/, /^cmms\/99-auditoria-final\.md$/]
const STOP = new Set(('como que cual cuales donde cuando para por con sin una uno unos unas los las del de la el en y o a al se su sus es son '
  + 'esta este esto estos estas hay hace hacer puedo puede quiero necesito tengo ver veo mas muy le lo me mi mis ya si no tambien sobre entre').split(' '))

interface Section { source: string; title: string; text: string; terms: Map<string, number>; titleTerms: Set<string> }
let index: Section[] | null = null

const tokens = (text: string) => normalize(text).split(/[^a-z0-9ñ]+/).filter(t => t.length >= 3 && !STOP.has(t))

function walk(dir: string, rel = ''): string[] {
  let out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name), r = rel ? `${rel}/${name}` : name
    if (statSync(full).isDirectory()) out = out.concat(walk(full, r))
    else if (name.endsWith('.md') && !EXCLUDED.some(x => x.test(r))) out.push(r)
  }
  return out
}

function buildIndex(): Section[] {
  const sections: Section[] = []
  let files: string[] = []
  try { files = walk(DOCS_DIR) } catch { return sections }
  for (const rel of files) {
    const raw = readFileSync(path.join(DOCS_DIR, rel), 'utf8')
    const docTitle = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() || rel
    // Una sección por encabezado ## (o el documento completo si no tiene)
    const parts = raw.split(/^(?=##\s)/m)
    for (const part of parts) {
      const heading = part.match(/^##+\s+(.+)$/m)?.[1]?.trim()
      const text = part.replace(/```[\s\S]*?```/g, '').trim()
      if (text.length < 40) continue
      const title = heading ? `${docTitle} › ${heading}` : docTitle
      const terms = new Map<string, number>()
      for (const t of tokens(text)) terms.set(t, (terms.get(t) || 0) + 1)
      sections.push({ source: `docs/${rel}`, title, text, terms, titleTerms: new Set(tokens(title)) })
    }
  }
  return sections
}

function screens(has: Has) {
  const out: Array<{ label: string; ruta: string; seccion: string; acceso: boolean; keywords: string }> = []
  for (const item of [HOME_ITEM(false), SEGUIMIENTO_ITEM]) out.push({ label: item.label, ruta: item.href, seccion: 'General', acceso: true, keywords: item.keywords || '' })
  for (const section of NAV_SECTIONS) for (const group of section.groups) for (const item of group.items) {
    out.push({ label: item.label, ruta: item.href, seccion: [section.title, group.title].filter(Boolean).join(' › '), acceso: item.show(has), keywords: item.keywords || '' })
  }
  return out
}

export function searchHelp(query: string, has: Has, limit = 5) {
  index ??= buildIndex()
  const q = [...new Set(tokens(query))]
  if (!q.length) return { pantallas: [], documentos: [], nota: 'Indique qué quiere hacer o qué término busca.' }
  // Coincidencia por prefijo (despacho ≈ despachos) para tolerar plurales y conjugaciones
  const match = (term: string, set: Iterable<string>) => { for (const t of set) if (t === term || (term.length >= 5 && (t.startsWith(term.slice(0, -1)) || term.startsWith(t.slice(0, -1))))) return true; return false }
  const scored = index.map(s => {
    let score = 0
    for (const term of q) {
      let tf = s.terms.get(term) || 0
      if (!tf && term.length >= 5) for (const [t, n] of s.terms) if (t.startsWith(term.slice(0, -1))) tf += n
      if (tf) score += 1 + Math.log(1 + tf)
      if (match(term, s.titleTerms)) score += 3
    }
    return { s, score }
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit)
  const pantallas = screens(has).map(p => {
    const words = new Set(tokens(`${p.label} ${p.keywords} ${p.seccion}`))
    return { p, score: q.filter(term => match(term, words)).length }
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 6)
    .map(({ p }) => ({ pantalla: p.label, ruta: p.ruta, menu: p.seccion, acceso: p.acceso ? 'sí' : 'sin permiso (pídalo al administrador)' }))
  return {
    pantallas,
    documentos: scored.map(({ s }) => ({ fuente: s.source, titulo: s.title, texto: s.text.length > 1800 ? `${s.text.slice(0, 1800)}…` : s.text })),
    nota: scored.length ? 'Fragmentos de la documentación funcional del TMS: úselos para explicar; cite la pantalla (ruta) para hacerlo.' : 'No hay documentación para esos términos; responda con lo que sepa del flujo y aclare que no está documentado.',
  }
}
