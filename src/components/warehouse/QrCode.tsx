import { encode } from 'uqr'

/** Matriz QR (true = módulo negro) con su margen de 1 módulo. Corrección M: se lee aunque se dañe ~15 %. */
export const qrMatrix = (value: string) => encode(value, { ecc: 'M' }).data

/** QR del mismo código que el Code 128: el escáner de celular o tablet lee cualquiera de los dos. */
export function QrCode({ value, size, className = '' }: { value: string; size: number; className?: string }) {
  const m = qrMatrix(value)
  return (
    <svg role="img" aria-label={`Código QR ${value}`} className={className} width={size} height={size} viewBox={`0 0 ${m.length} ${m.length}`} shapeRendering="crispEdges">
      <rect width={m.length} height={m.length} fill="#fff" />
      <path d={m.flatMap((row, y) => row.map((on, x) => (on ? `M${x} ${y}h1v1h-1z` : ''))).join('')} fill="#000" />
    </svg>
  )
}
