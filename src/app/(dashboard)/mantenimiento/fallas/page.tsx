"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { toast } from "sonner";
import { format } from "date-fns";
import { Loader2, Wrench, Clock, AlertTriangle, ArrowRight, CheckCircle2, Stethoscope, CalendarClock, XCircle, Plus } from "lucide-react";

const supabase = createClient();

// Fuente única: public.maintenance_requests vía vw_maintenance_backlog (migración 20260927100000).
type Severity = "CRITICA" | "ALTA" | "MEDIA" | "BAJA";
type RequestStatus = "REPORTADA" | "VALIDADA" | "DIAGNOSTICADA" | "PROGRAMADA" | "CONVERTIDA_OT";

interface BacklogItem {
  id: string;
  vehicle_plate: string;
  vehicle_type: string | null;
  vehicle_status: string | null;
  description: string;
  severity: Severity;
  status: RequestStatus;
  source: string;
  reported_at: string;
  odometer_at_report: number | null;
  driver_name: string | null;
  responsible_name: string | null;
  diagnosis: string | null;
  scheduled_for: string | null;
  work_order_code: string | null;
  work_order_status: string | null;
  age_days: number;
  age_bucket: string;
  impact: string;
  priority_score: number;
}

const SEVERITY_BADGE: Record<Severity, string> = {
  CRITICA: "bg-red-600 hover:bg-red-700 text-white",
  ALTA: "bg-orange-500 hover:bg-orange-600 text-white",
  MEDIA: "bg-yellow-500 hover:bg-yellow-600 text-white",
  BAJA: "bg-blue-500 hover:bg-blue-600 text-white",
};

const SOURCE_LABEL: Record<string, string> = {
  APP_CONDUCTOR: "App conductor",
  SUPERVISOR: "Supervisor",
  INSPECCION: "Inspección",
  MANTENIMIENTO: "Mantenimiento",
  COPILOTO_AI: "Copiloto AI",
  TORRE_CONTROL: "Torre de Control",
};

function queryBacklog() {
  return supabase
    .from("vw_maintenance_backlog")
    .select("*")
    .order("priority_score", { ascending: false })
    .order("reported_at", { ascending: true });
}

export default function FallasBacklogPage() {
  const [items, setItems] = useState<BacklogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = useState<string>("TODAS");
  const [statusFilter, setStatusFilter] = useState<string>("TODOS");
  const [showForm, setShowForm] = useState(false);
  const [plates, setPlates] = useState<string[]>([]);
  const [form, setForm] = useState({ vehicle_plate: "", description: "", severity: "MEDIA", source: "SUPERVISOR", odometer: "" });

  const applyBacklog = useCallback(({ data, error }: { data: unknown[] | null; error: { message: string } | null }) => {
    if (error) {
      console.error(error);
      toast.error("No se pudo cargar el backlog de fallas.");
    } else {
      setItems((data || []) as BacklogItem[]);
    }
    setLoading(false);
  }, []);

  const fetchBacklog = useCallback(() => {
    setLoading(true);
    return queryBacklog().then(applyBacklog);
  }, [applyBacklog]);

  useEffect(() => {
    queryBacklog().then(applyBacklog);
    supabase.from("vehicles").select("plate").order("plate").then(({ data }) => {
      setPlates((data || []).map((v: { plate: string }) => v.plate));
    });
  }, [applyBacklog]);

  const filtered = useMemo(
    () => items.filter(i =>
      (severityFilter === "TODAS" || i.severity === severityFilter) &&
      (statusFilter === "TODOS" || i.status === statusFilter)),
    [items, severityFilter, statusFilter]
  );

  const kpis = useMemo(() => ({
    total: items.length,
    criticas: items.filter(i => i.severity === "CRITICA").length,
    enOt: items.filter(i => i.status === "CONVERTIDA_OT").length,
    antiguedad: items.length ? Math.round(items.reduce((s, i) => s + i.age_days, 0) / items.length) : 0,
    viejas: items.filter(i => i.age_days > 7).length,
  }), [items]);

  const transition = async (item: BacklogItem, newStatus: string) => {
    let notes: string | null = null;
    let scheduled: string | null = null;
    if (newStatus === "DIAGNOSTICADA") {
      notes = prompt("Diagnóstico técnico:", item.diagnosis || "");
      if (!notes?.trim()) return;
    } else if (newStatus === "PROGRAMADA") {
      scheduled = prompt("Fecha programada (AAAA-MM-DD):", item.scheduled_for || new Date().toISOString().slice(0, 10));
      if (!scheduled || !/^\d{4}-\d{2}-\d{2}$/.test(scheduled)) {
        if (scheduled !== null) toast.error("Formato de fecha inválido (AAAA-MM-DD)");
        return;
      }
    } else if (newStatus === "DESCARTADA") {
      notes = prompt("Motivo del descarte (obligatorio):");
      if (!notes?.trim()) return;
    }
    setBusy(item.id);
    const { data, error } = await supabase.rpc("transition_maintenance_request", {
      p_request_id: item.id,
      p_new_status: newStatus,
      p_notes: notes,
      p_responsible_id: null,
      p_scheduled_for: scheduled,
    });
    setBusy(null);
    if (error || !data?.success) {
      toast.error(error?.message || data?.error || "No se pudo actualizar la falla");
      return;
    }
    toast.success(`${item.vehicle_plate}: ${data.previous_status} → ${newStatus}`);
    fetchBacklog();
  };

  const convertToOT = async (item: BacklogItem) => {
    setBusy(item.id);
    const { data: userData } = await supabase.auth.getUser();
    const { error } = await supabase.rpc("convert_request_to_wo", {
      p_request_id: item.id,
      p_user_id: userData.user?.id ?? null,
    });
    setBusy(null);
    if (error) {
      toast.error(error.message || "No se pudo convertir a OT");
      return;
    }
    toast.success("OT creada en BORRADOR y vinculada a la falla.");
    fetchBacklog();
  };

  const createRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.vehicle_plate || !form.description.trim()) return;
    setBusy("new");
    const { error } = await supabase.from("maintenance_requests").insert({
      vehicle_plate: form.vehicle_plate,
      description: form.description.trim(),
      severity: form.severity,
      source: form.source,
      odometer_at_report: form.odometer ? Number(form.odometer) : null,
    });
    setBusy(null);
    if (error) {
      toast.error(error.code === "23505" ? "Esta falla ya fue registrada hoy para la unidad." : error.message);
      return;
    }
    toast.success(form.severity === "CRITICA"
      ? "Falla crítica registrada: la unidad fue bloqueada por el motor de elegibilidad."
      : "Falla registrada en el backlog.");
    setForm({ vehicle_plate: "", description: "", severity: "MEDIA", source: "SUPERVISOR", odometer: "" });
    setShowForm(false);
    fetchBacklog();
  };

  const actionsFor = (item: BacklogItem) => {
    const disabled = busy === item.id;
    const btn = (label: string, icon: React.ReactNode, onClick: () => void, variant: "default" | "outline" | "destructive" = "outline") => (
      <Button key={label} size="sm" variant={variant} disabled={disabled} onClick={onClick} className="gap-1">
        {icon}{label}
      </Button>
    );
    if (item.status === "CONVERTIDA_OT") {
      return <div className="text-sm text-muted-foreground">En OT {item.work_order_code} ({item.work_order_status})</div>;
    }
    return (
      <div className="flex flex-wrap gap-2">
        {item.status === "REPORTADA" && btn("Validar", <CheckCircle2 className="w-4 h-4" />, () => transition(item, "VALIDADA"))}
        {["REPORTADA", "VALIDADA", "PROGRAMADA"].includes(item.status) && btn("Diagnosticar", <Stethoscope className="w-4 h-4" />, () => transition(item, "DIAGNOSTICADA"))}
        {item.status !== "PROGRAMADA" && btn("Programar", <CalendarClock className="w-4 h-4" />, () => transition(item, "PROGRAMADA"))}
        {btn("Convertir a OT", <ArrowRight className="w-4 h-4" />, () => convertToOT(item), "default")}
        {btn("Descartar", <XCircle className="w-4 h-4" />, () => transition(item, "DESCARTADA"), "destructive")}
      </div>
    );
  };

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div className="flex flex-wrap justify-between items-center gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Backlog de Fallas</h1>
          <p className="text-muted-foreground mt-2">
            Fuente única de anomalías: App conductor, inspecciones, supervisores, Copiloto AI y Torre de Control.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setShowForm(s => !s)} className="gap-2"><Plus className="w-4 h-4" />Registrar falla</Button>
          <Button onClick={fetchBacklog} variant="outline" disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Clock className="w-4 h-4 mr-2" />}
            Actualizar
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          ["Pendientes", kpis.total],
          ["Críticas", kpis.criticas],
          ["En OT", kpis.enOt],
          ["Antigüedad prom. (días)", kpis.antiguedad],
          ["Más de 7 días", kpis.viejas],
        ].map(([label, value]) => (
          <Card key={label as string}>
            <CardContent className="pt-4">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="text-2xl font-bold">{value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {showForm && (
        <Card>
          <CardHeader><CardTitle className="text-lg">Registrar falla</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={createRequest} className="grid gap-3 md:grid-cols-5">
              <select required className="border rounded-md px-3 py-2 text-sm" value={form.vehicle_plate}
                onChange={e => setForm({ ...form, vehicle_plate: e.target.value })}>
                <option value="">Unidad…</option>
                {plates.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
              <input required className="border rounded-md px-3 py-2 text-sm md:col-span-2" placeholder="Descripción de la falla"
                value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
              <select className="border rounded-md px-3 py-2 text-sm" value={form.severity}
                onChange={e => setForm({ ...form, severity: e.target.value })}>
                {(["CRITICA", "ALTA", "MEDIA", "BAJA"] as const).map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <select className="border rounded-md px-3 py-2 text-sm" value={form.source}
                onChange={e => setForm({ ...form, source: e.target.value })}>
                {["SUPERVISOR", "MANTENIMIENTO", "TORRE_CONTROL"].map(s => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
              </select>
              <input type="number" min={0} className="border rounded-md px-3 py-2 text-sm" placeholder="Odómetro (opcional)"
                value={form.odometer} onChange={e => setForm({ ...form, odometer: e.target.value })} />
              <Button type="submit" disabled={busy === "new"} className="md:col-span-1">
                {busy === "new" ? <Loader2 className="w-4 h-4 animate-spin" /> : "Guardar"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap gap-3">
        <select className="border rounded-md px-3 py-2 text-sm" value={severityFilter} onChange={e => setSeverityFilter(e.target.value)}>
          <option value="TODAS">Todas las criticidades</option>
          {(["CRITICA", "ALTA", "MEDIA", "BAJA"] as const).map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="border rounded-md px-3 py-2 text-sm" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="TODOS">Todos los estados</option>
          {(["REPORTADA", "VALIDADA", "DIAGNOSTICADA", "PROGRAMADA", "CONVERTIDA_OT"] as const).map(s => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="flex justify-center items-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : filtered.length === 0 ? (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Todo al día</AlertTitle>
          <AlertDescription>No hay fallas pendientes con estos filtros.</AlertDescription>
        </Alert>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map(item => (
            <Card key={item.id} className="flex flex-col">
              <CardHeader className="pb-3">
                <div className="flex justify-between items-start gap-2">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Wrench className="w-5 h-5 text-muted-foreground" />
                    {item.vehicle_plate}
                  </CardTitle>
                  <Badge className={SEVERITY_BADGE[item.severity]}>{item.severity}</Badge>
                </div>
                <div className="text-xs text-muted-foreground space-y-0.5">
                  <div>Reportado {format(new Date(item.reported_at), "dd/MM/yyyy HH:mm")} · {SOURCE_LABEL[item.source] ?? item.source}</div>
                  <div>Antigüedad: {item.age_days} d ({item.age_bucket}) · Prioridad {item.priority_score}</div>
                  {item.impact === "BLOQUEA_ACTIVO" && (
                    <div className="text-red-600 font-medium">Bloquea el activo · unidad {item.vehicle_status}</div>
                  )}
                </div>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col gap-3">
                <p className="text-sm">{item.description}</p>
                {item.diagnosis && <p className="text-xs"><span className="font-medium">Diagnóstico:</span> {item.diagnosis}</p>}
                <div className="text-xs text-muted-foreground">
                  {item.driver_name && <div>Conductor: {item.driver_name}</div>}
                  <div>Responsable: {item.responsible_name || "Sin asignar"}</div>
                  {item.scheduled_for && <div>Programada: {item.scheduled_for}</div>}
                </div>
                <div className="text-sm font-medium">Estado: <Badge variant="secondary">{item.status.replace("_", " ")}</Badge></div>
                <div className="mt-auto">{actionsFor(item)}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
