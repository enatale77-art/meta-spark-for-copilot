#!/usr/bin/env node
/**
 * Prepare the Marketplace README for `vsce package`.
 *
 * Reads README.md, strips the sections wrapped in
 * `marketplace-readme:remove-start` / `marketplace-readme:remove-end`
 * markers, and writes the result to dist/README.marketplace.md.
 * Only Node builtins are used so this works on Windows/macOS/Linux
 * without bash.
 */
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const root = join(__dirname, '..');
const source = join(root, 'README.md');
const target = join(root, 'dist', 'README.marketplace.md');

const text = readFileSync(source, 'utf8');
const stripped = text.replace(
	/<!--\s*marketplace-readme:remove-start\s*-->[\s\S]*?<!--\s*marketplace-readme:remove-end\s*-->\n?/g,
	'',
);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, stripped);
console.log(`Marketplace README written to ${target}`);
