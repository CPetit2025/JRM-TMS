const { createClient } = require('@supabase/supabase-js')
const supabase = createClient('https://eojfsbogysifxrlrnjvx.supabase.co', 'sb_publishable_kMujry845FSdVQa9Qi3Gpg_r1_r9tjm')
async function check() {
  const { data, error } = await supabase.from('carriers').select('*').limit(1)
  console.log('carriers columns:', error ? error : Object.keys(data[0] || {}))
}
check()
