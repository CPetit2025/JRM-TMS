const { createSupabaseClient } = require('./scripts/supabase-client.cjs');
const supabase = createSupabaseClient();

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
