import { encode } from "uqr";

/** Matriz QR (true = módulo negro) con cuatro módulos de margen; corrección M. La usan el SVG y los PDF. */
export const qrMatrix = (value: string) => encode(value, { ecc: "M", border: 4 }).data;

/** QR del identificador del bulto, con cuatro módulos de margen. */
export function QrCode({ value, className = "" }: { value: string; className?: string }) {
  const qr = encode(value, { ecc: "M", border: 4 });
  const path = qr.data.flatMap((row, y) => row.flatMap((black, x) => black ? [`M${x} ${y}h1v1h-1z`] : [])).join("");
  return <svg role="img" aria-label={`Código QR ${value}`} className={className} viewBox={`0 0 ${qr.size} ${qr.size}`} shapeRendering="crispEdges">
    <rect width={qr.size} height={qr.size} fill="white" />
    <path d={path} fill="black" />
  </svg>;
}
