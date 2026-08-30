const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function check() {
  const { data, error } = await supabase.from('work_orders').select('*').limit(1);
  if (error) {
    console.error('Error fetching work_orders:', error);
  } else {
    if (data && data.length > 0) {
      console.log('Columns:', Object.keys(data[0]));
    } else {
      console.log('No data in work_orders table, cannot introspect columns easily without schema query.');
      
      const res = await supabase.rpc('get_schema_columns', { table_name: 'work_orders' });
      console.log('RPC result:', res);
    }
  }
}
check();
