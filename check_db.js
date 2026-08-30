
const { createClient } = require('@supabase/supabase-js')
const supabase = createClient('https://eojfsbogysifxrlrnjvx.supabase.co', 'sb_publishable_kMujry845FSdVQa9Qi3Gpg_r1_r9tjm')
async function check() {
  const { data, error } = await supabase.from('dispatch_requests').select('*').limit(1)
  console.log('dispatch_requests:', data, error)
  const { data: d2, error: e2 } = await supabase.from('dispatches').select('id, dispatch_requests(*)').limit(1)
  console.log('dispatches relation:', d2, e2)
}
check()

