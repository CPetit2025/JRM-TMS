import type { CSSProperties } from 'react';
import { Code128Barcode } from './Code128Barcode';
import { QrCode } from './QrCode';

/** El QR usa también el alto antes reservado al texto, sin quitar espacio al contenido de la etiqueta. */
export function LabelCodes({ value, grouped = false }: { value: string; grouped?: boolean }) {
  return <div className={`wh-package-codes${grouped ? ' wh-grouped-codes' : ''}`}>
    <div className="wh-package-linear" style={{ "--wh-code-length": Math.max(1, value.length) } as CSSProperties}>
      <Code128Barcode value={value} className="wh-package-barcode"/>
      <b className="wh-package-code">{value}</b>
    </div>
    <QrCode value={value} className="wh-package-qr"/>
  </div>;
}
