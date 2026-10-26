// Consultas de referencia: lotes acotados, concurrencia limitada y cancelación al cambiar de vista.
export type ErpReferenceState = 'pendiente' | 'sin_acceso' | 'error'
export class ErpReferenceError extends Error {
 constructor(public readonly state: ErpReferenceState, message: string) { super(message); this.name = 'ErpReferenceError' }
}
type Reply = { data: unknown; error: { code?: string; message?: string } | null; status?: number }
type Page<T,C> = { success?: boolean; error?: string; filas?: Record<string,T>; config?: C; sin_datos?: boolean; cortes?: Record<string,string> }
export async function referenceBatches<T,C>(codes: string[], query: (codes:string[],signal:AbortSignal)=>PromiseLike<Reply>, signal:AbortSignal) {
 const controller=new AbortController()
 const abort=()=>controller.abort()
 signal.addEventListener('abort',abort,{once:true})
 if(signal.aborted) controller.abort()
 const batches:string[][]=[]
 const selected=[...new Set(codes.filter(Boolean))]
 for(let i=0;i<selected.length;i+=100) batches.push(selected.slice(i,i+100))
 const pages:Page<T,C>[]=[]
 let next=0
 try {
  const worker=async()=>{
   while(next<batches.length && !controller.signal.aborted){
    const index=next++, reply=await query(batches[index],controller.signal)
    if(controller.signal.aborted) throw new DOMException('Consulta cancelada','AbortError')
    if(reply.error){
     const code=reply.error.code
     if(code==='PGRST202'||code==='42883') throw new ErpReferenceError('pendiente','La consulta del ERP está pendiente de activar.')
     if(reply.status===401||reply.status===403||code==='42501') throw new ErpReferenceError('sin_acceso','La sesión no tiene acceso a esta referencia del ERP.')
     throw new ErpReferenceError('error',code==='57014'?'La consulta del ERP agotó el tiempo disponible. Reintente.':'No se pudo consultar la referencia del ERP. Reintente.')
    }
    const page=reply.data as Page<T,C>|null
    if(!page?.success) throw new ErpReferenceError(page?.error?.startsWith('Sin acceso')?'sin_acceso':'error','No se pudo obtener una referencia válida del ERP.')
    pages[index]=page
   }
  }
  await Promise.all(Array.from({length:Math.min(2,batches.length)},worker))
  if(controller.signal.aborted) throw new DOMException('Consulta cancelada','AbortError')
  const filas:Record<string,T>={}; let config:C|null=null, sin_datos=false, cutoff:string|undefined
  for(const page of pages){
   if(page.cortes){const current=JSON.stringify(Object.entries(page.cortes).sort());if(cutoff!==undefined&&cutoff!==current)throw new ErpReferenceError('error','Las cargas del ERP cambiaron durante la consulta. Reintente.');cutoff=current}
   Object.assign(filas,page.filas||{});config=page.config||config;sin_datos ||= !!page.sin_datos
  }
  return {filas,config,sin_datos}
 }catch(error){controller.abort();throw error}finally{signal.removeEventListener('abort',abort)}
}
