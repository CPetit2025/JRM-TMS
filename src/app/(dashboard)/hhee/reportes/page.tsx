import { PersonnelReports } from '@/components/personal/gestion'
import { Panel } from '@/components/hhee/flujo/panel'
export default function Page() { return <div className="grid gap-6"><PersonnelReports /><details className="rounded-xl border border-slate-200 p-3"><summary className="cursor-pointer font-semibold">Análisis gerencial de HHEE autorizadas y costos estimados</summary><div className="mt-4"><Panel /></div></details></div> }
