const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
// Única fuente para iconos y splash. Sustituir este PNG por el master vectorial
// corporativo cuando esté disponible; los destinos se regeneran sin estirar.
const master = path.join(root, 'public', 'jrm-logo-v2.png');
const androidRes = path.join(root, 'android', 'app', 'src', 'main', 'res');

async function markOnCanvas(width, height, fraction, background = '#ffffff') {
  const size = Math.round(Math.min(width, height) * fraction);
  const mark = await sharp(master).resize(size, size, {
    fit: 'contain', kernel: 'lanczos3', background: '#00000000',
  }).png().toBuffer();
  return sharp({ create: { width, height, channels: 4, background } })
    .composite([{ input: mark, gravity: 'centre' }]).png().toBuffer();
}

function makeIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6 + count * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  let offset = header.length;
  entries.forEach(({ size, image }, index) => {
    const start = 6 + index * 16;
    header[start] = size === 256 ? 0 : size;
    header[start + 1] = size === 256 ? 0 : size;
    header[start + 2] = 0;
    header[start + 3] = 0;
    header.writeUInt16LE(1, start + 4);
    header.writeUInt16LE(32, start + 6);
    header.writeUInt32LE(image.length, start + 8);
    header.writeUInt32LE(offset, start + 12);
    offset += image.length;
  });
  return Buffer.concat([header, ...entries.map(entry => entry.image)]);
}

async function write(file, buffer) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, buffer);
}

async function main() {
  const png = size => markOnCanvas(size, size, 0.72);
  for (const size of [192, 512]) {
    await write(path.join(root, 'public', `icon-${size}.png`), await png(size));
  }
  await write(path.join(root, 'src', 'app', 'icon.png'), await png(512));
  await write(path.join(root, 'src', 'app', 'apple-icon.png'), await png(180));
  const icoEntries = [];
  for (const size of [16, 32, 48, 256]) icoEntries.push({ size, image: await png(size) });
  const ico = makeIco(icoEntries);
  await write(path.join(root, 'src', 'app', 'favicon.ico'), ico);
  await write(path.join(root, 'public', 'jrm-tms.ico'), ico);

  const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  for (const [density, size] of Object.entries(densities)) {
    const folder = path.join(androidRes, `mipmap-${density}`);
    await write(path.join(folder, 'ic_launcher.png'), await png(size));
    await write(path.join(folder, 'ic_launcher_round.png'), await png(size));
    await write(path.join(folder, 'ic_launcher_foreground.png'),
      await markOnCanvas(Math.round(size * 2.25), Math.round(size * 2.25), 0.58, '#00000000'));
  }

  const splashDirs = ['drawable', 'drawable-land-mdpi', 'drawable-land-hdpi',
    'drawable-land-xhdpi', 'drawable-land-xxhdpi', 'drawable-land-xxxhdpi',
    'drawable-port-mdpi', 'drawable-port-hdpi', 'drawable-port-xhdpi',
    'drawable-port-xxhdpi', 'drawable-port-xxxhdpi'];
  for (const dir of splashDirs) {
    const file = path.join(androidRes, dir, 'splash.png');
    const meta = await sharp(file).metadata();
    await write(file, await markOnCanvas(meta.width, meta.height, 0.25));
  }
  console.log('Iconos JRM generados desde public/jrm-logo-v2.png');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
