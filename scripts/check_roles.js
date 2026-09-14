const { createSupabaseClient } = require('./scripts/supabase-client.cjs');
const supabase = createSupabaseClient();

async function checkRoles() {
  const { data: users, error: userError } = await supabase
    .from('profiles')
    .select('first_name, last_name, roles(name)');

  if (userError) {
    console.error(userError);
    return;
  }
    
  console.log(JSON.stringify(users.filter(u => u.first_name === 'Supervisor'), null, 2));
}

checkRoles();
