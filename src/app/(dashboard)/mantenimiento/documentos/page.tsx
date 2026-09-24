"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { format } from "date-fns";
import { Loader2, AlertTriangle, FileText, CheckCircle, XCircle, Clock } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface Documento {
  id: string;
  vehicle_plate: string;
  document_type: string;
  document_number: string;
  issue_date: string | null;
  expiration_date: string;
  file_url: string | null;
  status: string;
}

export default function DocumentosCumplimientoPage() {
  const [documents, setDocuments] = useState<Documento[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchDocuments();
  }, []);

  async function fetchDocuments() {
    try {
      setLoading(true);
      setError(null);
      const { data, error: err } = await supabase
        .from('vw_document_alerts')
        .select('*')
        .order('expiration_date', { ascending: true });

      if (err) throw err;
      
      setDocuments(data || []);
    } catch (err: any) {
      console.error("Error fetching documents:", err);
      setError(err.message || "Error al cargar los documentos.");
      toast.error("Error al cargar los documentos.");
    } finally {
      setLoading(false);
    }
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'VIGENTE':
        return <Badge className="bg-green-100 text-green-800 hover:bg-green-100 flex items-center gap-1"><CheckCircle className="w-3 h-3" /> Vigente</Badge>;
      case 'POR_VENCER':
        return <Badge className="bg-yellow-100 text-yellow-800 hover:bg-yellow-100 flex items-center gap-1"><Clock className="w-3 h-3" /> Por Vencer</Badge>;
      case 'VENCIDO':
        return <Badge className="bg-red-100 text-red-800 hover:bg-red-100 flex items-center gap-1"><XCircle className="w-3 h-3" /> Vencido</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const vencidos = documents.filter(d => d.status === 'VENCIDO');
  const porVencer = documents.filter(d => d.status === 'POR_VENCER');

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div className="flex flex-col md:flex-row justify-between md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Cumplimiento Documentario</h1>
          <p className="text-muted-foreground mt-2">
            Gestión y alertas de documentos vehiculares
          </p>
        </div>
      </div>

      {(vencidos.length > 0 || porVencer.length > 0) && (
        <Alert variant="destructive" className="bg-red-50 border-red-200">
          <AlertTriangle className="h-4 w-4 text-red-600" />
          <AlertTitle className="text-red-800">Alertas de Cumplimiento</AlertTitle>
          <AlertDescription className="text-red-700">
            Hay {vencidos.length} documento(s) vencido(s) y {porVencer.length} próximo(s) a vencer. Revise la lista para regularizarlos y evitar bloqueos en el motor de elegibilidad.
          </AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5" />
            Documentos Vehiculares
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center items-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
            </div>
          ) : documents.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              No hay documentos registrados.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-muted-foreground uppercase bg-muted/50">
                  <tr>
                    <th className="px-4 py-3 rounded-tl-lg">Placa</th>
                    <th className="px-4 py-3">Tipo Documento</th>
                    <th className="px-4 py-3">N° Documento</th>
                    <th className="px-4 py-3">Emisión</th>
                    <th className="px-4 py-3">Vencimiento</th>
                    <th className="px-4 py-3">Estado</th>
                    <th className="px-4 py-3 rounded-tr-lg">Archivo</th>
                  </tr>
                </thead>
                <tbody>
                  {documents.map((doc) => (
                    <tr 
                      key={doc.id} 
                      className="border-b last:border-0 hover:bg-muted/30 transition-colors"
                    >
                      <td className="px-4 py-3 font-medium">{doc.vehicle_plate}</td>
                      <td className="px-4 py-3">{doc.document_type.replace('_', ' ')}</td>
                      <td className="px-4 py-3">{doc.document_number || '-'}</td>
                      <td className="px-4 py-3">{doc.issue_date ? format(new Date(doc.issue_date), 'dd/MM/yyyy') : '-'}</td>
                      <td className="px-4 py-3 font-medium">
                        {format(new Date(doc.expiration_date), 'dd/MM/yyyy')}
                      </td>
                      <td className="px-4 py-3">
                        {getStatusBadge(doc.status)}
                      </td>
                      <td className="px-4 py-3">
                        {doc.file_url ? (
                          <a href={doc.file_url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline text-xs flex items-center gap-1">
                            <FileText className="w-3 h-3" /> Ver
                          </a>
                        ) : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
