import { redirect } from 'next/navigation'

// "Entrega de fondos" (prototipo sobre cash_funds) se reemplazó por Cajas y fondos + Anticipos (Caja C2).
export default function FondosPage() {
  redirect('/caja/cajas')
}
