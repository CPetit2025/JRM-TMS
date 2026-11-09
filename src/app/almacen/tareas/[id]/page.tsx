import { redirect } from 'next/navigation'
export default async function LegacyTask({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  redirect(`/almacen/picking/${id}`)
}
