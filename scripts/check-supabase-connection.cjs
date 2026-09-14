const { createSupabaseClient } = require('./supabase-client.cjs')

const tables = ['profiles', 'transport_requests', 'work_orders']

async function checkSupabaseConnection() {
  const supabase = createSupabaseClient()

  for (const table of tables) {
    const { error } = await supabase.from(table).select('id').limit(1)

    if (error) {
      throw new Error(`Supabase table check failed for ${table}: ${error.message}`)
    }

    console.log(`Supabase table check passed: ${table}`)
  }
}

checkSupabaseConnection().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
