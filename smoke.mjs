#!/usr/bin/env node
/**
 * QA M6. Every other test runs against local fixtures, which proves the parsers
 * work and says nothing about whether the tool can reach a single publisher.
 * That is the failure most likely to happen and hardest to notice.
 *
 * This calls one live source of each configured type, asserts it answers, parses
 * and returns items, and exits non-zero if not. Run weekly so a broken endpoint
 * surfaces as a red workflow rather than as silence.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSource } from './fetchers.mjs';
import { domainAllowed } from './scan.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const reg = JSON.parse(readFileSync(join(ROOT, 'sources.json'), 'utf8'));
const RUNNABLE = new Set(['verified', 'form-verified']);

const runnable = reg.sources.filter((s) => RUNNABLE.has(s.verification_status));
const byType = new Map();
for (const s of runnable) if (!byType.has(s.type)) byType.set(s.type, s);

if (!byType.size) {
  console.error('No runnable sources. Run the Resolve workflow first.');
  process.exit(1);
}

console.log(`Smoke testing ${byType.size} source type(s) against live endpoints.\n`);
let failures = 0;

for (const [type, source] of byType) {
  process.stdout.write(`  ${type.padEnd(14)} ${source.id.padEnd(30)} `);
  try {
    const res = await fetchSource(source);
    if (!res.ok) { console.log(`FAIL  HTTP ${res.status}`); failures++; continue; }
    if (!res.items.length) { console.log('FAIL  answered but returned no items'); failures++; continue; }

    const onDomain = res.items.filter((i) => i.url && domainAllowed(i.url, source.allowed_domains)).length;
    if (!onDomain) { console.log(`FAIL  ${res.items.length} items, none on an allowed domain`); failures++; continue; }
    if (!res.items.some((i) => i.title)) { console.log('FAIL  items have no titles: the parser may be reading the wrong shape'); failures++; continue; }

    console.log(`ok    ${res.items.length} items, ${onDomain} on-domain`);
  } catch (err) {
    console.log(`FAIL  ${err.message}`);
    failures++;
  }
}

console.log(failures ? `\n${failures} source type(s) failing. The scanner is not reliably reaching its publishers.` : '\nAll source types reachable and parsing.');
process.exit(failures ? 1 : 0);
