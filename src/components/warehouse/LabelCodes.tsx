import type { CSSProperties } from 'react';
import { QrCode } from './QrCode';

/** Solo QR (se escanea con celular o tablet) y, a su lado, el identificador impreso para digitarlo si hace falta. */
export function LabelCodes({ value, grouped = false }: { value: string; grouped?: boolean }) {
  return <div className={`wh-package-codes${grouped ? ' wh-grouped-codes' : ''}`}>
    <QrCode value={value} className="wh-package-qr"/>
    <div className="wh-package-linear" style={{ "--wh-code-length": Math.max(1, value.length) } as CSSProperties}>
      <b className="wh-package-code">{value}</b>
    </div>
  </div>;
}
