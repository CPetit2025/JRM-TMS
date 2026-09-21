const fs = require('node:fs')
const path = require('node:path')
const dotenv = require('dotenv')

const localPath = path.join(__dirname, '..', '.env.local')
const local = fs.existsSync(localPath)
  ? dotenv.parse(fs.readFileSync(localPath))
  : {}
const config = { ...local, ...process.env }

const required = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'OPENAI_API_KEY',
]

let missing = false
for (const name of required) {
  const value = config[name]?.trim()
  const present = Boolean(value && !value.startsWith('tu-') && !value.startsWith('<'))
  console.log(`${present ? 'OK' : 'FALTA'} ${name}`)
  if (!present) missing = true
}

if (missing) {
  console.error('Completa las variables faltantes en .env.local o en Vercel. No compartas los valores.')
  process.exitCode = 1
} else {
  console.log('Configuración de JRM IA presente. Esta comprobación no realiza una llamada a OpenAI.')
}
