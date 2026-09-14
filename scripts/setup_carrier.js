const { createSupabaseClient } = require('./scripts/supabase-client.cjs')
const supabase = createSupabaseClient({ useServiceRole: true })

async function setupCarrier() {
  const { data, error } = await supabase.from('carriers').select('id').eq('ruc', '20123456789').limit(1)
  if (error) {
    console.error('Error checking carrier:', error);
    return;
  }

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
