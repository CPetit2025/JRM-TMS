// Guardas previas al merge (npm run check:guards). Cada una responde a un incidente real:
// 1. El APK carga la web en vivo desde server.url; si falta, el APK no se puede compilar o queda sin pantallas.
// 2. Toda pantalla del app del conductor debe tener un acceso visible (la solicitud de anticipo quedó escondida).
// 3-4. Permisos en el catálogo único y toda página web con regla de acceso (menú = dirección escrita a mano).
const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const errors = []

const capacitor = readFileSync(path.join(root, 'capacitor.config.ts'), 'utf8')
if (!/server\s*:\s*\{[^}]*url\s*:\s*['"]https:\/\/jrm-tms\.vercel\.app['"]/s.test(capacitor) ||
    !/appStartPath\s*:\s*['"]\/app\/login['"]/.test(capacitor)) {
  errors.push("capacitor.config.ts debe tener server.url 'https://jrm-tms.vercel.app' y server.appStartPath '/app/login'.")
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(full)
  }
  return out
}
const appDir = path.join(root, 'src', 'app', 'app', '(app)')
const sources = walk(path.join(root, 'src')).map(file => ({ file, text: readFileSync(file, 'utf8') }))
for (const name of readdirSync(appDir)) {
  const pageDir = path.join(appDir, name)
  if (!statSync(pageDir).isDirectory() || !existsSync(path.join(pageDir, 'page.tsx'))) continue
  const route = `/app/${name}`
  const linked = sources.some(({ file, text }) => !file.startsWith(pageDir + path.sep) &&
    new RegExp(`['"\`]${route.replace('/', '\\/')}(['"\`?#/])`).test(text))
  if (!linked) errors.push(`La pantalla ${route} del app del conductor no tiene ningún acceso (Inicio, Actividades o menú).`)
}

// 3. Permisos: toda clave que usa el menú, el código o una migración nueva existe en el catálogo único
//    (src/lib/permissions/catalog.ts), así la pantalla «Roles y Permisos» puede asignarla.
const catalogText = readFileSync(path.join(root, 'src', 'lib', 'permissions', 'catalog.ts'), 'utf8')
const catalog = new Set([...catalogText.matchAll(/id: '([a-z0-9:-]+)'/g)].map(m => m[1]))
const navText = readFileSync(path.join(root, 'src', 'lib', 'nav', 'navConfig.ts'), 'utf8')
const used = new Map()
const note = (key, where) => { if (!used.has(key)) used.set(key, where) }
for (const m of navText.matchAll(/any\(([^)]*)\)/g)) for (const k of m[1].matchAll(/'([a-z0-9:-]+)'/g)) note(k[1], 'navConfig.ts')
for (const { file, text } of sources) for (const m of text.matchAll(/\b(?:canRead|canWrite|hasAccess)\(\s*'([a-z0-9:-]+)'/g)) note(m[1], path.relative(root, file))
const migDir = path.join(root, 'supabase', 'migrations')
for (const name of readdirSync(migDir).filter(n => n >= '20261011030000')) {
  const text = readFileSync(path.join(migDir, name), 'utf8')
  for (const m of text.matchAll(/(?:has_tms_(?:read_)?permission|menu_has_permission)\(\s*'([a-z0-9:-]+)'/g)) note(m[1], name)
  for (const m of text.matchAll(/has_cmms_(?:read_)?permission\(\s*'([a-z0-9-]+)'/g)) note(`mantenimiento-${m[1]}`, name)
}
for (const [key, where] of used) if (!catalog.has(key)) errors.push(`El permiso '${key}' (${where}) no está en src/lib/permissions/catalog.ts.`)

// 4. Toda página de la web tiene regla de acceso: una opción del menú que la cubre o la lista de páginas abiertas.
const accessText = readFileSync(path.join(root, 'src', 'lib', 'nav', 'web-access.ts'), 'utf8')
const openPaths = [...(accessText.match(/OPEN_PATHS = \[([^\]]*)\]/)?.[1] || '').matchAll(/'([^']+)'/g)].map(m => m[1])
const aliases = [...(accessText.match(/PATH_ALIASES[^=]*= \{([^}]*)\}/)?.[1] || '').matchAll(/'([^']+)':/g)].map(m => m[1])
const menuHrefs = [...navText.matchAll(/href: '([^']+)'/g)].map(m => m[1])
const dashDir = path.join(root, 'src', 'app', '(dashboard)')
for (const file of walk(dashDir).filter(f => f.endsWith(`${path.sep}page.tsx`))) {
  const route = '/' + path.relative(dashDir, path.dirname(file)).split(path.sep).filter(Boolean).join('/')
  const covered = openPaths.some(p => route === p || (p !== '/' && route.startsWith(p + '/'))) || aliases.includes(route) ||
    menuHrefs.some(h => h !== '/' && (route === h || route.startsWith(h + '/')))
  if (!covered) errors.push(`La página ${route} no tiene regla de acceso: agréguela al menú (navConfig) o a OPEN_PATHS en web-access.ts.`)
}

if (errors.length) {
  console.error('Guardas fallidas:\n- ' + errors.join('\n- '))
  process.exit(1)
}
console.log('Guardas OK')
