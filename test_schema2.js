const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function check() {
  const table = 'transport_requests';
  const { data, error } = await supabase.from(table).select('*').limit(1);
  if (error) {
    console.log('Error:', error.message);
  } else if (data && data.length > 0) {
    console.log('Columns in transport_requests:', Object.keys(data[0]));
  } else {
    console.log('No data, fetching schema...');
    // We can just query information_schema if get_schema_columns fails
    const { data: cols, error: errCols } = await supabase
      .from('information_schema.columns')
      .select('column_name')
      .eq('table_name', 'transport_requests')
      .eq('table_schema', 'public');
    if (errCols) {
        console.log("cannot get info schema: ", errCols.message);
    } else {
        console.log("Columns via information_schema:", cols.map(c => c.column_name));
    }
  }
}
check();
