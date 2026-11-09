/** Imagen térmica de la MISMA plantilla HTML. No existe una composición ZPL paralela. */
export function monochromeRaster(
  data: Uint8ClampedArray,
  width: number,
  height: number,
) {
  const bytesPerRow = Math.ceil(width / 8),
    bytes = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4,
        alpha = data[i + 3] / 255;
      const light =
        (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) * alpha +
        255 * (1 - alpha);
      if (light < 128) bytes[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x % 8);
    }
  return { bytes, bytesPerRow };
}
export function rasterZpl(
  data: Uint8ClampedArray,
  width: number,
  height: number,
) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    data.length !== width * height * 4
  )
    throw new Error("Imagen de etiqueta inválida");
  const { bytes, bytesPerRow } = monochromeRaster(data, width, height);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return `^XA^PW${width}^LL${height}^LH0,0^FO0,0^GFA,${bytes.length},${bytes.length},${bytesPerRow},${hex}^FS^XZ`;
}
