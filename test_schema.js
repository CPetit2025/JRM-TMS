const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function check() {
  const tables = ['transport_requests', 'dispatches', 'dispatch_work_orders'];
  
  for (const table of tables) {
    const { data, error } = await supabase.from(table).select('*').limit(1);
    console.log('\n--- ' + table + ' ---');
    if (error) {
      console.log('Error:', error.message);
    } else if (data && data.length > 0) {
      console.log('Columns:', Object.keys(data[0]));
    } else {
      console.log('No data, fetching schema...');
      const res = await supabase.rpc('get_schema_columns', { table_name: table });
      console.log('Schema:', res.data);
    }
  }
}
check();
