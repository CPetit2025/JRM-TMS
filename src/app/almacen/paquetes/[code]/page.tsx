"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { ArrowLeft, PackageCheck } from "lucide-react";
import { usePermissions } from "@/hooks/usePermissions";
import { PackageLabelPreview } from "@/components/warehouse/PackageLabel";
import { printPackageLabels } from "@/components/warehouse/print-package-labels";
import { hydratePackageLabel } from "@/lib/warehouse/load-package-label";
import type { PackageLabelData } from "@/lib/warehouse/package-label";
import { useLabelFormat } from "@/lib/warehouse/label-format";

type PackageRow = {
  package_code: string;
  status: string;
  quantity_mismatch: boolean;
  source_product_code: string;
  description: string;
  source_document_no: string;
  source_lot: string | null;
  sequence_no: number;
  sequence_total: number;
  quantity: number;
  unit: string | null;
  task_id: string | null;
  lpn_id: string | null;
};
type ScanEvent = {
  event_type: string;
  occurred_at: string;
  payload: Record<string, unknown> | null;
  operator_id: string | null;
};
export default function PackageDetail({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = use(params);
  const labelFormat = useLabelFormat("PAQUETE");
  const { hasAccess } = usePermissions();
  const [label, setLabel] = useState<PackageLabelData | null>(null);
  const [row, setRow] = useState<PackageRow | null>(null);
  const [events, setEvents] = useState<ScanEvent[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const db = createClient();
    const [{ data: p, error: e }, { data: s }] = await Promise.all([
      db
        .from("wh_packages")
        .select("*")
        .eq("package_code", decodeURIComponent(code))
        .maybeSingle(),
      db
        .from("wh_scan_events")
        .select("event_type,occurred_at,payload,operator_id")
        .eq("scanned_code", decodeURIComponent(code))
        .order("occurred_at", { ascending: false })
        .limit(100),
    ]);
    if (e) setError(e.message);
    else {
      setRow(p as PackageRow | null);
      setLabel(null);
      if (p)
        try {
          setLabel(await hydratePackageLabel(db, p));
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
    }
    setEvents((s || []) as ScanEvent[]);
  }, [code]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);
  const reprint = async () => {
    if (!row || !label || busy) return;
    const reason = window.prompt("Motivo de reimpresión de esta etiqueta:");
    if (!reason?.trim()) return;
    setBusy(true);
    const { error } = await createClient().rpc("wh_reprint_label", {
      p_package_code: row.package_code,
      p_reason: reason,
    });
    if (error) setError(error.message);
    else {
      try {
        await printPackageLabels([label], labelFormat);
        setMessage("Reimpresión registrada con motivo.");
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    setBusy(false);
  };
  const voidPackage = async () => {
    if (!row) return;
    const reason = window.prompt("Motivo de anulación del paquete:");
    if (!reason?.trim()) return;
    setBusy(true);
    const { error } = await createClient().rpc("wh_void_package", {
      p_package_code: row.package_code,
      p_reason: reason,
    });
    if (error) setError(error.message);
    else {
      setMessage("Etiqueta anulada; el registro y las lecturas se conservan.");
      await load();
    }
    setBusy(false);
  };
  return (
    <div className="w-full space-y-5">
      <Link
        href="/almacen/paquetes"
        className="inline-flex items-center gap-2 text-sm font-semibold text-blue-800"
      >
        <ArrowLeft size={16} />
        Paquetes
      </Link>
      {error && (
        <p className="rounded bg-rose-50 p-3 text-sm text-rose-800">{error}</p>
      )}
      {message && (
        <p
          role="status"
          className="rounded bg-emerald-50 p-3 text-sm text-emerald-800"
        >
          {message}
        </p>
      )}
      {!row && !error ? (
        <p className="p-8 text-center text-slate-500">Buscando…</p>
      ) : row ? (
        <>
          <header className="rounded-xl border bg-white p-5">
            <div className="flex items-start justify-between gap-4">
              <PackageCheck className="text-blue-700" />
              {(hasAccess("almacen-etiquetado") ||
                hasAccess("almacen-supervisor")) &&
                row.status !== "VOID" && (
                  <div className="flex gap-2">
                    <button
                      disabled={busy || !label}
                      onClick={() => void reprint()}
                      className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold"
                    >
                      Reimprimir
                    </button>
                    {hasAccess("almacen-supervisor") && (
                      <button
                        disabled={busy}
                        onClick={() => void voidPackage()}
                        className="rounded-lg border border-rose-300 px-3 py-2 text-xs font-bold text-rose-800"
                      >
                        Anular
                      </button>
                    )}
                  </div>
                )}
            </div>
            <p className="mt-3 text-xs font-bold uppercase tracking-widest text-blue-700">
              Etiqueta de paquete
            </p>
            <h1 className="mt-1 text-3xl font-black text-[#002855]">
              {row.package_code}
            </h1>
            <span className="mt-3 inline-block rounded-full bg-blue-100 px-3 py-1 text-xs font-bold text-blue-900">
              {row.status}
            </span>
            {row.quantity_mismatch && (
              <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm font-semibold text-amber-900">
                La carga actual del ERP cambió la cantidad o el número de
                paquetes. La etiqueta original se conserva; supervise la
                diferencia antes de volver a imprimir o despachar.
              </p>
            )}
            <div className="mt-5 max-w-2xl">
              {label ? (
                <PackageLabelPreview label={label} format={labelFormat} />
              ) : (
                <p className="text-sm text-slate-500">
                  Cargando etiqueta original…
                </p>
              )}
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {[
                ["Documento ERP", row.source_document_no],
                ["Lote", row.source_lot || "—"],
                ["Producto", row.source_product_code],
                ["Cantidad", `${row.quantity} ${row.unit || ""}`],
                ["Task", row.task_id || "Sin asignar"],
                ["LPN", row.lpn_id || "Sin LPN"],
              ].map(([k, v]) => (
                <div key={k} className="rounded-lg bg-slate-50 p-3">
                  <small className="text-slate-500">{k}</small>
                  <b className="mt-1 block break-all text-sm">{v}</b>
                </div>
              ))}
            </div>
          </header>
          <section className="rounded-xl border bg-white p-5">
            <h2 className="font-bold text-[#002855]">Historial de lecturas</h2>
            {events.length ? (
              events.map((e, i) => (
                <div
                  key={i}
                  className="flex justify-between gap-3 border-t py-3 text-sm"
                >
                  <b>{e.event_type}</b>
                  <span className="text-slate-500">
                    {new Date(e.occurred_at).toLocaleString("es-PE")}
                  </span>
                </div>
              ))
            ) : (
              <p className="mt-3 text-sm text-slate-500">
                Sin lecturas registradas.
              </p>
            )}
          </section>
        </>
      ) : (
        <p className="rounded-xl border bg-white p-8 text-center">
          No existe el código solicitado.
        </p>
      )}
    </div>
  );
}
