#!/usr/bin/env node
/**
 * android-release.mjs - the signed Android app (1.5.8).
 *
 *   npm run android:release             build, sign, check, copy to desktop/dist
 *
 * The release key lives outside the repository, next to the update key:
 *   ~/.lamplit-release/android-release.jks          (PKCS12, alias "lamplit")
 *   ~/.lamplit-release/android-release.properties   its password
 * The first run makes both, with a random password that is never printed.
 * Back the folder up: an app signed with another key cannot update this one.
 *
 * Needs JAVA_HOME (keytool) and ANDROID_HOME (apksigner); www is synced first
 * (npm --prefix mobile run sync).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY_DIR = process.env.LAMPLIT_RELEASE_DIR || path.join(os.homedir(), '.lamplit-release');
const JKS = path.join(KEY_DIR, 'android-release.jks');
const PROPS = path.join(KEY_DIR, 'android-release.properties');
const ALIAS = 'lamplit';
const win = process.platform === 'win32';
const javaHome = process.env.JAVA_HOME || '';
const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
const fail = (msg) => { console.error(`[android-release] ${msg}`); process.exit(1); };
const run = (file, args, opts = {}) => {
  const r = spawnSync(file, args, { stdio: opts.quiet ? 'pipe' : 'inherit', shell: win && /\.(bat|cmd)$/i.test(file), ...opts });
  if (r.status !== 0) fail(`${path.basename(file)} failed (exit ${r.status})${opts.quiet ? `: ${String(r.stderr || '').trim().split('\n').pop()}` : ''}`);
  return r;
};

if (!javaHome) fail('set JAVA_HOME to a JDK (keytool and gradle need it)');
if (!androidHome) fail('set ANDROID_HOME to the Android SDK (apksigner)');

// The key: made once.
if (!fs.existsSync(JKS)) {
  fs.mkdirSync(KEY_DIR, { recursive: true });
  const password = crypto.randomBytes(24).toString('base64url');
  run(path.join(javaHome, 'bin', win ? 'keytool.exe' : 'keytool'), [
    '-genkeypair', '-keystore', JKS, '-storetype', 'PKCS12', '-alias', ALIAS, '-keyalg', 'RSA', '-keysize', '4096',
    '-validity', '36500', '-dname', 'CN=Lamplit, O=Lamplit', '-storepass', password, '-keypass', password,
  ], { quiet: true });
  fs.writeFileSync(PROPS, `password=${password}\n`, { mode: 0o600 });
  console.log(`[android-release] made the release key in ${KEY_DIR} - back this folder up`);
}
const password = (fs.readFileSync(PROPS, 'utf8').match(/^password=(.+)$/m) || [])[1];
if (!password) fail(`no password in ${PROPS}`);

// Build: android/app/build.gradle signs when these are set.
const androidDir = path.join(REPO, 'mobile', 'android');
run(path.join(androidDir, win ? 'gradlew.bat' : 'gradlew'), ['assembleRelease', '-q'], {
  cwd: androidDir,
  env: { ...process.env, DESK_KEYSTORE: JKS, DESK_KEY_ALIAS: ALIAS, DESK_KEY_PASSWORD: password, DESK_STORE_PASSWORD: password },
});
const apk = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
if (!fs.existsSync(apk)) fail('no app-release.apk: was it signed? (app-release-unsigned.apk means the key was not picked up)');

// Check the signature with the SDK's apksigner (newest build-tools).
const tools = path.join(androidHome, 'build-tools');
const newest = fs.readdirSync(tools).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
const apksigner = path.join(tools, newest, win ? 'apksigner.bat' : 'apksigner');
const verified = run(apksigner, ['verify', '--print-certs', apk], { quiet: true });
const cert = (String(verified.stdout).match(/SHA-256 digest:\s*([0-9a-f]+)/i) || [])[1];
if (!cert) fail('apksigner did not report a certificate');

const version = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const out = path.join(REPO, 'desktop', 'dist', `Lamplit-Android-${version}.apk`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.copyFileSync(apk, out);
console.log(`[android-release] ${path.relative(REPO, out)} signed (certificate SHA-256 ${cert})`);
