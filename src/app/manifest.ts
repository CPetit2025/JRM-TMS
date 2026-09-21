import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'JRM-TMS',
    short_name: 'JRM',
    description: 'Sistema de gestión de transporte y operaciones JRM',
    start_url: '/login',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#002855',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  }
}
