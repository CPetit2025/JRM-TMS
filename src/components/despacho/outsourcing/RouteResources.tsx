"use client";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { OUTSOURCING_SERVICES } from "@/lib/outsourcing";
import type { AssignedResource } from "@/lib/outsourcing-resources";
import { errorMessage } from "@/lib/caja";
export function RouteResources({ dispatchId }: { dispatchId: string }) {
  const db = useMemo(() => createClient(), []),
    [rows, setRows] = useState<AssignedResource[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void db
      .rpc("outsourcing_route_resources", { p_dispatch: dispatchId })
      .then(({ data, error }) => {
        if (live) {
          if (error) setError(errorMessage(error));
          else {
            setRows(data || []);
            setError("");
          }
        }
      });
    return () => {
      live = false;
    };
  }, [db, dispatchId]);
  if (error)
    return (
      <p role="alert" className="text-sm text-red-700">
        No se pudo comprobar los recursos tercerizados: {error}
      </p>
    );
  if (!rows.length) return null;
  return (
    <section className="space-y-2 rounded-xl border border-blue-200 bg-blue-50 p-3">
      <h3 className="font-semibold">Recursos tercerizados vinculados</h3>
      {rows.map((r) => (
        <div key={r.id} className="text-sm">
          <strong>
            {OUTSOURCING_SERVICES[r.service]} · {r.supplier_name}
          </strong>
          <p>
            {r.resource.plate ||
              r.resource.equipment ||
              r.resource.responsible ||
              r.resource.description}{" "}
            · Cantidad {r.quantity}
          </p>
          <p>
            {r.resource.driver || r.resource.operator || r.resource.activity} ·
            S/ {Number(r.amount_pen).toFixed(2)}
          </p>
          <p className="text-xs text-slate-600">Asignación {r.id}</p>
        </div>
      ))}
    </section>
  );
}
