import { AppLayout } from "@/components/layout/app-layout";
import NotificationProvider from "@/components/NotificationProvider";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <NotificationProvider role="admin" />
      <AppLayout>{children}</AppLayout>
    </>
  );
}
