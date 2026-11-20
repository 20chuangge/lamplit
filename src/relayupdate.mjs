// relayupdate.mjs - the computer's part in the relay updating itself (1.5.47).
//
// A release signs the relay.mjs it ships (scripts/sign-update.mjs ->
// relay-update.json, next to hub/relay/relay.mjs in the update package and in
// resources/server/update for the desktop build). This computer:
//   - tells its relay "I have relay x" when the tunnel comes up (a nudge, no code);
//   - hands the manifest and the file to the relay when the relay asks for
//     them through this computer's own tunnel (relaylink.mjs serves them).
// It is only the carrier: the relay checks the signature itself
// (hub/relay/relay.mjs verifyRelayUpdate) and runs nothing it cannot verify.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { relayUpdateMessage } from '../hub/relay/relay.mjs';
import { appRoot } from './bundle.mjs';

const VERSION_RE = /^\d{1,4}\.\d{1,5}\.\d{1,6}$/;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Sign relay.mjs's bytes for `version` with the release private key -> {v:1, version, sha256, signature}. */
export function makeRelayManifest({ version, bytes, privateKey }) {
  const hash = sha256(bytes);
  const key = typeof privateKey === 'string' || Buffer.isBuffer(privateKey) ? crypto.createPrivateKey(privateKey) : privateKey;
  return { v: 1, version: String(version), sha256: hash, signature: crypto.sign(null, relayUpdateMessage(String(version), hash), key).toString('base64') };
}

/** The relay code's identity for the version record: sha256 with LF line endings (a Windows checkout has CRLF). */
export function relayCodeHash(bytes) {
  return sha256(Buffer.from(String(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes).replace(/\r\n/g, '\n'), 'utf8'));
}

/** RELAY_VERSION as written in a relay.mjs's text ('' if missing). */
export function relayVersionIn(code) {
  return (/export const RELAY_VERSION = '([^']+)';/.exec(String(code)) || [])[1] || '';
}

/**
 * Was RELAY_VERSION raised whenever relay.mjs changed (1.5.49)? A relay only
 * takes a newer version, and the signed manifest carries RELAY_VERSION, so new
 * code under an old number would never reach a running relay. Problems, or []:
 *   code      relay.mjs's text now
 *   record    scripts/relay-versions.json: {versions: [{version, sha256}, ...]},
 *             one entry per relay release, oldest first
 *   base      relay.mjs's text in the last release (origin/main), if git has it
 */
export function relayVersionProblems({ code, record, base = '' }) {
  const out = [];
  const version = relayVersionIn(code);
  const hash = relayCodeHash(code);
  const list = Array.isArray(record?.versions) ? record.versions : [];
  if (!VERSION_RE.test(version)) out.push('relay.mjs has no RELAY_VERSION');
  if (!list.length) return [...out, 'scripts/relay-versions.json lists no relay versions'];
  for (let i = 0; i < list.length; i += 1) {
    const e = list[i];
    if (!VERSION_RE.test(String(e?.version)) || !/^[0-9a-f]{64}$/.test(String(e?.sha256))) out.push(`scripts/relay-versions.json entry ${i + 1} is not {version, sha256}`);
    else if (i && compareVersions(e.version, list[i - 1].version) <= 0) out.push(`scripts/relay-versions.json: ${e.version} is not newer than ${list[i - 1].version}`);
  }
  const last = list[list.length - 1];
  if (last.sha256 !== hash) {
    out.push(`relay.mjs changed since relay ${last.version}: set RELAY_VERSION to this release's version (above ${last.version}) and add {"version": "<it>", "sha256": "${hash}"} to scripts/relay-versions.json`);
  } else if (last.version !== version) {
    out.push(`RELAY_VERSION is ${version} but scripts/relay-versions.json records this code as ${last.version}`);
  }
  if (base && relayCodeHash(base) !== hash && compareVersions(version, relayVersionIn(base)) <= 0) {
    out.push(`relay.mjs differs from the last release but RELAY_VERSION (${version}) is not above its ${relayVersionIn(base) || '?'}`);
  }
  return out;
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  return 0;
}

/**
 * The signed relay this computer can hand over: {manifest, bytes}, or null
 * (a checkout or dev build has no manifest; one that does not match the file
 * next to it is never offered). The relay checks the signature again itself.
 */
export function readRelayUpdate(root = appRoot()) {
  const code = path.join(root, 'hub', 'relay', 'relay.mjs');
  for (const where of [path.join(root, 'hub', 'relay', 'relay-update.json'), path.join(root, 'update', 'relay-update.json')]) {
    try {
      const manifest = JSON.parse(fs.readFileSync(where, 'utf8'));
      const bytes = fs.readFileSync(code);
      if (manifest?.v === 1 && VERSION_RE.test(String(manifest.version)) && manifest.sha256 === sha256(bytes) && typeof manifest.signature === 'string') {
        return { manifest: { v: 1, version: manifest.version, sha256: manifest.sha256, signature: manifest.signature }, bytes };
      }
    } catch { /* not there */ }
  }
  return null;
}
