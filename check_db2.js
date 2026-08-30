const { createClient } = require('@supabase/supabase-js')
const supabase = createClient('https://eojfsbogysifxrlrnjvx.supabase.co', 'sb_publishable_kMujry845FSdVQa9Qi3Gpg_r1_r9tjm')
async function check() {
  const { data: d2, error: e2 } = await supabase.from('dispatches').select('id, dispatch_requests(transport_request_id, status, transport_requests(request_number, pickup_address, delivery_address, transport_request_items(weight, volume_m3, quantity)))').limit(1)
  console.log('dispatches relation:', JSON.stringify(e2))
}
check()
