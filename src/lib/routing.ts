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
    
    console.warn(`No se pudo geocodificar "${address}"`);
    return null;
  } catch (error) {
    console.error('Error geocoding address:', address, error);
    return null;
  }
}

/** Estimado de OSRM entre dos puntos: distancia, tiempo de manejo y trazo simplificado ([lat, lon]). */
export interface RouteEstimate {
  km: number;
  minutes: number;
  origin: Coordinates;
  destination: Coordinates;
  geometry: [number, number][];
}

// Ruta de conducción (OSRM): distancia en metros, duración en segundos y trazo GeoJSON [lon, lat]
export async function getDrivingRoute(origin: Coordinates, destination: Coordinates): Promise<RouteEstimate | null> {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${origin.lon},${origin.lat};${destination.lon},${destination.lat}?overview=simplified&geometries=geojson`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Error en el servicio de rutas');
    const data = await response.json();
    const route = data?.routes?.[0];
    if (!route) return null;
    const coordinates = (route.geometry?.coordinates || []) as [number, number][];
    // Máximo 500 puntos: suficiente para dibujar la ruta sugerida en el detalle del despacho
    const step = Math.max(1, Math.ceil(coordinates.length / 500));
    const geometry = coordinates.filter((_, i) => i % step === 0 || i === coordinates.length - 1)
      .map(([lon, lat]) => [Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5] as [number, number]);
    return { km: route.distance / 1000, minutes: Math.round(route.duration / 6) / 10, origin, destination, geometry };
  } catch (error) {
    console.error('Error calculating route:', error);
    return null;
  }
}

// Función para calcular distancia de conducción (OSRM)
export async function getDrivingDistanceKM(origin: Coordinates, destination: Coordinates): Promise<number | null> {
  return (await getDrivingRoute(origin, destination))?.km ?? null;
}

// Función de conveniencia para calcular con retraso artificial para respetar límites de Nominatim (1 request / sec)
function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function calculateRouteEstimate(pickup: string, delivery: string): Promise<RouteEstimate | null> {
  const originCoords = await geocodeAddress(pickup);

  // Pausa de 1.5s para no ser bloqueados por Nominatim
  await delay(1500);

  const destCoords = await geocodeAddress(delivery);

  if (!originCoords || !destCoords) {
    return null;
  }

  return await getDrivingRoute(originCoords, destCoords);
}

export async function calculateRouteDistance(pickup: string, delivery: string): Promise<number | null> {
  return (await calculateRouteEstimate(pickup, delivery))?.km ?? null;
}
