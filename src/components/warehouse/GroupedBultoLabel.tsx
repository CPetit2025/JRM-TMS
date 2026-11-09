"use client";
/* eslint-disable @next/next/no-img-element -- Mismo logo que la etiqueta de bulto, impreso sin optimizar. */
import type { CSSProperties } from "react";
import { Code128Barcode } from "./Code128Barcode";
import { bultoNumber } from "@/lib/warehouse/package-label";
import { packageLabelLayout } from "@/lib/warehouse/package-label-layout";
import "./package-label.css";

export type GroupedItem = { product_code: string; lot: string | null; quantity: number; unit: string | null };
const fmt = (n: number, d = 3) => Number(n || 0).toLocaleString("es-PE", { maximumFractionDigits: d });

/** Etiqueta del bulto agrupado: misma plantilla (cabecera, recuadros, código y pie) que la etiqueta de bulto. */
export function GroupedBultoLabel({ code, customer, contract, request, items, packages, weightKg, preparedBy, date }: {
  code: string; customer: string | null; contract: string | null; request: string | null; items: GroupedItem[];
  packages: number; weightKg: number; preparedBy: string | null; date: string | null;
}) {
  const layout = packageLabelLayout({ width_mm: 152.4, height_mm: 101.6 });
  const lots = [...new Set(items.map((i) => i.lot || "—"))];
  // Caben 4 filas: hasta 4 ítems se listan todos; con más, 3 ítems y una fila «+N más».
  const shown = items.length > 4 ? items.slice(0, 3) : items;
  return (
    <article className="wh-package-label" data-package-code={code}
      style={{ "--wh-label-width": `${layout.width}px`, "--wh-label-height": `${layout.height}px` } as CSSProperties}>
      <div className="wh-package-head">
        <div className="wh-package-logo"><img src="/logo-jrm.png" alt="JRM Soluciones Integrales de Almacenamiento" /></div>
        <div className="wh-package-meta">
          <div><b>Cliente:</b> <strong>{customer || "—"}</strong></div>
          <div><b>OT:</b> <strong>{contract || "—"}</strong></div>
          <div><b>Solicitud:</b> <strong>{request || "—"}</strong></div>
        </div>
      </div>
      <div className="wh-package-identifiers">
        <b className="wh-package-sku">BULTO AGRUPADO</b>
        <b className="wh-package-lot">{lots.length > 1 ? "Lotes" : "Lote"}: {lots.join(", ")}</b>
      </div>
      <div className="wh-grouped-wrap">
      <table className="wh-grouped-items">
        <tbody>
          {shown.map((i) => (
            <tr key={`${i.product_code}|${i.lot || ""}`}>
              <td>{i.product_code}</td>
              <td>{i.lot || "—"}</td>
              <td>{fmt(i.quantity)} {i.unit || ""}</td>
            </tr>
          ))}
          {items.length > shown.length && <tr><td colSpan={3}>+{items.length - shown.length} ítem(s) más · ver Packing List</td></tr>}
        </tbody>
      </table>
      </div>
      <Code128Barcode value={code} height={64} className="wh-package-barcode wh-grouped-barcode" />
      <b className="wh-package-code">{code}</b>
      <div className="wh-package-footer">
        <div className="wh-package-responsible"><b>Preparado por:</b> {preparedBy || "No registrado"}</div>
        <div className="wh-package-document"><div><b>Fecha:</b> {date ? new Date(date).toLocaleDateString("es-PE", { timeZone: "America/Lima" }) : "—"}</div></div>
        <div className="wh-package-totals"><b>{packages} paq.</b><strong>· {fmt(weightKg, 2)} kg</strong></div>
        <div className="wh-package-sequence">Bulto <b className="wh-package-bulto">{bultoNumber(code) || code}</b></div>
      </div>
    </article>
  );
}
