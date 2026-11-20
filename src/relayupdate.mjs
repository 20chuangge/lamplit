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
