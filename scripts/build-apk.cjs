const { spawnSync } = require('node:child_process');
const { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');

const required = ['JRM_KEYSTORE_PATH', 'JRM_KEYSTORE_PASSWORD', 'JRM_KEY_ALIAS', 'JRM_KEY_PASSWORD'];
const missing = required.filter(name => !process.env[name]);
if (missing.length) throw new Error(`Falta configurar la firma release: ${missing.join(', ')}`);
if (!existsSync(process.env.JRM_KEYSTORE_PATH)) throw new Error('No se encontró el keystore release.');

const root = path.resolve(__dirname, '..');
const android = path.join(root, 'android');
const capacitor = path.join(root, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor');
const warehouse = process.argv.includes('--warehouse');
const flavor = warehouse ? 'almacen' : 'tms';
const appId = warehouse ? 'com.jrm.almacen' : 'com.jrm.tms';
const appPrefix = warehouse ? 'jrm-almacen' : 'jrm-tms';
const variantTask = `assemble${warehouse ? 'Almacen' : 'Tms'}Release`;
process.env.CAPACITOR_APP = warehouse ? 'warehouse' : 'tms';
if (warehouse) {
  process.env.JRM_ANDROID_VERSION_NAME = process.env.JRM_WAREHOUSE_VERSION_NAME || '1.0.0';
  process.env.JRM_ANDROID_VERSION_CODE = process.env.JRM_WAREHOUSE_VERSION_CODE || '1';
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    shell: options.shell ?? false,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Capacitor writes generated configuration here; Git omits this directory in fresh checkouts.
mkdirSync(path.join(android, 'app', 'src', 'main', 'assets'), { recursive: true });
run(process.execPath, [capacitor, 'sync', 'android']);
const syncedConfig = JSON.parse(readFileSync(
  path.join(android, 'app', 'src', 'main', 'assets', 'capacitor.config.json'), 'utf8'));
const expectedStartPath = warehouse ? '/almacen/login' : '/app/login';
if (syncedConfig.appId !== appId || !syncedConfig.server?.url?.startsWith('https://') || syncedConfig.server?.appStartPath !== expectedStartPath) {
  throw new Error(`La configuración Android debe ser ${appId}, server.url HTTPS y appStartPath ${expectedStartPath}.`);
}
if (process.platform === 'win32') {
  run('gradlew.bat', [variantTask], { cwd: android, shell: true });
} else {
  run('bash', ['./gradlew', variantTask], { cwd: android });
}

const version = process.env.JRM_ANDROID_VERSION_NAME || '1.0.5';
const build = process.env.JRM_ANDROID_VERSION_CODE || '6';
const outputDir = path.join(android, 'app', 'build', 'outputs', 'apk', flavor, 'release');
const metadata = JSON.parse(readFileSync(path.join(outputDir, 'output-metadata.json'), 'utf8'));
const actualSource = path.join(outputDir, metadata.elements?.[0]?.outputFile || '');
if (metadata.applicationId !== appId || metadata.variantName !== `${flavor}Release` ||
    metadata.elements?.[0]?.versionCode !== Number(build) || metadata.elements?.[0]?.versionName !== version) {
  throw new Error('La identidad o versión del APK release no coincide con la configuración.');
}
const localProperties = path.join(android, 'local.properties');
const sdkProperty = existsSync(localProperties)
  ? readFileSync(localProperties, 'utf8').match(/^sdk\.dir=(.+)$/m)?.[1]
  : null;
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT ||
  sdkProperty?.trim().replace(/\\:/g, ':').replace(/\\\\/g, '\\');
if (!sdk) throw new Error('No se encontró el Android SDK para verificar la firma.');
const buildTools = path.join(sdk, 'build-tools');
const toolsVersion = readdirSync(buildTools).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  .find(name => existsSync(path.join(buildTools, name, 'lib', 'apksigner.jar')));
if (!toolsVersion) throw new Error('No se encontró apksigner en Android SDK.');
const java = process.env.JAVA_HOME
  ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
  : 'java';
run(java, ['-jar', path.join(buildTools, toolsVersion, 'lib', 'apksigner.jar'),
  'verify', '--print-certs', actualSource]);
const artifactDir = path.join(root, 'artifacts', 'android');
mkdirSync(artifactDir, { recursive: true });
const target = path.join(artifactDir, `${appPrefix}-${version}-${build}.apk`);
copyFileSync(actualSource, target);
const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex');
writeFileSync(`${target}.sha256`, `${sha256}  ${path.basename(target)}\n`);
console.log(`APK release: ${target}\nSHA-256: ${sha256}`);
console.log('Publica este artefacto inmutable y registra URL, versión, build y SHA-256 en app_versions.');
