import { HheeProvider } from '@/components/hhee/provider';
export default function Layout({ children }: {
    children: React.ReactNode;
}) { return <HheeProvider>{children}</HheeProvider>; }
