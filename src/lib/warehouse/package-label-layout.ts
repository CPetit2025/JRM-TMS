/** La cuadrícula llena el papel; logo y tipografía conservan sus proporciones. */
export function packageLabelLayout(format: { width_mm: number; height_mm: number }) {
  const { width_mm: width, height_mm: height } = format;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 15 || height < 10 || width > 450 || height > 650)
    throw new Error('Medida de papel no válida.');
  const scale = Math.min(width / 152.4, height / 101.6);
  return { width: width * 96 / 25.4 / scale, height: height * 96 / 25.4 / scale, scale };
}
