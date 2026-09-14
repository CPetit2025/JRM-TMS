import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createSupabaseClient } = require('./scripts/supabase-client.cjs')
const supabase = createSupabaseClient()

async function run() {
  const { data, error } = await supabase.from('dispatches').select('*').limit(1)

  if (error) {
    console.error(error)
    return
  }

  console.log(data)
}

run()
