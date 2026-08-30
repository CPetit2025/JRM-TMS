const { createClient } = require('@supabase/supabase-js')
const supabase = createClient('https://eojfsbogysifxrlrnjvx.supabase.co', 'sb_publishable_kMujry845FSdVQa9Qi3Gpg_r1_r9tjm')

async function seedData() {
  console.log('Seeding transport_requests...');
  const requests = [
    {
      request_number: 'REQ-MOCK-001',
      request_type: 'DESPACHO',
      department: 'OT - Fabricacion',
      requester_name: 'Juan Perez',
      pickup_address: 'Planta Chilca (Default)',
      delivery_address: 'Av. Los Constructores 123, Lima',
      required_date: new Date().toISOString().split('T')[0],
      status: 'PENDIENTE'
    },
    {
      request_number: 'REQ-MOCK-002',
      request_type: 'RECOJO',
      department: 'Logistica',
      requester_name: 'Maria Torres',
      pickup_address: 'Almacenes ABC, Callao',
      delivery_address: 'Planta Chilca (Default)',
      required_date: new Date().toISOString().split('T')[0],
      status: 'PENDIENTE'
    },
    {
      request_number: 'REQ-MOCK-003',
      request_type: 'TRASLADO',
      department: 'Compras',
      requester_name: 'Carlos Ruiz',
      pickup_address: 'Local San Isidro',
      delivery_address: 'Planta Lurín',
      required_date: new Date().toISOString().split('T')[0],
      status: 'PENDIENTE'
    }
  ];

  const { data: insertedRequests, error: reqError } = await supabase
    .from('transport_requests')
    .insert(requests)
    .select();

  if (reqError) {
    console.error('Error inserting requests:', reqError);
    return;
  }

  console.log('Inserted requests:', insertedRequests.map(r => r.request_number));

  const items = [
    {
      transport_request_id: insertedRequests.find(r => r.request_number === 'REQ-MOCK-001').id,
      description: 'Estructura Metalica Tipo A',
      quantity: 10,
      weight: 1500.0,
      volume_m3: 15.5
    },
    {
      transport_request_id: insertedRequests.find(r => r.request_number === 'REQ-MOCK-002').id,
      description: 'Lote de pernos y tuercas',
      quantity: 50,
      weight: 500.0,
      volume_m3: 2.0
    },
    {
      transport_request_id: insertedRequests.find(r => r.request_number === 'REQ-MOCK-003').id,
      description: 'Mobiliario de oficina',
      quantity: 5,
      weight: 300.0,
      volume_m3: 4.5
    }
  ];

  const { error: itemsError } = await supabase
    .from('transport_request_items')
    .insert(items);

  if (itemsError) {
    console.error('Error inserting items:', itemsError);
  } else {
    console.log('Successfully seeded mock data!');
  }
}

seedData();
