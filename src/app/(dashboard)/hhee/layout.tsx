import { FlowProvider } from '@/components/hhee/flujo/context';

// HHEE: tres ventanas (Solicitudes y aprobación, Personal, Panel gerencial). Configuración para quien la administra.
export default function Layout({ children }: { children: React.ReactNode }) { return <FlowProvider>{children}</FlowProvider>; }
