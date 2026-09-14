const { createSupabaseClient } = require('./scripts/supabase-client.cjs')
const supabase = createSupabaseClient()
async function check() {
  const { error: e2 } = await supabase.from('dispatches').select('id, dispatch_number, driver_name, vehicle_plate, scheduled_departure, status, estimated_distance_km, dispatch_requests(transport_request_id, status, transport_requests(request_number, pickup_address, delivery_address, transport_request_items(weight, volume_m3, quantity)))').limit(1)
  console.log('dispatches relation:', JSON.stringify(e2))
}
check()
