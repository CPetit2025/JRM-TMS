import type { SupabaseClient } from "@supabase/supabase-js";
import { packageLabelData, type PackageLabelData } from "./package-label";
type Source = Parameters<typeof packageLabelData>[0];
/** Nombre del creador original; el servidor comprueba acceso al bulto y su sede. */
async function loadResponsibles(db: SupabaseClient, codes: string[]) {
  const names = new Map<string, string | null>();
  for (let offset = 0; offset < codes.length; offset += 100) {
    const { data, error } = await db.rpc("wh_package_label_responsibles", { p_package_codes: codes.slice(offset, offset + 100) });
    if (error) throw error;
    for (const row of (data || []) as { package_code: string; responsible_name: string | null }[]) names.set(row.package_code, row.responsible_name);
  }
  return names;
}
async function hydrateLabels(db: SupabaseClient, rows: Source[]): Promise<PackageLabelData[]> {
  if (!rows.length) return [];
  const keys = [...new Set(rows.map(row => row.source_movement_key).filter(Boolean))];
  const [customers, responsibles] = await Promise.all([
    keys.length ? db.rpc("wh_receipt_control_customers", { p_source_movement_keys: keys }) : Promise.resolve({ data: [], error: null }),
    loadResponsibles(db, rows.map(row => row.package_code)),
  ]);
  if (customers.error) throw customers.error;
  const names = (customers.data || []) as { source_movement_key: string; customer_name: string | null }[];
  return rows.map(row => packageLabelData(row, names.find(c => c.source_movement_key === row.source_movement_key)?.customer_name, responsibles.get(row.package_code)));
}
/** Recupera los datos originales, también al reimprimir desde inventario. */
export async function loadPackageLabel(db: SupabaseClient, code: string): Promise<PackageLabelData> {
  const { data, error } = await db.from("wh_packages").select("*").eq("package_code", code).single();
  if (error) throw error;
  return hydratePackageLabel(db, data);
}
export async function hydratePackageLabel(db: SupabaseClient, data: Source): Promise<PackageLabelData> {
  return (await hydrateLabels(db, [data]))[0];
}
export async function loadPackageLabels(db: SupabaseClient, codes: string[]): Promise<PackageLabelData[]> {
  if (!codes.length) return [];
  const { data, error } = await db.from("wh_packages").select("*").in("package_code", codes);
  if (error) throw error;
  const rows = codes.map(code => {
    const row = data?.find(row => row.package_code === code);
    if (!row) throw new Error(`No se pudo recuperar el bulto original ${code}`);
    return row;
  });
  return hydrateLabels(db, rows);
}
