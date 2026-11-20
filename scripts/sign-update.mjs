#!/usr/bin/env node
/**
 * sign-update.mjs - the signed update package for the desktop build (1.5.5).
 *
 * Machines replace their code only with a package signed by Lamplit's release
 * key (SEC-06 step 2). This builds the package from the same files the
 * installer ships to resources/server (src, public, config, skills, hub,
 * ssh2's runtime, package.json), signs it with the private key - which never
 * enters the repository - and writes
 *
 *   desktop/build/update/lamplit-update.tar.gz
 *   desktop/build/update/lamplit-update.json   {version, sha256, signature}
 *   desktop/build/update/relay-update.json     the relay's own signature (1.5.47)
 *
 * electron-builder copies that folder to resources/server/update; the desktop
 * app pushes exactly these bytes to the other machines.
 *
 * Key: LAMPLIT_UPDATE_KEY, else ~/.lamplit-release/update-ed25519.pem.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packApp, cleanupPack } from '../src/bundle.mjs';
import { verifyUpdate } from '../src/selfupdate.mjs';
import { makeRelayManifest } from '../src/relayupdate.mjs';
import { verifyRelayUpdate } from '../hub/relay/relay.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = process.env.LAMPLIT_UPDATE_KEY || path.join(os.homedir(), '.lamplit-release', 'update-ed25519.pem');
const STAGE = path.join(REPO, 'desktop', 'build', 'update-stage');
const OUT = path.join(REPO, 'desktop', 'build', 'update');
// The same runtime tree electron-builder.yml ships next to the server.
const MODULES = ['ssh2', 'asn1', 'bcrypt-pbkdf', 'tweetnacl', 'safer-buffer'];

if (!fs.existsSync(KEY)) {
  console.error(`[sign-update] no release key at ${KEY}. Set LAMPLIT_UPDATE_KEY to the Ed25519 private key (PEM). Without it the machines would refuse the update.`);
  process.exit(1);
}

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
const copy = (from, to, filter) => fs.cpSync(path.join(REPO, from), path.join(STAGE, to), { recursive: true, filter });
copy('src', 'src', (p) => fs.statSync(p).isDirectory() || /\.(mjs|cjs)$|LICENSE$/.test(p));
for (const dir of ['public', 'config', 'skills', 'hub']) copy(dir, dir);
for (const m of MODULES) copy(path.join('node_modules', m), path.join('node_modules', m));
// The relay's own signature (1.5.47): relays update themselves with relay.mjs
// only when this key signed "lamplit-relay-update v1 / version / sha256" for it.
// It rides along in the package (hub/relay/relay-update.json) and in the
// installer (server/update/relay-update.json); the relay checks it itself.
const appVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const relayBytes = fs.readFileSync(path.join(STAGE, 'hub', 'relay', 'relay.mjs'));
const relayManifest = makeRelayManifest({ version: appVersion, bytes: relayBytes, privateKey: fs.readFileSync(KEY) });
if (!verifyRelayUpdate(relayManifest, relayBytes)) {
  console.error('[sign-update] the key does not match the public key built into hub/relay/relay.mjs (RELAY_UPDATE_KEYS): relays would refuse to update.');
  process.exit(1);
}
fs.writeFileSync(path.join(STAGE, 'hub', 'relay', 'relay-update.json'), `${JSON.stringify(relayManifest, null, 2)}\n`);
// The build (1.5.19): a fingerprint of the code, so a rebuild under the same
// version still reaches the other machines (11-17: the cloud machine kept the
// first 1.5.17 build, as updates compared version numbers only).
const fingerprint = crypto.createHash('sha256');
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else fingerprint.update(path.relative(STAGE, p).replace(/\\/g, '/')).update(fs.readFileSync(p));
  }
};
for (const dir of ['src', 'public', 'config', 'skills', 'hub']) walk(path.join(STAGE, dir));
const build = fingerprint.digest('hex').slice(0, 12);
const pkgJson = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(STAGE, 'package.json'), `${JSON.stringify({ ...pkgJson, build }, null, 2)}\n`);

const packed = await packApp({ root: STAGE, outDir: os.tmpdir() });
const bytes = fs.readFileSync(packed.file);
cleanupPack(packed.file);
fs.rmSync(STAGE, { recursive: true, force: true });

const signature = crypto.sign(null, bytes, crypto.createPrivateKey(fs.readFileSync(KEY))).toString('base64');
if (!verifyUpdate(bytes, signature)) {
  console.error('[sign-update] the key does not match the public key built into src/selfupdate.mjs (UPDATE_PUBLIC_KEYS): the machines would refuse this package.');
  process.exit(1);
}
const version = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'lamplit-update.tar.gz'), bytes);
fs.writeFileSync(path.join(OUT, 'lamplit-update.json'), `${JSON.stringify({ version, build, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), signature }, null, 2)}\n`);
fs.writeFileSync(path.join(OUT, 'relay-update.json'), `${JSON.stringify(relayManifest, null, 2)}\n`);
console.log(`[sign-update] ${version} (build ${build}): ${Math.round(bytes.length / 1024)} KB signed`);
