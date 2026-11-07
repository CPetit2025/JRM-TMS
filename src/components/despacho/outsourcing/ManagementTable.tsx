"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { errorMessage } from "@/lib/caja";
import {
  OUTSOURCING_SERVICES,
  type OutsourcingService,
} from "@/lib/outsourcing";
import { cellDateTime } from "@/lib/table-format";
type Entry = {
  id: string;
  number: number;
  request_number: string;
  contract_code: string;
  client: string;
  service: OutsourcingService;
  quantity: number;
  assigned: number;
  remaining: number;
  suppliers: string | null;
  state: string;
  required_at: string | null;
  costs: { currency: string; amount: number; confirmed: boolean }[] | null;
};
const input = "w-full rounded-lg border border-slate-300 bg-white p-2 text-sm";
export function ManagementTable({
  refresh,
  onSelect,
}: {
  refresh: number;
  onSelect: (id: string, service: OutsourcingService) => void;
}) {
  const db = useMemo(() => createClient(), []);
  const [filters, setFilters] = useState({
      search: "",
      state: "",
      service: "",
      from: "",
      to: "",
      supplier: "",
    }),
    [page, setPage] = useState(0);
  const [items, setItems] = useState<Entry[]>([]),
    [total, setTotal] = useState(0),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [providers, setProviders] = useState<
    { id: string; business_name: string }[]
  >([]);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    void db
      .from("suppliers")
      .select("id,business_name")
      .eq("is_active", true)
      .order("business_name")
      .then(({ data }) => {
        if (live) setProviders(data || []);
      });
    return () => {
      live = false;
    };
  }, [db]);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      setLoading(true);
      void db
        .rpc("outsourcing_management_queue", {
          p: { ...filters, offset: page * 25, limit: 25 },
        })
        .then(({ data, error }) => {
          if (!live) return;
          setLoading(false);
          if (error) setError(errorMessage(error));
          else {
            setError("");
            setItems(data.items);
            setTotal(Number(data.total));
          }
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [db, filters, page, refresh, retry]);
  const change = useCallback((key: keyof typeof filters, value: string) => {
    setPage(0);
    setFilters((prev) => ({ ...prev, [key]: value }));
  }, []);
  return (
    <section
      className="min-w-0 space-y-3 rounded-xl border bg-white p-4"
      aria-label="Bandeja de servicios tercerizados"
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-xs">
          Buscar OT, solicitud, cliente, proveedor o destino
          <input
            className={input}
            type="search"
            value={filters.search}
            onChange={(e) => change("search", e.target.value)}
          />
        </label>
        <label className="text-xs">
          Servicio
          <select
            className={input}
            value={filters.service}
            onChange={(e) => change("service", e.target.value)}
          >
            <option value="">Todos los servicios</option>
            {Object.entries(OUTSOURCING_SERVICES).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          Estado
          <select
            className={input}
            value={filters.state}
            onChange={(e) => change("state", e.target.value)}
          >
            <option value="">Todos los estados</option>
            {[
              "PENDIENTE",
              "EN GESTIÓN",
              "OBSERVADA",
              "PARCIAL",
              "ASIGNADA",
              "CONFIRMADA",
              "CANCELADA",
              "FINALIZADA",
            ].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          Desde
          <input
            type="date"
            className={input}
            value={filters.from}
            onChange={(e) => change("from", e.target.value)}
          />
        </label>
        <label className="text-xs">
          Hasta
          <input
            type="date"
            className={input}
            value={filters.to}
            onChange={(e) => change("to", e.target.value)}
          />
        </label>
        <label className="text-xs">
          Proveedor
          <select
            className={input}
            value={filters.supplier}
            onChange={(e) => change("supplier", e.target.value)}
          >
            <option value="">Todos los proveedores</option>
            {providers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.business_name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}{" "}
          <button onClick={() => setRetry((v) => v + 1)} className="underline">
            Reintentar
          </button>
        </p>
      ) : (
        <>
          <div className="overflow-x-auto" aria-busy={loading}>
            <table className="w-full text-left text-sm">
              <caption className="py-2 text-left text-xs text-slate-500">
                {loading
                  ? "Cargando servicios…"
                  : `${total} servicios · Ordenados por fecha requerida · Horario de Lima`}
              </caption>
              <thead className="bg-slate-50 text-xs text-slate-600">
                <tr>
                  {[
                    "Fecha requerida",
                    "OT / Solicitud",
                    "Cliente",
                    "Servicio",
                    "Proveedor",
                    "Cantidad",
                    "Costo",
                    "Estado",
                    "Acciones",
                  ].map((s) => (
                    <th key={s} className="whitespace-nowrap p-3">
                      {s}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr
                    key={`${r.id}-${r.service}`}
                    className="border-t align-top hover:bg-blue-50/40"
                  >
                    <td className="whitespace-nowrap p-3">
                      {r.required_at
                        ? cellDateTime(r.required_at)
                        : "Por definir"}
                    </td>
                    <td className="p-3">
                      <strong>{r.contract_code || "Sin OT"}</strong>
                      <span className="block text-xs">
                        ST-{r.number} · {r.request_number}
                      </span>
                    </td>
                    <td className="p-3">{r.client || "Sin cliente"}</td>
                    <td className="p-3">{OUTSOURCING_SERVICES[r.service]}</td>
                    <td className="max-w-56 p-3">
                      {r.suppliers || (
                        <span className="text-amber-700">Pendiente</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap p-3">
                      {r.assigned} / {r.quantity}
                      <span className="block text-xs text-slate-500">
                        Pendiente {r.remaining}
                      </span>
                    </td>
                    <td className="whitespace-nowrap p-3">
                      {r.costs?.map((c) => (
                        <span key={c.currency} className="block">
                          {c.currency} {Number(c.amount).toFixed(2)}
                          <small className="block text-slate-500">
                            {c.confirmed ? "Confirmado" : "Cotizado"}
                          </small>
                        </span>
                      )) || "Por cotizar"}
                    </td>
                    <td className="p-3">
                      <span className="whitespace-nowrap rounded-full bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-900">
                        {r.state}
                      </span>
                    </td>
                    <td className="p-3">
                      <button
                        className="rounded-lg border px-3 py-2 font-semibold text-blue-900"
                        onClick={() => onSelect(r.id, r.service)}
                      >
                        Ver / gestionar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!loading && !items.length && (
              <p className="p-6 text-center text-sm text-slate-500">
                Sin servicios para estos filtros. Genere el requerimiento desde
                Programación y Ruteo.
              </p>
            )}
          </div>
          <nav
            aria-label="Páginas de tercerizaciones"
            className="flex items-center justify-between gap-3 text-sm"
          >
            <button
              disabled={page === 0 || loading}
              className="rounded-lg border px-3 py-2 disabled:opacity-40"
              onClick={() => setPage((v) => v - 1)}
            >
              Anterior
            </button>
            <span>
              Página {page + 1} de {Math.max(1, Math.ceil(total / 25))}
            </span>
            <button
              disabled={(page + 1) * 25 >= total || loading}
              className="rounded-lg border px-3 py-2 disabled:opacity-40"
              onClick={() => setPage((v) => v + 1)}
            >
              Siguiente
            </button>
          </nav>
        </>
      )}
    </section>
  );
}
