import { AuditWorkspace } from '@/components/warehouse/dispatch/AuditWorkspace'
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <AuditWorkspace mode="packing-list" initialTaskId={id}/>
}
