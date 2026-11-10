import { TaskWorkspace } from '@/components/warehouse/dispatch/TaskWorkspace'
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <TaskWorkspace id={id} stage="picking"/>
}
