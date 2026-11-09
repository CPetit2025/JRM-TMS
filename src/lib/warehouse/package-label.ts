/** Datos del bulto original. Ninguna reimpresión genera ni sustituye su código. */
export type PackageLabelData = {
  package_code: string;
  source_document_no: string;
  source_lot: string;
  source_product_code: string;
  description: string;
  quantity: number;
  weight_kg: number | null;
  unit: string | null;
  sequence_no: number;
  sequence_total: number;
  source_warehouse: string;
  source_date: string;
  contract_code: string | null;
  customer_name: string;
};
type LabelSource = { package_code: string; [key: string]: unknown };
const text = (v: unknown) => (v == null ? "" : String(v));
export function packageLabelData(
  row: LabelSource,
  customer?: string | null,
): PackageLabelData {
  if (!row.package_code)
    throw new Error(
      "No se puede imprimir una etiqueta sin el código del bulto original.",
    );
  return {
    package_code: row.package_code,
    source_document_no: text(row.source_document_no),
    source_lot: text(row.source_lot),
    source_product_code: text(row.source_product_code),
    description: text(row.description),
    quantity: Number(row.quantity),
    weight_kg: row.weight_kg == null ? null : Number(row.weight_kg),
    unit: row.unit == null ? null : text(row.unit),
    sequence_no: Number(row.sequence_no) || 0,
    sequence_total: Number(row.sequence_total) || 0,
    source_warehouse: text(row.source_warehouse),
    source_date: text(row.source_date),
    contract_code: text(row.contract_code || row.source_contract_code) || null,
    customer_name:
      text(customer || row.customer_name) || "Cliente por registrar",
  };
}
