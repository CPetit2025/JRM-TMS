const { createClient } = require('@supabase/supabase-js')
const supabase = createClient('https://eojfsbogysifxrlrnjvx.supabase.co', 'sb_publishable_kMujry845FSdVQa9Qi3Gpg_r1_r9tjm')
async function check() {
  const { data: d2, error: e2 } = await supabase.from('dispatches').select('id, dispatch_number, driver_name').limit(1)
  console.log('dispatches columns:', JSON.stringify(e2))
}
check()
