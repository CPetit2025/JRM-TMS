import { redirect } from 'next/navigation';
// Ventana retirada del flujo simple: la aprobación vive en Solicitudes
export default function Page() { redirect('/hhee/solicitudes'); }
