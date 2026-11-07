// Guarda de separación TMS / WMS (docs/despliegue-wms.md). Corre antes de `next build` y en los workflows
// de despliegue: falla si una compilación o despliegue de WMS apunta a la base de TMS, o al revés.
// Sistema: JRM_APP = tms (por defecto) | wms-staging | wms-production.
// Base: SUPABASE_PROJECT_REF, o la referencia tomada de NEXT_PUBLIC_SUPABASE_URL (https://<ref>.supabase.co).
// Las referencias de proyecto no son secretas: viajan en el JavaScript público de cada sitio.
'use strict'

const TMS_REF = 'eojfsbogysifxrlrnjvx'
const WMS_STAGING_REF = 'rquujukgtturdlkuzgdc'
const WMS_PRODUCTION_REF = 'glecgvomkaqmkfkhtxhi'
const APPS = ['tms', 'wms-staging', 'wms-production']

function refFromUrl(url) {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) return null
    return parsed.hostname.match(/^([a-z0-9]{20})\.supabase\.co$/)?.[1] ?? null
  } catch {
    return null
  }
}

// Devuelve la lista de errores (vacía = destino correcto).
// strict: despliegue real (Vercel producción o workflow); exige una base de Supabase reconocible.
function checkTarget({ app = 'tms', ref, url, strict = false }) {
  if (!APPS.includes(app)) return [`JRM_APP='${app}' no es válido; use ${APPS.join(', ')}.`]
  const fromUrl = refFromUrl(url)
  if (ref && url && ref !== fromUrl) return ['SUPABASE_PROJECT_REF y NEXT_PUBLIC_SUPABASE_URL no coinciden.']
  const target = ref || fromUrl
  if (target === null) {
    return strict ? [`NEXT_PUBLIC_SUPABASE_URL no es una URL https://<ref>.supabase.co (${app}).`] : []
  }
  if (!target) {
    return strict || app !== 'tms' ? [`Falta la base de Supabase para ${app} (NEXT_PUBLIC_SUPABASE_URL o SUPABASE_PROJECT_REF).`] : []
  }
  if (app === 'tms') {
    if (target === WMS_STAGING_REF) return ['TMS apunta a la base de WMS Staging.']
    if (strict && target !== TMS_REF) return [`TMS producción debe usar la base ${TMS_REF}, no ${target} (¿base de WMS?).`]
    return []
  }
  if (target === TMS_REF) return [`${app} apunta a la base de TMS (${TMS_REF}). WMS debe usar su propio proyecto de Supabase.`]
  if (app === 'wms-staging' && target !== WMS_STAGING_REF) return [`wms-staging debe usar ${WMS_STAGING_REF}, no ${target}.`]
  if (app === 'wms-production' && target !== WMS_PRODUCTION_REF) return [`wms-production debe usar ${WMS_PRODUCTION_REF}, no ${target}.`]
  return []
}

module.exports = { checkTarget, refFromUrl, TMS_REF, WMS_STAGING_REF, WMS_PRODUCTION_REF }

if (require.main === module) {
  const env = process.env
  const app = env.JRM_APP || 'tms'
  // En Vercel solo se exige base reconocible en producción; en WMS siempre (cada proyecto WMS es solo de WMS).
  const strict = env.SUPABASE_TARGET_STRICT === '1' || env.VERCEL_ENV === 'production' || app !== 'tms'
  const errors = checkTarget({ app, ref: env.SUPABASE_PROJECT_REF, url: env.NEXT_PUBLIC_SUPABASE_URL, strict })
  if (errors.length) {
    for (const e of errors) console.error(`::error title=Destino de Supabase::${e}`)
    process.exit(1)
  }
  console.log(`Destino de Supabase correcto para ${app}.`)
}
