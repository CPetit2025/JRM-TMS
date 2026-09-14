
const { createSupabaseClient } = require('./scripts/supabase-client.cjs')
const supabase = createSupabaseClient()
async function check() {
  const { data, error } = await supabase.from('dispatch_requests').select('*').limit(1)
  console.log('dispatch_requests:', data, error)
  const { data: d2, error: e2 } = await supabase.from('dispatches').select('id, dispatch_requests(*)').limit(1)
  console.log('dispatches relation:', d2, e2)
}
check()

