import type { SupabaseClient } from "@supabase/supabase-js";
import { packageLabelData, type PackageLabelData } from "./package-label";
/** Recupera los datos originales, también al reimprimir un rótulo desde inventario. */
export async function loadPackageLabel(
  db: SupabaseClient,
  code: string,
): Promise<PackageLabelData> {
  const { data, error } = await db
    .from("wh_packages")
    .select("*")
    .eq("package_code", code)
    .single();
  if (error) throw error;
  return hydratePackageLabel(db, data);
}
export async function hydratePackageLabel(
  db: SupabaseClient,
  data: Parameters<typeof packageLabelData>[0],
): Promise<PackageLabelData> {
  let customer = data.customer_name as string | null | undefined;
  if (data.source_movement_key) {
    const result = await db.rpc("wh_receipt_control_customers", {
      p_source_movement_keys: [data.source_movement_key],
    });
    if (result.error) throw result.error;
    customer =
      result.data?.find(
        (r: { source_movement_key: string }) =>
          r.source_movement_key === data.source_movement_key,
      )?.customer_name || customer;
  }
  return packageLabelData(data, customer);
}
export async function loadPackageLabels(
  db: SupabaseClient,
  codes: string[],
): Promise<PackageLabelData[]> {
  if (!codes.length) return [];
  const { data, error } = await db
    .from("wh_packages")
    .select("*")
    .in("package_code", codes);
  if (error) throw error;
  const keys = [
    ...new Set(
      (data || []).map((row) => row.source_movement_key).filter(Boolean),
    ),
  ];
  let customers: {
    source_movement_key: string;
    customer_name: string | null;
  }[] = [];
  if (keys.length) {
    const result = await db.rpc("wh_receipt_control_customers", {
      p_source_movement_keys: keys,
    });
    if (result.error) throw result.error;
    customers = result.data || [];
  }
  return codes.map((code) => {
    const row = data?.find((row) => row.package_code === code);
    if (!row) throw new Error(`No se pudo recuperar el bulto original ${code}`);
    return packageLabelData(
      row,
      customers.find((c) => c.source_movement_key === row.source_movement_key)
        ?.customer_name,
    );
  });
}
