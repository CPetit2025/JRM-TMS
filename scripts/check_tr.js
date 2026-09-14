const { createSupabaseClient } = require('./scripts/supabase-client.cjs')
const supabase = createSupabaseClient()
async function check() {
  const { data, error } = await supabase.from('carriers').select('*').limit(1)
  console.log('carriers columns:', error ? error : Object.keys(data[0] || {}))
}
check()
