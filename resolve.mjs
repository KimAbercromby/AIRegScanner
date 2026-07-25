#!/usr/bin/env node
/**
 * Resolves statute chapter numbers using legislation.gov.uk's own identifier
 * service, then writes the confirmed feed URL into sources.json and promotes
 * the source to `verified`.
 *
 * The point: nobody, human or model, types a chapter number from memory. The
 * publisher tells us what its own identifier is.
 *
 *   GET /id?title="Equality Act 2010"&type=ukpga&year=2010
 *     301 -> the canonical URI            (one match, confirmed)
 *     300 -> a list of possibilities      (ambiguous, left unverified)
 *
 * Run: npm run resolve
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpGet } from './fetchers.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SOURCES = join(ROOT, 'sources.json');
const TODAY = new Date().toISOString().slice(0, 10);

/** Pull /{type}/{year}/{number} out of a legislation.gov.uk URI. */
export function parseLegUri(url) {
  const m = String(url).match(/legislation\.gov\.uk\/(?:id\/)?([a-z]+)\/(\d{4})\/(\d+)(?:\/|$|\?)/i);
  if (!m) return null;
  return { type: m[1], year: m[2], number: m[3] };
}

export function changesFeedUrl(id) {
  return `https://www.legislation.gov.uk/changes/affected/${id.type}/${id.year}/${id.number}/data.feed?results-count=100`;
}

export function idLookupUrl(r) {
  const u = new URL('https://www.legislation.gov.uk/id');
  u.searchParams.set('title', `"${r.title}"`);
  u.searchParams.set('type', r.type);
  u.searchParams.set('year', r.year);
  return u.toString();
}

async function main() {
  const reg = JSON.parse(readFileSync(SOURCES, 'utf8'));
  const pending = reg.sources.filter((s) => s.resolve && s.verification_status === 'unverified');

  if (!pending.length) {
    console.log('Nothing to resolve. All statute sources are already verified.');
    return;
  }

  let resolved = 0;
  const failures = [];

  for (const s of pending) {
    const lookup = idLookupUrl(s.resolve);
    let res;
    try {
      res = await httpGet(lookup, { accept: 'application/xhtml+xml, text/html' });
    } catch (err) {
      failures.push([s.id, `request failed: ${err.message}`]);
      continue;
    }

    const id = parseLegUri(res.finalUrl);

    if (!id) {
      // A 300 Multiple Choices means the title matched more than one item.
      const hint = res.status === 300 ? 'ambiguous title, several matches' : `no redirect (HTTP ${res.status})`;
      failures.push([s.id, `${hint}. Open ${lookup} and pick the right one by hand.`]);
      continue;
    }

    if (id.year !== s.resolve.year || id.type !== s.resolve.type) {
      failures.push([s.id, `resolved to ${id.type}/${id.year}/${id.number}, which does not match the expected type and year. Not written.`]);
      continue;
    }

    s.url = changesFeedUrl(id);
    s.verification_status = 'verified';
    s.last_verified = TODAY;
    s.verify_note = `Chapter number ${id.year} c.${id.number} confirmed on ${TODAY} by legislation.gov.uk identifier lookup, not typed from memory.`;
    resolved += 1;
    console.log(`  ok  ${s.id.padEnd(28)} ${id.type}/${id.year}/${id.number}`);
  }

  if (resolved) {
    writeFileSync(SOURCES, JSON.stringify(reg, null, 2) + '\n');
  }

  console.log(`\n${resolved} of ${pending.length} resolved and promoted to verified.`);
  if (failures.length) {
    console.log('\nLeft unverified:');
    for (const [id, why] of failures) console.log(`  !   ${id}: ${why}`);
    console.log('\nThese stay skipped rather than guessed. Fix them by hand and set verification_status to "verified".');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
