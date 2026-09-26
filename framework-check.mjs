// framework-check.mjs
//
// Reconciles framework-map.json against sources.json so that "does the scanner
// map onto the playbook" is verified on every run instead of remembered.
//
// The map declares monitoring links for the playbook landscape and a draft
// crosswalk to AIG-AIMS-05 / AIG-AIMS-13 references. It reconciles stable REQ IDs, public names
// and source URLs against a reviewed public-safe snapshot, then computes configured
// publisher-source status. It does not decide legal applicability, compliance,
// Council approval, or ISO conformity.
//
// A source is LIVE when the scanner will actually call it, i.e. its
// verification_status is 'verified' or 'form-verified'. 'unverified' sources are
// skipped by the scanner, so they count as dark here.
//
// Exit codes:
//   0  no broken references or snapshot mismatch (default). Source gaps and dark
//      must-watch items are reported but do not fail.
//   1  a map entry references a source id that does not exist in sources.json
//      (genuine rot), a map/snapshot mismatch exists, or --strict was passed and
//      a must-watch item is gap/dark or source alignment is incomplete.

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

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    const query = [...url.searchParams.entries()]
      .sort(([keyA, valueA], [keyB, valueB]) => keyA.localeCompare(keyB) || valueA.localeCompare(valueB))
      .map(([key, item]) => `${encodeURIComponent(key)}=${encodeURIComponent(item)}`)
      .join('&');
    return `${url.hostname.toLowerCase().replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '').replace(/\.html$/, '')}${query ? `?${query}` : ''}`;
  } catch {
    return null;
  }
}

function sameInstrumentChangeFeed(feedUrl, referenceUrl) {
  try {
    const feed = new URL(feedUrl);
    const ref = new URL(referenceUrl);
    if (!/^(?:www\.)?legislation\.gov\.uk$/i.test(feed.hostname) ||
        !/^(?:www\.)?legislation\.gov\.uk$/i.test(ref.hostname)) return false;
    const instrument = ref.pathname.match(/^\/(ukpga|uksi|eur)\/([^/]+)\/([^/]+)/i);
    const changes = feed.pathname.match(/\/changes\/affected\/(ukpga|uksi|eur)\/([^/]+)\/([^/]+)\/data\.feed$/i);
    return Boolean(instrument && changes &&
      instrument.slice(1).every((part, index) => part.toLowerCase() === changes[index + 1].toLowerCase()));
  } catch {
    return false;
  }
}

function sourceDirectlyMatches(source, referenceUrl) {
  if (!source?.url) return false;
  const sourceCanonical = canonicalUrl(source.url);
  const referenceCanonical = canonicalUrl(referenceUrl);
  return Boolean(sourceCanonical && sourceCanonical === referenceCanonical) ||
    sameInstrumentChangeFeed(source.url, referenceUrl);
}

// Compare the public scanner map with a small reviewed snapshot, never with a
// live workbook. Internal Council entries have IDs only; their contents are
// intentionally absent from the snapshot.
export function auditPublicRegister(map, snapshot, sourcesFile) {
  const snapshotRequirements = snapshot.requirements ?? [];
  const snapshotById = new Map();
  const errors = [];
  const expectedIds = Array.from({ length: 51 }, (_, index) => `REQ-${String(index + 1).padStart(3, '0')}`);
  const redactedLabel = 'Internal Council requirement (details withheld from public map)';
  if (snapshotRequirements.length !== 51) errors.push(`sanitized requirement snapshot must contain 51 rows, found ${snapshotRequirements.length}`);
  for (const item of snapshotRequirements) {
    if (snapshotById.has(item.id)) errors.push(`${item.id}: duplicated in sanitized requirement snapshot`);
    snapshotById.set(item.id, item);
  }
  for (const id of expectedIds) {
    if (!snapshotById.has(id)) errors.push(`${id}: missing from sanitized requirement snapshot`);
  }
  for (const id of snapshotById.keys()) {
    if (!expectedIds.includes(id)) errors.push(`${id}: unexpected ID in sanitized requirement snapshot`);
  }
  const publicSnapshotRows = snapshotRequirements.filter((item) => !item.redacted);
  const redactedSnapshotRows = snapshotRequirements.filter((item) => item.redacted);
  if (publicSnapshotRows.length !== 43) errors.push(`sanitized snapshot must contain 43 public requirement rows, found ${publicSnapshotRows.length}`);
  if (redactedSnapshotRows.length !== 8) errors.push(`sanitized snapshot must contain 8 redacted internal rows, found ${redactedSnapshotRows.length}`);
  for (const item of publicSnapshotRows) {
    if (typeof item.name !== 'string' || !item.name.trim()) errors.push(`${item.id}: public requirement name missing from snapshot`);
    if (!Array.isArray(item.public_source_urls) || !item.public_source_urls.length ||
        item.public_source_urls.some((url) => typeof url !== 'string' || !url.startsWith('https://') || !canonicalUrl(url))) {
      errors.push(`${item.id}: public source URL list must contain HTTPS URLs`);
    }
  }
  for (const item of redactedSnapshotRows) {
    if (Object.keys(item).some((key) => !['id', 'redacted'].includes(key))) {
      errors.push(`${item.id}: redacted snapshot row must contain only its ID and redaction marker`);
    }
  }
  if (!Array.isArray(snapshot.aig_aims_13_public_source_urls) ||
      snapshot.aig_aims_13_public_source_urls.some((url) => typeof url !== 'string' || !url.startsWith('https://') || !canonicalUrl(url))) {
    errors.push('AIG-AIMS-13 cross-check must contain only public HTTPS source URLs');
  }
  const sourceById = indexSources(sourcesFile);
  const mapRows = (map.register_landscape ?? []).filter((item) => /^REQ-\d{3}$/.test(item.ref));
  const seen = new Set();
  const rows = [];

  for (const item of mapRows) {
    if (seen.has(item.ref)) errors.push(`${item.ref}: duplicated in framework-map.json`);
    seen.add(item.ref);
    const expected = snapshotById.get(item.ref);
    if (!expected) {
      errors.push(`${item.ref}: absent from the sanitized requirement snapshot`);
      continue;
    }

    const watched = item.watched_by ?? [];
    const unknownSources = watched.filter((id) => !sourceById.has(id));
    for (const id of unknownSources) errors.push(`${item.ref}: references unknown scanner source '${id}'`);

    if (expected.redacted) {
      if (item.item !== redactedLabel) errors.push(`${item.ref}: internal display label must remain generic and redacted`);
      if (item.note !== 'Public snapshot intentionally excludes internal Council requirement details and locations.') {
        errors.push(`${item.ref}: internal row note must remain generic and redacted`);
      }
      if (item.expectation !== 'not-monitored' || watched.length) {
        errors.push(`${item.ref}: redacted internal row must be marked not-monitored and have no publisher source`);
      }
      rows.push({ ref: item.ref, name: item.item, exactNameMatch: null, status: 'not-monitored', expectedUrls: [], matchedUrls: [], relatedAims13Matches: [], watched, unknownSources, note: item.note ?? null });
      continue;
    }

    const exactNameMatch = item.item === expected.name;
    if (!exactNameMatch) errors.push(`${item.ref}: map name does not exactly match the reviewed public snapshot`);
    const expectedUrls = expected.public_source_urls ?? [];
    const matchedUrls = expectedUrls.filter((url) =>
      watched.some((id) => sourceDirectlyMatches(sourceById.get(id), url)));
    const snapshot13Urls = snapshot.aig_aims_13_public_source_urls ?? [];
    const relatedAims13Matches = matchedUrls.filter((url) =>
      snapshot13Urls.some((relatedUrl) => canonicalUrl(relatedUrl) === canonicalUrl(url)));
    let status;
    if (matchedUrls.length === expectedUrls.length && expectedUrls.length) status = 'matched';
    else if (matchedUrls.length || item.source_alignment === 'proxy') status = 'partial';
    else status = 'gap';
    rows.push({
      ref: item.ref,
      name: item.item,
      exactNameMatch,
      status,
      sourceAlignment: item.source_alignment ?? 'direct',
      expectedUrls,
      matchedUrls,
      relatedAims13Matches,
      watched,
      unknownSources,
      note: item.note ?? null,
    });
  }

  for (const id of snapshotById.keys()) {
    if (!seen.has(id)) errors.push(`${id}: missing from framework-map.json`);
  }

  const publicRows = rows.filter((row) => row.status !== 'not-monitored');
  const mappedSourceIds = new Set(mapRows.flatMap((item) => item.watched_by ?? []));
  const snapshot13Urls = snapshot.aig_aims_13_public_source_urls ?? [];
  return {
    errors,
    rows,
    summary: {
      checked_requirements: rows.length,
      public_requirements: publicRows.length,
      exact_name_matches: publicRows.filter((row) => row.exactNameMatch).length,
      matched: publicRows.filter((row) => row.status === 'matched').length,
      partial: publicRows.filter((row) => row.status === 'partial').length,
      gaps: publicRows.filter((row) => row.status === 'gap').length,
      redacted_internal_not_monitored: rows.filter((row) => row.status === 'not-monitored').length,
      public_urls: publicRows.reduce((total, row) => total + row.expectedUrls.length, 0),
      matched_public_urls: publicRows.reduce((total, row) => total + row.matchedUrls.length, 0),
      aig_aims_13_public_urls: snapshot13Urls.length,
      matched_aig_aims_13_public_urls: snapshot13Urls.filter((url) =>
        [...mappedSourceIds].some((id) => sourceDirectlyMatches(sourceById.get(id), url))).length,
    },
  };
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
    ['register', map.register_landscape ?? []],
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

function icon(computed, expectation) {
  if (expectation === 'reference') return computed === 'live' ? 'REF  ' : computed === 'dark' ? 'DARK ' : 'GAP  ';
  return computed === 'live' ? 'WATCH' : computed === 'dark' ? 'DARK ' : 'GAP  ';
}

function run() {
  const strict = process.argv.includes('--strict');
  const map = readJSON('framework-map.json');
  const sourcesFile = readJSON('sources.json');
  const snapshot = readJSON('framework-register-snapshot.json');
  const { errors, rows, decisions } = reconcile(map, sourcesFile);
  const registerAudit = auditPublicRegister(map, snapshot, sourcesFile);

  const line = (s = '') => process.stdout.write(s + '\n');

  line(`Framework source monitor \u2014 map v${map.framework_map_version}; target ${map.target_playbook_version}`);
  line('Anchor: playbook \u00a72.5 regulatory landscape.');
  line('');

  line('Playbook landscape:');
  for (const r of rows.filter((r) => r.section === 'playbook')) {
    const watch = r.watched.length ? r.watched.join(', ') : '(no source)';
    line(`  [${icon(r.computed, r.expectation)}] ${r.item}  <-  ${watch}`);
    if (r.computed !== 'live' && r.note) line(`         ${r.note}`);
  }

  line('');
  line('Public-safe AIG-AIMS-05 / AIG-AIMS-13 reference audit (not applicability):');
  const a = registerAudit.summary;
  line(`  Checked ${a.checked_requirements}/51 requirement IDs; ${a.exact_name_matches}/${a.public_requirements} public names exact; ${a.redacted_internal_not_monitored} internal names/locations withheld.`);
  line(`  Public source alignment: ${a.matched} matched, ${a.partial} partial, ${a.gaps} gaps across ${a.public_urls} AIG-AIMS-05 public URLs; ${a.matched_public_urls} directly matched to a configured scanner source.`);
  line(`  AIG-AIMS-13 cross-check: ${a.matched_aig_aims_13_public_urls}/${a.aig_aims_13_public_urls} public URLs directly match configured sources; these cross-check URLs are not assigned to requirement rows.`);
  for (const row of registerAudit.rows.filter((r) => r.status === 'gap' || r.status === 'partial')) {
    const watch = row.watched.length ? row.watched.join(', ') : '(no scanner source configured)';
    line(`  [${row.status.toUpperCase()}] ${row.ref} ${row.name} <- ${watch}`);
    if (row.matchedUrls.length) line(`         AIG-AIMS-05 public URL(s) matched: ${row.matchedUrls.length}/${row.expectedUrls.length}`);
    for (const url of row.expectedUrls.filter((expectedUrl) => !row.matchedUrls.includes(expectedUrl))) {
      line(`         [NO DIRECT SOURCE MATCH] ${url}`);
    }
    if (row.relatedAims13Matches?.length) line(`         AIG-AIMS-13 public source link(s) matched: ${row.relatedAims13Matches.length}`);
    if (row.sourceAlignment === 'proxy') line('         Proxy only; no exact AIG-AIMS-05 source URL match.');
    if (row.note) line(`         ${row.note}`);
  }

  line('');
  line('Operational layer (watched, not named in the playbook \u2014 deliberate):');
  for (const r of rows.filter((r) => r.section === 'operational')) {
    line(`  [${icon(r.computed, r.expectation)}] ${r.item}  <-  ${r.watched.join(', ')}`);
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
  line(`Summary: ${s.live}/${s.total} mapped items have a source configured for calling; ${s.dark_must_watch} must-watch items have only dark sources; ${s.gap_must_watch} must-watch items have no source.`);

  if (errors.length) {
    line('');
    line('ERRORS (map references sources that do not exist):');
    for (const e of errors) line(`  - ${e}`);
    process.exitCode = 1;
    return;
  }

  if (registerAudit.errors.length) {
    line('');
    line('ERRORS (sanitized snapshot / framework-map mismatch):');
    for (const e of registerAudit.errors) line(`  - ${e}`);
    process.exitCode = 1;
    return;
  }

  if (strict && (s.dark_must_watch > 0 || s.gap_must_watch > 0 || a.partial > 0 || a.gaps > 0)) {
    line('');
    line('--strict: failing because source matches are partial/gap or expected scanner sources are dark.');
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run();
