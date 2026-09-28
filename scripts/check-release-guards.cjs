// Guardas previas al merge (npm run check:guards). Cada una responde a un incidente real:
// 1. El APK carga la web en vivo desde server.url; si falta, el APK no se puede compilar o queda sin pantallas.
// 2. Toda pantalla del app del conductor debe tener un acceso visible (la solicitud de anticipo quedó escondida).
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

if (errors.length) {
  console.error('Guardas fallidas:\n- ' + errors.join('\n- '))
  process.exit(1)
}
console.log('Guardas OK')
