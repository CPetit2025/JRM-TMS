import { ArrowDownToLine, ArrowLeftRight, Store, Truck } from 'lucide-react'
import { SERVICE_KINDS, serviceKind, type RequestService, type ServiceKind } from '@/lib/request-service'

/** Tipo de servicio: chip cuadrado con ícono (los estados usan píldoras), mismo color en todas las tablas. */
const STYLES: Record<ServiceKind, { className: string; Icon: typeof Truck }> = {
  ENTREGA_OT: { className: 'bg-sky-50 text-sky-800 ring-sky-200', Icon: Truck },
  RECOJO: { className: 'bg-orange-50 text-orange-800 ring-orange-200', Icon: ArrowDownToLine },
  PUNTO_A_PUNTO: { className: 'bg-fuchsia-50 text-fuchsia-800 ring-fuchsia-200', Icon: ArrowLeftRight },
  RECOJO_CLIENTE: { className: 'bg-teal-50 text-teal-800 ring-teal-200', Icon: Store },
  ENTREGA: { className: 'bg-slate-100 text-slate-700 ring-slate-200', Icon: Truck },
}

export function ServiceTypeBadge({ kind, request, full = false }: { kind?: ServiceKind | null; request?: Partial<RequestService> | null; full?: boolean }) {
  const value = kind ?? serviceKind(request)
  if (!value) return <span title="Tipo de servicio no disponible" className="text-xs text-slate-400">—</span>
  const { className, Icon } = STYLES[value]
  return <span title={SERVICE_KINDS[value].label} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${className}`}>
    <Icon aria-hidden className="h-3 w-3 shrink-0" />{full ? SERVICE_KINDS[value].label : SERVICE_KINDS[value].short}
  </span>
}

/** Varios servicios en una ruta: un chip por tipo distinto, en orden fijo. */
export function ServiceTypeList({ requests }: { requests: (Partial<RequestService> | null | undefined)[] }) {
  const order = Object.keys(SERVICE_KINDS) as ServiceKind[]
  const kinds = order.filter(k => requests.some(r => serviceKind(r) === k))
  if (!kinds.length) return <ServiceTypeBadge kind={null} />
  return <span className="flex flex-wrap gap-1">{kinds.map(k => <ServiceTypeBadge key={k} kind={k} />)}</span>
}
