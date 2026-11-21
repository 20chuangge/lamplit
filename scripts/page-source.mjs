/**
 * The app page is split (ENG-04): public/index.html holds the markup and links
 * its style and scripts from public/app/. The main script is split again by
 * feature into public/app/main/ - plain scripts that share one scope and load
 * in order (defer), each starting with 'use strict' and a one-line comment.
 * Checks that look for a piece of the UI (smoke, check:i18n) read it as one
 * text, put back together in page order exactly as the single file used to be.
 */
import fs from 'node:fs';
import path from 'node:path';

export const MAIN_PARTS = [
  'app/main/01-core.js',
  'app/main/02-avatars.js',
  'app/main/03-groups.js',
  'app/main/04-bots.js',
  'app/main/05-chat.js',
  'app/main/06-live.js',
  'app/main/07-skills-routines.js',
  'app/main/08-settings.js',
  'app/main/09-apps.js',
  'app/main/10-computer.js',
  'app/main/11-machines.js',
  'app/main/11b-lamp.js',
  'app/main/12-wiring.js',
  'app/main/13-backup.js',
];
export const PAGE_PARTS = ['app/theme.js', 'app/lang.js', 'app/style.css', ...MAIN_PARTS, 'app/diag.js'];

const PART_HEADER = /^'use strict';\n\/\/ [^\n]*\n/;
const MAIN_BLOCK = /<script defer src="app\/main\/[\w-]+\.js"><\/script>(?:\n<script defer src="app\/main\/[\w-]+\.js"><\/script>)*/;

export function pageSource(publicDir) {
  const read = (rel) => fs.readFileSync(path.join(publicDir, rel), 'utf8').replace(/\r\n/g, '\n');
  return read('index.html')
    .replace(/<link rel="stylesheet" href="(app\/[^"]+\.css)" \/>/g, (_, rel) => `<style>${read(rel)}</style>`)
    .replace(MAIN_BLOCK, (block) => {
      const parts = [...block.matchAll(/src="(app\/main\/[\w-]+\.js)"/g)].map((m) => read(m[1]).replace(PART_HEADER, ''));
      return `<script type="module">${parts.join('')}</script>`;
    })
    .replace(/<script( type="module")? src="(app\/[^"]+\.js)"><\/script>/g, (_, mod, rel) => `<script${mod || ''}>${read(rel)}</script>`);
}
