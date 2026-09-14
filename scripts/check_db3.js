const { createSupabaseClient } = require('./scripts/supabase-client.cjs')
const supabase = createSupabaseClient()
async function check() {
  const { error: e2 } = await supabase.from('dispatches').select('id, dispatch_number, driver_name').limit(1)
  console.log('dispatches columns:', JSON.stringify(e2))
}
check()
