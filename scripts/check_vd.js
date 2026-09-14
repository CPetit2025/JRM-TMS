const { createSupabaseClient } = require('./scripts/supabase-client.cjs')
const supabase = createSupabaseClient()
async function check() {
  const { error: ve } = await supabase.from('vehicles').select('*').limit(1)
  console.log('vehicles error:', ve)
  const { error: de } = await supabase.from('drivers').select('*').limit(1)
  console.log('drivers error:', de)
}
check()
