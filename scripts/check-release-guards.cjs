// Guardas previas al merge (npm run check:guards). Cada una responde a un incidente real:
// 1. El APK carga la web en vivo desde server.url; si falta, el APK no se puede compilar o queda sin pantallas.
// 2. Toda pantalla del app del conductor debe tener un acceso visible (la solicitud de anticipo quedó escondida).
// 3-4. Permisos en el catálogo único y toda página web con regla de acceso (menú = dirección escrita a mano).
// 5. Tablas nuevas con barrera de cuenta activa y sin privilegios por defecto (C55).
// 6. Dos migraciones con la misma versión: Supabase aplica solo una y el despliegue se detiene (incidente #282).
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

// 5. Tablas nuevas con las barreras que exige C55 (incidente: role_permission_changes falló en producción dos veces):
//    barrera restrictiva de cuenta activa y sin privilegios por defecto de Supabase para authenticated.
// 6. Versión única por migración (la parte numérica del nombre); se revisan las de esta etapa en adelante
const versions = new Map()
for (const name of readdirSync(migDir).filter(n => n.endsWith('.sql') && n >= '20261020000000')) {
  const version = name.split('_')[0]
  if (versions.has(version)) errors.push(`Las migraciones ${versions.get(version)} y ${name} tienen la misma versión ${version}: renombre la nueva con una versión posterior a la última.`)
  else versions.set(version, name)
}

const allMigrations = readdirSync(migDir).sort().map(name => ({ name, text: readFileSync(path.join(migDir, name), 'utf8') }))
const allSql = allMigrations.map(m => m.text).join('\n')
for (const { name, text } of allMigrations.filter(m => m.name >= '20261011050000')) {
  for (const m of text.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?public\.([a-z0-9_]+)/gi)) {
    const table = m[1]
    // La política debe ser restrictiva, para authenticated y exigir la cuenta activa al leer y al escribir
    const policy = new RegExp(`CREATE POLICY security_active_account ON public\\.${table}\\s+AS RESTRICTIVE\\s+FOR ALL\\s+TO authenticated\\s+` +
      `USING\\s*\\(\\s*\\(\\s*SELECT public\\.is_active_tms_user\\(\\)\\s*\\)\\s*\\)\\s*WITH CHECK\\s*\\(\\s*\\(\\s*SELECT public\\.is_active_tms_user\\(\\)\\s*\\)\\s*\\)`, 'i')
    if (!policy.test(allSql))
      errors.push(`La tabla ${table} (${name}) no tiene la política security_active_account AS RESTRICTIVE FOR ALL TO authenticated con is_active_tms_user() en USING y WITH CHECK (C55).`)
    if (!new RegExp(`ALTER TABLE (?:IF EXISTS )?public\\.${table}\\s+ENABLE ROW LEVEL SECURITY`, 'i').test(allSql))
      errors.push(`La tabla ${table} (${name}) no activa RLS (ALTER TABLE ... ENABLE ROW LEVEL SECURITY): sin RLS sus políticas no rigen (C55).`)
    if (!new RegExp(`REVOKE ALL ON (?:TABLE )?public\\.${table} FROM[^;]*authenticated`, 'i').test(allSql))
      errors.push(`La tabla ${table} (${name}) conserva los privilegios por defecto de authenticated: REVOKE ALL y GRANT solo lo necesario (C55).`)
  }
}

// En Supabase las consultas que llegan por la API pasan por pg_safeupdate: un UPDATE o DELETE sin WHERE falla
// («UPDATE requires a WHERE clause»), también dentro de funciones y sobre tablas temporales. Las pruebas locales no lo
// detectan. Desde 20261025100000 cada UPDATE/DELETE debe llevar WHERE en su nivel (WHERE true si es intencional).
const stripNested = sql => { let out = '', depth = 0; for (const ch of sql) { if (ch === '(') depth++; else if (ch === ')') depth = Math.max(0, depth - 1); else if (!depth) out += ch } return out }
for (const name of readdirSync(migDir).filter(n => n.endsWith('.sql') && n >= '20261025100000')) {
  const sql = readFileSync(path.join(migDir, name), 'utf8').replace(/--[^\n]*/g, '').replace(/\$q\$/g, '')
  for (const stmt of sql.split(';')) {
    const flat = stripNested(stmt).replace(/\s+/g, ' ').trim()
    const m = flat.match(/(?:^|\s)(UPDATE|DELETE FROM)\s+[\w.]+/i)
    if (!m || /\bCREATE (?:OR REPLACE )?(?:CONSTRAINT )?TRIGGER\b/i.test(flat) || /\bON CONFLICT\b|\bFOR UPDATE\b/i.test(flat.slice(Math.max(0, m.index - 30), m.index + m[0].length + 5))) continue
    if (!/\bWHERE\b/i.test(flat.slice(m.index))) errors.push(`${name}: «${flat.slice(m.index, m.index + 60)}…» no tiene WHERE: en Supabase (pg_safeupdate) falla. Agregue WHERE (o WHERE true).`)
  }
}

if (errors.length) {
  console.error('Guardas fallidas:\n- ' + errors.join('\n- '))
  process.exit(1)
}
console.log('Guardas OK')
