import { ReturnFile } from '@/components/warehouse/inventario/ReturnFile'
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <ReturnFile id={id}/>
}
