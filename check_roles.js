const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://eojfsbogysifxrlrnjvx.supabase.co';
const supabaseKey = 'sb_publishable_kMujry845FSdVQa9Qi3Gpg_r1_r9tjm';
const supabase = createClient(supabaseUrl, supabaseKey);

async function checkRoles() {
  const { data: users, error: userError } = await supabase
    .from('profiles')
    .select('first_name, last_name, roles(name)');
    
  console.log(JSON.stringify(users.filter(u => u.first_name === 'Supervisor'), null, 2));
}

checkRoles();
