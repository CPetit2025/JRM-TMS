const path = require('node:path')
const dotenv = require('dotenv')
const { createClient } = require('@supabase/supabase-js')

dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), quiet: true })
dotenv.config({ quiet: true })

function readEnv(name) {
  const value = process.env[name]

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}

function createSupabaseClient(options = {}) {
  const url = readEnv('NEXT_PUBLIC_SUPABASE_URL')
  const keyName = options.useServiceRole
    ? 'SUPABASE_SERVICE_ROLE_KEY'
    : 'NEXT_PUBLIC_SUPABASE_ANON_KEY'

  return createClient(url, readEnv(keyName))
}

module.exports = {
  createSupabaseClient,
}
