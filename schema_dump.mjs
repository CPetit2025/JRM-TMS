import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

const supabase = createClient(supabaseUrl, supabaseAnonKey)

async function getStructure() {
  const { data: dispatches } = await supabase.from('dispatches').select('*').limit(1)
  const { data: requests } = await supabase.from('dispatch_requests').select('*').limit(1)
  const { data: routes } = await supabase.from('transport_requests').select('*').limit(1)
  console.log("Dispatches:", Object.keys(dispatches?.[0] || {}))
  console.log("Dispatch_Requests:", Object.keys(requests?.[0] || {}))
  console.log("Transport_Requests:", Object.keys(routes?.[0] || {}))
}

getStructure()
