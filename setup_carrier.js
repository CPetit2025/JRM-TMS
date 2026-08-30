const { createClient } = require('@supabase/supabase-js')
const supabase = createClient('https://eojfsbogysifxrlrnjvx.supabase.co', 'sb_publishable_kMujry845FSdVQa9Qi3Gpg_r1_r9tjm')

async function setupCarrier() {
  const { data, error } = await supabase.from('carriers').select('id').eq('ruc', '20123456789').limit(1)
  if (data && data.length > 0) {
    console.log('Default carrier already exists');
    return;
  }
  
  const { error: insErr } = await supabase.from('carriers').insert([{
    type: 'PROPIO',
    business_name: 'Transportes JRM',
    ruc: '20123456789',
    status: 'ACTIVE'
  }]);
  
  if (insErr) {
    console.error('Error inserting carrier:', insErr);
  } else {
    console.log('Default carrier created successfully!');
  }
}

setupCarrier();
