import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

const envFile = fs.readFileSync('.env.local', 'utf8')
const env = {}
envFile.split('\n').forEach(line => {
  const match = line.match(/^([^=]+)=(.*)$/)
  if (match) env[match[1]] = match[2].trim().replace(/^"|"$/g, '')
})

const supabaseUrl = env['NEXT_PUBLIC_SUPABASE_URL']
const supabaseKey = env['NEXT_PUBLIC_SUPABASE_ANON_KEY']

const supabase = createClient(supabaseUrl, supabaseKey)

async function checkSchema() {
  console.log("Fetching work_orders with limit(1)...")
  const { data, error } = await supabase.from('work_orders').select('*').limit(1)
  
  if (error) {
    console.error("Error:", error)
  } else {
    console.log("Data:", data)
    if (data && data.length > 0) {
      console.log("Columns:", Object.keys(data[0]))
    }
  }

  // Let's insert a dummy row that is expected to fail with a column error, to see if we can trigger another column error
  const { error: insertErr } = await supabase.from('work_orders').insert([{ dummy_col: 1 }])
  console.log("Insert Error:", insertErr)
}

checkSchema()
