/**
 * The app page is split (ENG-04): public/index.html holds the markup and links
 * its style and scripts from public/app/. Checks that look for a piece of the
 * UI (smoke, check:i18n) read it as one text, put back together in page order
 * exactly as the single file used to be.
 */
import fs from 'node:fs';
import path from 'node:path';

export const PAGE_PARTS = ['app/theme.js', 'app/lang.js', 'app/style.css', 'app/main.js', 'app/diag.js'];

export function pageSource(publicDir) {
  const read = (rel) => fs.readFileSync(path.join(publicDir, rel), 'utf8').replace(/\r\n/g, '\n');
  return read('index.html')
    .replace(/<link rel="stylesheet" href="(app\/[^"]+\.css)" \/>/g, (_, rel) => `<style>${read(rel)}</style>`)
    .replace(/<script( type="module")? src="(app\/[^"]+\.js)"><\/script>/g, (_, mod, rel) => `<script${mod || ''}>${read(rel)}</script>`);
}
