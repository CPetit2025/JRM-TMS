"use client";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { PackageLabel } from "./PackageLabel";
import {
  toDots,
  type LabelFormat,
} from "@/lib/warehouse/label-format";
import type { PackageLabelData } from "@/lib/warehouse/package-label";
import { labelPrintPage } from "@/lib/warehouse/label-print-layout";
import { packageLabelLayout } from "@/lib/warehouse/package-label-layout";
import { rasterZpl } from "@/lib/warehouse/label-raster";
type Device = {
  send: (
    data: string,
    ok: () => void,
    fail: (error?: { message?: string }) => void,
  ) => void;
};
type BrowserPrint = {
  getDefaultDevice: (
    kind: string,
    ok: (d: Device) => void,
    fail: () => void,
  ) => void;
};
export function validatePackageLabelPrint(format: LabelFormat) {
  if (format.ready === false) throw new Error("Espera a que cargue tu configuración de impresión.");
  packageLabelLayout(format);
  return labelPrintPage(format);
}
let active = false;
export async function printPackageLabels(
  labels: PackageLabelData[],
  format: LabelFormat,
): Promise<"ZEBRA" | "BROWSER"> {
  if (active) throw new Error("Hay una impresión de etiquetas en curso.");
  if (!labels.length) throw new Error("No hay etiquetas para imprimir.");
  const page = validatePackageLabelPrint(format);
  active = true;
  const host = document.createElement("div");
  host.id = "wh-label-print-root";
  document.body.append(host);
  const root = createRoot(host);
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clean = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("afterprint", clean);
    if (timer) clearTimeout(timer);
    root.unmount();
    host.remove();
    active = false;
  };
  try {
    const { scale, width: labelWidth, height: labelHeight } = packageLabelLayout(format);
    flushSync(() =>
      root.render(
        <>
          <style>{`@page{size:${page.width_mm}mm ${page.height_mm}mm;margin:0}`}</style>
          {labels.map((label) => (
            <div
              className="wh-package-sheet"
              key={label.package_code}
              style={{
                width: `${page.width_mm}mm`,
                height: `${page.height_mm}mm`,
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: `${page.margin_mm}mm`,
                  top: `${page.margin_mm}mm`,
                  transform: `scale(${scale})`,
                  transformOrigin: "top left",
                  width: labelWidth,
                  height: labelHeight,
                }}
              >
                <PackageLabel label={label} format={format} />
              </div>
            </div>
          ))}
        </>,
      ),
    );
    await document.fonts.ready;
    await Promise.all(
      Array.from(host.querySelectorAll("img")).map((img) => img.decode()),
    );
    const browser = (window as Window & { BrowserPrint?: BrowserPrint })
      .BrowserPrint;
    if (!format.paper && format.output !== "BROWSER" && browser?.getDefaultDevice) {
      const device = await new Promise<Device | null>((resolve) => {
        const timeout = setTimeout(() => resolve(null), 3000);
        browser.getDefaultDevice(
          "printer",
          (d) => {
            clearTimeout(timeout);
            resolve(d);
          },
          () => {
            clearTimeout(timeout);
            resolve(null);
          },
        );
      });
      if (device) {
        const { toCanvas } = await import("html-to-image");
        const width = toDots(format.width_mm, format.dpi),
          height = toDots(format.height_mm, format.dpi);
        // Una sola imagen en memoria cada vez: evita acumular canvases al imprimir un lote.
        for (const sheet of Array.from(
          host.querySelectorAll<HTMLElement>(".wh-package-sheet"),
        )) {
          const canvas = await toCanvas(sheet, {
            backgroundColor: "#ffffff",
            pixelRatio: 1,
            canvasWidth: width,
            canvasHeight: height,
            skipAutoScale: true,
          });
          const ctx = canvas.getContext("2d");
          if (!ctx)
            throw new Error("No se pudo preparar la imagen de impresión.");
          const zpl = rasterZpl(
            ctx.getImageData(0, 0, width, height).data,
            width,
            height,
          );
          await new Promise<void>((resolve, reject) =>
            device.send(zpl, resolve, (e) =>
              reject(
                new Error(
                  e?.message || "No se pudo enviar la etiqueta a Zebra.",
                ),
              ),
            ),
          );
        }
        clean();
        return "ZEBRA";
      }
    }
    window.addEventListener("afterprint", clean, { once: true });
    timer = setTimeout(clean, 120000);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    window.print();
    return "BROWSER";
  } catch (e) {
    clean();
    throw e;
  }
}
