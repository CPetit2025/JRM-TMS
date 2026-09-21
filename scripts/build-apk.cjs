const { spawnSync } = require('node:child_process');
const { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');

const required = ['JRM_KEYSTORE_PATH', 'JRM_KEYSTORE_PASSWORD', 'JRM_KEY_ALIAS', 'JRM_KEY_PASSWORD'];
const missing = required.filter(name => !process.env[name]);
if (missing.length) throw new Error(`Falta configurar la firma release: ${missing.join(', ')}`);
if (!existsSync(process.env.JRM_KEYSTORE_PATH)) throw new Error('No se encontró el keystore release.');

const root = path.resolve(__dirname, '..');
const android = path.join(root, 'android');
const capacitor = path.join(root, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor');
const gradle = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    shell: options.shell ?? false,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [capacitor, 'sync', 'android']);
const syncedConfig = JSON.parse(readFileSync(
  path.join(android, 'app', 'src', 'main', 'assets', 'capacitor.config.json'), 'utf8'));
if (!syncedConfig.server?.url?.startsWith('https://') || !syncedConfig.server?.appStartPath) {
  throw new Error('La configuración Android debe incluir server.url HTTPS y server.appStartPath.');
}
run(gradle, ['assembleRelease'], { cwd: android, shell: process.platform === 'win32' });

const version = process.env.JRM_ANDROID_VERSION_NAME || '1.0.3';
const build = process.env.JRM_ANDROID_VERSION_CODE || '4';
const source = path.join(android, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const outputDir = path.join(root, 'artifacts', 'android');
mkdirSync(outputDir, { recursive: true });
const target = path.join(outputDir, `jrm-tms-${version}-${build}.apk`);
copyFileSync(source, target);
const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex');
writeFileSync(`${target}.sha256`, `${sha256}  ${path.basename(target)}\n`);
console.log(`APK release: ${target}\nSHA-256: ${sha256}`);
console.log('Publica este artefacto inmutable y registra URL, versión, build y SHA-256 en app_versions.');
