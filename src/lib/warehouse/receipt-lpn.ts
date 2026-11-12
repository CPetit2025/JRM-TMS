import type { SupabaseClient } from "@supabase/supabase-js";
import type { PackageLabelData } from "./package-label";
import type { LpnPackage } from "./packing-list";

/** LPN de recepción: varias líneas validadas del mismo cliente y OT en un solo bulto físico (wh_lpn_detail). */
export type ReceiptLpn = {
  id: string; lpn_code: string; origin: "PICKING" | "RECEPCION" | "INVENTARIO"; status: string; task_id: string | null; print_count: number;
  package_count: number; quantity: number; weight_kg: number; created_at: string; created_by_name: string | null;
  packages: (LpnPackage & { receipt_key: string; warehouse: string; date: string })[];
};

const uniq = (values: (string | null | undefined)[]) => [...new Set(values.filter((v): v is string => !!v))];

/** Etiqueta del LPN con la plantilla del bulto: identifica el LPN, su contenido (líneas) y los totales. */
export function lpnLabelData(lpn: ReceiptLpn, customer: string | null): PackageLabelData {
  const units = uniq(lpn.packages.map(p => p.unit));
  const first = lpn.packages[0];
  const anyWeight = lpn.packages.some(p => p.weight_kg != null);
  return {
    package_code: lpn.lpn_code,
    source_document_no: uniq(lpn.packages.map(p => p.document)).join(", "),
    source_lot: uniq(lpn.packages.map(p => p.lot)).join(", "),
    source_product_code: "LPN",
    description: `Contenido: ${lpn.packages.length} líneas · ${uniq(lpn.packages.map(p => p.product_code)).length} producto(s) · ver hoja de contenido`,
    quantity: Number(lpn.quantity),
    weight_kg: anyWeight ? Number(lpn.weight_kg) : null,
    unit: units.length === 1 ? units[0] : "und",
    sequence_no: 1,
    sequence_total: 1,
    source_warehouse: first?.warehouse || "",
    source_date: first?.date || "",
    contract_code: first?.contract_code || null,
    customer_name: customer || "Cliente por registrar",
    reception_responsible_name: lpn.created_by_name,
    content_lines: lpn.packages.length,
  };
}

/** LPN por su código o el de uno de sus paquetes, con el cliente de la etiqueta (mismo cálculo que el bulto). */
export async function loadReceiptLpn(db: SupabaseClient, code: string): Promise<{ lpn: ReceiptLpn; label: PackageLabelData } | null> {
  const { data, error } = await db.rpc("wh_lpn_detail", { p_code: code });
  if (error) throw error;
  const lpn = data as ReceiptLpn | null;
  if (!lpn) return null;
  const keys = uniq(lpn.packages.map(p => p.receipt_key)).slice(0, 100);
  let customer: string | null = null;
  if (keys.length && lpn.origin === "RECEPCION") {
    const { data: names, error: customerError } = await db.rpc("wh_receipt_control_customers", { p_source_movement_keys: keys });
    if (customerError) throw customerError;
    customer = ((names || []) as { customer_name: string | null }[]).find(n => n.customer_name)?.customer_name || null;
  }
  return { lpn, label: lpnLabelData(lpn, customer) };
}
