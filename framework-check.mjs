// framework-check.mjs
//
// Reconciles framework-map.json against sources.json so that "does the scanner
// map onto the playbook" is verified on every run instead of remembered.
//
// The map declares, for each item in the playbook's own regulatory landscape
// (playbook v19 section 2.5, plus the ISO/NIST alignment claims and the DUAA
// safeguards), which source is meant to watch it. This script computes the LIVE
// state from sources.json and reports drift. Because live status is recomputed
// from sources.json every time, a status in the map cannot quietly go stale.
//
// A source is LIVE when the scanner will actually call it, i.e. its
// verification_status is 'verified' or 'form-verified'. 'unverified' sources are
// skipped by the scanner, so they count as dark here.
//
// Exit codes:
//   0  no broken references (default). Gaps and dark must-watch items are
//      reported as warnings but do not fail, because an unresolved statute feed
//      is an expected state until `npm run resolve` has run and been committed.
//   1  a map entry references a source id that does not exist in sources.json
//      (genuine rot), or --strict was passed and a must-watch item is gap/dark.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const readJSON = (name) => JSON.parse(readFileSync(join(HERE, name), 'utf8'));

const LIVE = new Set(['verified', 'form-verified']);

export function indexSources(sourcesFile) {
  const byId = new Map();
  for (const s of sourcesFile.sources ?? []) byId.set(s.id, s);
  return byId;
}

// Pure. Given the map and the sources file, returns the reconciled rows, any
// broken-reference errors, and the outstanding decisions. No I/O, so it is
// testable against synthetic inputs.
export function reconcile(map, sourcesFile) {
  const byId = indexSources(sourcesFile);
  const errors = [];
  const rows = [];

  const sections = [
    ['playbook', map.playbook_landscape ?? []],
    ['operational', map.operational_layer ?? []],
  ];

  for (const [section, items] of sections) {
    for (const it of items) {
      const watched = it.watched_by ?? [];
      const known = watched.filter((id) => byId.has(id));
      const unknown = watched.filter((id) => !byId.has(id));
      for (const id of unknown) {
        errors.push(`${it.item}: references unknown source '${id}'`);
      }
      const live = known.filter((id) => LIVE.has(byId.get(id).verification_status));

      let computed;
      if (watched.length === 0) computed = 'gap';
      else if (live.length === 0) computed = 'dark';
      else computed = 'live';

      rows.push({
        section,
        item: it.item,
        expectation: it.expectation ?? (section === 'operational' ? 'operational' : 'must-watch'),
        watched,
        live,
        dark: known.filter((id) => !LIVE.has(byId.get(id).verification_status)),
        unknown,
        computed,
        note: it.note ?? null,
      });
    }
  }

  return { errors, rows, decisions: map.decisions_required ?? [] };
}

export function summarise(rows) {
  const mustWatch = rows.filter((r) => r.expectation === 'must-watch');
  return {
    total: rows.length,
    live: rows.filter((r) => r.computed === 'live').length,
    dark_must_watch: mustWatch.filter((r) => r.computed === 'dark').length,
    gap_must_watch: mustWatch.filter((r) => r.computed === 'gap').length,
  };
}

function icon(computed) {
  return computed === 'live' ? 'LIVE' : computed === 'dark' ? 'DARK' : 'GAP ';
}

function run() {
  const strict = process.argv.includes('--strict');
  const map = readJSON('framework-map.json');
  const sourcesFile = readJSON('sources.json');
  const { errors, rows, decisions } = reconcile(map, sourcesFile);

  const line = (s = '') => process.stdout.write(s + '\n');

  line(`Framework coverage \u2014 map v${map.framework_map_version} against playbook ${map.target_playbook_version}`);
  line('Anchor: playbook \u00a72.5 regulatory landscape.');
  line('');

  line('Playbook landscape:');
  for (const r of rows.filter((r) => r.section === 'playbook')) {
    const watch = r.watched.length ? r.watched.join(', ') : '(no source)';
    line(`  [${icon(r.computed)}] ${r.item}  <-  ${watch}`);
    if (r.computed !== 'live' && r.note) line(`         ${r.note}`);
  }

  line('');
  line('Operational layer (watched, not named in the playbook \u2014 deliberate):');
  for (const r of rows.filter((r) => r.section === 'operational')) {
    line(`  [${icon(r.computed)}] ${r.item}  <-  ${r.watched.join(', ')}`);
  }

  if (decisions.length) {
    line('');
    line('Decisions required:');
    for (const d of decisions) {
      line(`  - ${d.item}`);
      line(`      ${d.question}`);
    }
  }

  const s = summarise(rows);
  line('');
  line(`Summary: ${s.live}/${s.total} mapped items live, ${s.dark_must_watch} must-watch dark (need resolve/connect), ${s.gap_must_watch} must-watch gaps (no source).`);

  if (errors.length) {
    line('');
    line('ERRORS (map references sources that do not exist):');
    for (const e of errors) line(`  - ${e}`);
    process.exitCode = 1;
    return;
  }

  if (strict && (s.dark_must_watch > 0 || s.gap_must_watch > 0)) {
    line('');
    line('--strict: failing because must-watch items are not live.');
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run();
