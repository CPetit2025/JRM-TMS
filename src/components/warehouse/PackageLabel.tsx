"use client";
/* eslint-disable @next/next/no-img-element -- El mismo logo original se rasteriza y se imprime sin optimización de tamaño. */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { QrCode } from "./QrCode";
import { Code128Barcode } from "./Code128Barcode";
import { bultoNumber, identifierFontSize, type PackageLabelData } from "@/lib/warehouse/package-label";
import type { LabelFormat } from "@/lib/warehouse/label-format";
import { packageLabelLayout } from "@/lib/warehouse/package-label-layout";
import "./package-label.css";
/** Única plantilla: recepción, vista previa, inventario, detalle y reimpresión. */
export function PackageLabel({ label, format = { width_mm: 152.4, height_mm: 101.6 } }: { label: PackageLabelData; format?: Pick<LabelFormat, "width_mm" | "height_mm"> }) {
  const layout = packageLabelLayout(format);
  return (
    <article
      className="wh-package-label"
      data-package-code={label.package_code}
      style={{ "--wh-label-width": `${layout.width}px`, "--wh-label-height": `${layout.height}px` } as CSSProperties}
    >
      <div className="wh-package-head">
        <div className="wh-package-logo">
          <img
            src="/logo-jrm.png"
            alt="JRM Soluciones Integrales de Almacenamiento"
          />
        </div>
        <div className="wh-package-meta">
          <div>
            <b>Cliente:</b> <strong>{label.customer_name}</strong>
          </div>
          <div>
            <b>OT:</b> <strong>{label.contract_code || "—"}</strong>
          </div>
          <div><b>Bodega:</b> <strong>{label.source_warehouse || "—"}</strong></div>
        </div>
      </div>
      <div className="wh-package-identifiers">
        {/* SKU y lote completos en una línea: solo se reduce la letra si juntos no caben. */}
        <b className="wh-package-sku" style={{ fontSize: identifierFontSize(label.source_product_code, `Lote: ${label.source_lot || "—"}`) }}>{label.source_product_code}</b>
        <b className="wh-package-lot" style={{ fontSize: identifierFontSize(label.source_product_code, `Lote: ${label.source_lot || "—"}`) }}>Lote: {label.source_lot || "—"}</b>
      </div>
      <div className="wh-package-description">{label.description}</div>
      <div className="wh-package-codes">
        <Code128Barcode
          value={label.package_code}
          height={84}
          className="wh-package-barcode"
        />
        <QrCode value={label.package_code} className="wh-package-qr" />
      </div>
      <b className="wh-package-code">{label.package_code}</b>
      <div className="wh-package-footer">
        <div className="wh-package-responsible"><b>Responsable de recepción:</b> {label.reception_responsible_name || "No registrado"}</div>
        <div className="wh-package-document">
          <div>
            <b>IPT:</b> {label.source_document_no || "—"}
          </div>
          <div>
            <b>Fecha:</b> {label.source_date || "—"}
          </div>
        </div>
        <div className="wh-package-totals">
          <b>
            {label.quantity} {label.unit || ""}
          </b>
          <strong>
            ·{" "}
            {label.weight_kg === null
              ? "Peso por registrar"
              : label.weight_kg + " kg"}
          </strong>
        </div>
        <div className="wh-package-sequence">
          {bultoNumber(label.package_code) ? <>Bulto <b className="wh-package-bulto">{bultoNumber(label.package_code)}</b></> : `${label.sequence_no}/${label.sequence_total}`}
        </div>
      </div>
    </article>
  );
}
/** La vista previa reduce la misma etiqueta completa, sin alterar tipografía ni distribución. */
export function PackageLabelPreview({
  label,
  format,
}: {
  label: PackageLabelData;
  format: Pick<LabelFormat, "width_mm" | "height_mm">;
}) {
  const ref = useRef<HTMLDivElement>(null),
    [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) =>
      setWidth(entries[0].contentRect.width),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const layout = packageLabelLayout(format);
  const scale = width ? width / layout.width : 0;
  return (
    <div
      ref={ref}
      className="wh-package-preview"
      style={{ aspectRatio: `${format.width_mm}/${format.height_mm}` }}
    >
      <div
        style={{
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          width: layout.width,
          height: layout.height,
        }}
      >
        <PackageLabel label={label} format={format} />
      </div>
    </div>
  );
}
