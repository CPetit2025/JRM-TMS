const { spawnSync } = require('node:child_process');
const { copyFileSync, readFileSync } = require('node:fs');
const path = require('node:path');

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
const syncedConfig = JSON.parse(
  readFileSync(path.join(android, 'app', 'src', 'main', 'assets', 'capacitor.config.json'), 'utf8')
);
if (!syncedConfig.server?.url?.startsWith('https://') || !syncedConfig.server?.appStartPath) {
  throw new Error('La configuración Android debe incluir server.url HTTPS y server.appStartPath.');
}
run(gradle, ['assembleDebug'], { cwd: android, shell: process.platform === 'win32' });

const builtApk = path.join(android, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const downloadApk = path.join(root, 'public', 'app-release.apk');
copyFileSync(builtApk, downloadApk);
console.log(`APK actualizado: ${downloadApk}`);
