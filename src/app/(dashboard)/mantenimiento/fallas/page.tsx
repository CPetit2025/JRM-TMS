"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { format } from "date-fns";
import { Loader2, Wrench, Clock, AlertTriangle, ArrowRight } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface Falla {
  id: string;
  vehicle_plate: string;
  description: string;
  severity: string;
  status: string;
  reported_at: string;
  odometer_at_report: number;
}

const severityOrder: Record<string, number> = {
  "CRÍTICA": 1,
  "ALTA": 2,
  "MEDIA": 3,
  "BAJA": 4
};

export default function FallasBacklogPage() {
  const [fallas, setFallas] = useState<Falla[]>([]);
  const [loading, setLoading] = useState(true);
  const [converting, setConverting] = useState<string | null>(null);

  const fetchFallas = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("maintenance_requests")
      .select("*")
      .in("status", ["REPORTADA", "VALIDADA", "DIAGNOSTICADA", "PROGRAMADA", "PENDIENTE"]);

    if (error) {
      console.error(error);
      toast.error("No se pudieron cargar las fallas pendientes.");
    } else {
      const sorted = (data || []).sort((a, b) => {
        // Ordenar por criticidad primero
        const sevA = severityOrder[a.severity] || 99;
        const sevB = severityOrder[b.severity] || 99;
        if (sevA !== sevB) return sevA - sevB;
        // Luego por antigüedad
        return new Date(a.reported_at).getTime() - new Date(b.reported_at).getTime();
      });
      setFallas(sorted);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchFallas();
  }, []);

  const handleConvertToOT = async (fallaId: string) => {
    setConverting(fallaId);
    try {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) throw new Error("No autenticado");

      const { data, error } = await supabase.rpc("convert_request_to_wo", {
        p_request_id: fallaId,
        p_user_id: userData.user.id
      });

      if (error) throw error;

      toast.success("OT Creada: Se creó la OT en borrador exitosamente.");

      // Refrescar
      await fetchFallas();
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "Ocurrió un error al convertir.");
    } finally {
      setConverting(null);
    }
  };

  const getSeverityBadge = (severity: string) => {
    switch (severity) {
      case "CRÍTICA": return <Badge variant="destructive">{severity}</Badge>;
      case "ALTA": return <Badge className="bg-orange-500 hover:bg-orange-600">{severity}</Badge>;
      case "MEDIA": return <Badge className="bg-yellow-500 hover:bg-yellow-600">{severity}</Badge>;
      case "BAJA": return <Badge className="bg-blue-500 hover:bg-blue-600">{severity}</Badge>;
      default: return <Badge>{severity}</Badge>;
    }
  };

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Backlog de Fallas</h1>
          <p className="text-muted-foreground mt-2">
            Gestión centralizada de anomalías y solicitudes de mantenimiento.
          </p>
        </div>
        <Button onClick={fetchFallas} variant="outline" disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Clock className="w-4 h-4 mr-2" />}
          Actualizar
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center items-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : fallas.length === 0 ? (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Todo al día</AlertTitle>
          <AlertDescription>
            No hay fallas pendientes en el backlog.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {fallas.map((falla) => (
            <Card key={falla.id} className="flex flex-col">
              <CardHeader className="pb-3">
                <div className="flex justify-between items-start">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Wrench className="w-5 h-5 text-muted-foreground" />
                    {falla.vehicle_plate}
                  </CardTitle>
                  {getSeverityBadge(falla.severity)}
                </div>
                <div className="text-sm text-muted-foreground">
                  Reportado: {format(new Date(falla.reported_at), "dd/MM/yyyy HH:mm")}
                </div>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col">
                <p className="text-sm flex-1 mb-4">{falla.description}</p>
                <div className="flex flex-col gap-2 mt-auto">
                  <div className="text-sm font-medium">Estado: <Badge variant="secondary">{falla.status}</Badge></div>
                  <Button 
                    className="w-full mt-2"
                    onClick={() => handleConvertToOT(falla.id)}
                    disabled={converting === falla.id}
                  >
                    {converting === falla.id ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <ArrowRight className="w-4 h-4 mr-2" />
                    )}
                    Convertir a OT
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
