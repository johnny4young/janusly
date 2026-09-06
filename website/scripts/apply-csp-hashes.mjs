#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const DIST_DIR = resolve(process.cwd(), 'dist');
const HEADERS_PATH = join(DIST_DIR, '_headers');
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const JSON_LD_TYPE = 'application/ld+json';

async function collectHtmlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectHtmlFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      files.push(path);
    }
  }

  return files;
}

function getAttr(attrs, name) {
  const quoted = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
  if (quoted?.[1]) {
    return quoted[1];
  }

  const bare = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*([^\\s>]+)`, 'i'));
  return bare?.[1] ?? null;
}

function hasAttr(attrs, name) {
  return new RegExp(`(?:^|\\s)${name}(?:\\s*=|\\s|$)`, 'i').test(attrs);
}

function hashInlineScript(content) {
  const digest = createHash('sha256').update(content).digest('base64');
  return `'sha256-${digest}'`;
}

function appendScriptHashes(policy, hashes) {
  const directives = policy.split(';').map((directive) => directive.trim()).filter(Boolean);
  const hashList = Array.from(hashes).sort();
  const scriptIndex = directives.findIndex((directive) => directive.startsWith('script-src '));

  if (scriptIndex === -1) {
    directives.push(`script-src 'self' ${hashList.join(' ')}`);
    return directives.join('; ');
  }

  const [name, ...sources] = directives[scriptIndex].split(/\s+/);
  const merged = new Set(sources);
  for (const hash of hashList) {
    merged.add(hash);
  }

  directives[scriptIndex] = `${name} ${Array.from(merged).join(' ')}`;
  return directives.join('; ');
}

async function main() {
  const htmlFiles = await collectHtmlFiles(DIST_DIR);
  const jsonLdHashes = new Set();
  const executableInlineScripts = [];

  for (const file of htmlFiles) {
    const html = await readFile(file, 'utf8');
    for (const match of html.matchAll(SCRIPT_RE)) {
      const attrs = match[1] ?? '';
      const content = match[2] ?? '';

      if (hasAttr(attrs, 'src')) {
        continue;
      }

      const type = getAttr(attrs, 'type')?.toLowerCase() ?? 'text/javascript';
      if (type === JSON_LD_TYPE) {
        jsonLdHashes.add(hashInlineScript(content));
        continue;
      }

      executableInlineScripts.push(`${relative(DIST_DIR, file)}: <script${attrs}>`);
    }
  }

  if (executableInlineScripts.length > 0) {
    console.error('[csp] Refusing to allow executable inline scripts.');
    console.error('[csp] Move these scripts to public/scripts/ or add a deliberate CSP review:');
    for (const script of executableInlineScripts) {
      console.error(`  - ${script}`);
    }
    process.exit(1);
  }

  if (jsonLdHashes.size === 0) {
    console.log('[csp] No inline JSON-LD blocks found.');
    return;
  }

  const headers = await readFile(HEADERS_PATH, 'utf8');
  const updated = headers.replace(
    /(Content-Security-Policy:\s*)([^\n]+)/,
    (_match, prefix, policy) => `${prefix}${appendScriptHashes(policy, jsonLdHashes)}`,
  );

  if (updated === headers) {
    throw new Error(`Content-Security-Policy header not found in ${HEADERS_PATH}`);
  }

  await writeFile(HEADERS_PATH, updated);
  console.log(`[csp] Added ${jsonLdHashes.size} JSON-LD hash source(s) to dist/_headers.`);
}

await main();
