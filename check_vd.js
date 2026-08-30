const { createClient } = require('@supabase/supabase-js')
const supabase = createClient('https://eojfsbogysifxrlrnjvx.supabase.co', 'sb_publishable_kMujry845FSdVQa9Qi3Gpg_r1_r9tjm')
async function check() {
  const { data: v, error: ve } = await supabase.from('vehicles').select('*').limit(1)
  console.log('vehicles error:', ve)
  const { data: d, error: de } = await supabase.from('drivers').select('*').limit(1)
  console.log('drivers error:', de)
}
check()
