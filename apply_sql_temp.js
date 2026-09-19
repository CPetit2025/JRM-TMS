const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
require('dotenv').config({ path: '.env.local' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

async function run() {
  const sql = fs.readFileSync('C:\\Users\\LENOVO T580\\.gemini\\antigravity\\brain\\b2c242d8-55d0-4d28-8416-103ec6d473e9\\add_expense_ot_link.sql', 'utf8');
  
  const { data, error } = await supabase.rpc('exec_sql', { sql_query: sql });
  if (error) {
    const { data: data2, error: error2 } = await supabase.rpc('exec_sql', { sql_string: sql });
    if (error2) {
      console.log('Error 2:', error2);
    } else {
      console.log('Success 2:', data2);
    }
  } else {
    console.log('Success:', data);
  }
}
run();
