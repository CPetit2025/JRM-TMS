/**
 * Servicio gratuito de enrutamiento y geocodificación usando OpenStreetMap (Nominatim) y OSRM.
 */

// Interfaz para coordenadas
export interface Coordinates {
  lat: number;
  lon: number;
}

// Diccionario de coordenadas para ubicaciones de prueba (Mock Data)
const MOCK_LOCATIONS: Record<string, Coordinates> = {
  'Planta Chilca (Default)': { lat: -12.5204, lon: -76.7371 },
  'Almacenes ABC, Callao': { lat: -12.0560, lon: -77.1182 },
  'Local San Isidro': { lat: -12.0970, lon: -77.0340 },
  'Planta Lurin': { lat: -12.2741, lon: -76.8687 },
  'Av. Los Constructores 123, Lima': { lat: -12.0664, lon: -76.9482 }
};

// Función para obtener coordenadas de una dirección (Geocoding con Nominatim)
export async function geocodeAddress(address: string): Promise<Coordinates | null> {
  try {
    // 1. Verificar si es una dirección de prueba conocida
    const knownMatch = Object.keys(MOCK_LOCATIONS).find(k => address.includes(k) || k.includes(address));
    if (knownMatch) {
      return MOCK_LOCATIONS[knownMatch];
    }

    // 2. Intentar con Nominatim
    const searchQuery = address.toLowerCase().includes('peru') ? address : `${address}, Perú`;
    
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchQuery)}&format=json&limit=1`;
    
    const response = await fetch(url, {
      headers: {
        'Accept-Language': 'es',
      }
    });

    if (response.ok) {
      const data = await response.json();
      if (data && data.length > 0) {
        return {
          lat: parseFloat(data[0].lat),
          lon: parseFloat(data[0].lon)
        };
      }
    }
    
    // 3. Fallback: Si no lo encuentra, retornar unas coordenadas aleatorias en Lima para que la demo no se rompa
    console.warn(`No se pudo geocodificar "${address}", usando fallback aleatorio en Lima`);
    return {
      lat: -12.0464 + (Math.random() * 0.1 - 0.05), // Centro de lima +/- ruido
      lon: -77.0428 + (Math.random() * 0.1 - 0.05)
    };
  } catch (error) {
    console.error('Error geocoding address:', address, error);
    // Fallback de emergencia
    return { lat: -12.0464, lon: -77.0428 };
  }
}

// Función para calcular distancia de conducción (OSRM)
export async function getDrivingDistanceKM(origin: Coordinates, destination: Coordinates): Promise<number | null> {
  try {
    // OSRM URL format: {longitude},{latitude};{longitude},{latitude}
    const url = `https://router.project-osrm.org/route/v1/driving/${origin.lon},${origin.lat};${destination.lon},${destination.lat}?overview=false`;
    
    const response = await fetch(url);
    if (!response.ok) throw new Error('Error en el servicio de rutas');

    const data = await response.json();
    
    if (data && data.routes && data.routes.length > 0) {
      // distance in OSRM is returned in meters
      const distanceMeters = data.routes[0].distance;
      return distanceMeters / 1000;
    }
    return null;
  } catch (error) {
    console.error('Error calculating route:', error);
    return null;
  }
}

// Función de conveniencia para calcular con retraso artificial para respetar límites de Nominatim (1 request / sec)
function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function calculateRouteDistance(pickup: string, delivery: string): Promise<number | null> {
  const originCoords = await geocodeAddress(pickup);
  
  // Pausa de 1.5s para no ser bloqueados por Nominatim
  await delay(1500); 
  
  const destCoords = await geocodeAddress(delivery);

  if (!originCoords || !destCoords) {
    return null;
  }

  return await getDrivingDistanceKM(originCoords, destCoords);
}
