import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditPublicRegister, reconcile, summarise, indexSources } from './framework-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const readJSON = (n) => JSON.parse(readFileSync(join(HERE, n), 'utf8'));

const map = readJSON('framework-map.json');
const sources = readJSON('sources.json');
const snapshot = readJSON('framework-register-snapshot.json');
const mappings = readJSON('mappings.json');

// The core anti-rot guard: every source id the map points at must still exist
// in sources.json. If a source is ever renamed or removed, this fails and the
// map has to be updated in the same change. This is the whole point of the file.
test('every watched_by id resolves to a real source', () => {
  const { errors } = reconcile(map, sources);
  assert.deepEqual(errors, [], errors.join('\n'));
});

test('no playbook landscape item is missing its required fields', () => {
  for (const it of map.playbook_landscape) {
    assert.ok(it.item, 'item present');
    assert.ok(it.ref, `ref present for ${it.item}`);
    assert.ok(Array.isArray(it.watched_by), `watched_by is a list for ${it.item}`);
    assert.ok(['must-watch', 'reference'].includes(it.expectation), `valid expectation for ${it.item}`);
  }
});

test('map target version remains proposed and unversioned rather than inventing approval', () => {
  assert.doesNotMatch(map.target_playbook_version, /v19\.3/i);
  assert.match(map.target_playbook_version, /unversioned/i);
  assert.match(map.target_playbook_version, /not approved/i);
  assert.equal(map.target_playbook_version, mappings.target_playbook_version);
  assert.equal(map.reviewed_edition_sha256, mappings.mapping_alignment.archive_sha256);
  assert.deepEqual(map.playbook_landscape.filter((it) => /ISO\/IEC 42001|NIST AI Risk|Data \(Use and Access\)/.test(it.item)).map((it) => it.ref), ['§3.12 / Appendix D.2', 'Appendix D.4', '§2.5 / §4.6.1, AIG-ASS-05 Data Protection Impact Assessment']);
});

test('proposed controlled Capabilities and System Map remains a relationship pointer, not an authority source', () => {
  for (const pointer of [map.proposed_relationship_pointer, mappings.proposed_relationship_pointer]) {
    assert.equal(pointer.name, 'Capabilities and System Map');
    assert.match(pointer.status, /proposed controlled artefact AIG-INV-05/i);
    assert.match(pointer.status, /not approved or adopted/i);
    assert.ok(pointer.not_authoritative_for.includes('legal applicability'));
    assert.ok(pointer.not_authoritative_for.some((item) => /AIG-INV-04 Register identity/i.test(item)));
    assert.ok(pointer.not_authoritative_for.some((item) => /AIG-DEC-04 Gate Log/i.test(item)));
    assert.ok(pointer.not_authoritative_for.some((item) => /Register identity|AIG-AIMS-05 requirement content/i.test(item)));
    assert.ok(pointer.not_authoritative_for.some((item) => /approval/i.test(item)));
  }
  assert.match(JSON.stringify([map.proposed_relationship_pointer, mappings.proposed_relationship_pointer]), /AIG-INV-05/);
  assert.match(mappings.mapping_alignment.note, /historical scanner records retain their original labels/i);
  assert.equal(mappings.mapping_alignment.catalogue_pin_status, 'pinned-reviewed-proposed');
  assert.equal(map.register_landscape.filter((item) => /^REQ-\d{3}$/.test(item.ref)).length, 51);
});

test('framework-map matches all 51 AIG-AIMS-05 IDs with public details redacted for internal rows', () => {
  const requirements = map.register_landscape.filter((item) => /^REQ-\d{3}$/.test(item.ref));
  const refs = requirements.map((item) => item.ref);
  const expected = Array.from({ length: 51 }, (_, index) => `REQ-${String(index + 1).padStart(3, '0')}`);

  assert.deepEqual(refs, expected);
  assert.equal(snapshot.requirements.length, 51);
  assert.deepEqual(snapshot.requirements.map((item) => item.id), expected);
  const snapshotById = new Map(snapshot.requirements.map((item) => [item.id, item]));
  for (const item of requirements) {
    const expectedRow = snapshotById.get(item.ref);
    assert.ok(Array.isArray(item.watched_by), `watched_by is a list for ${item.ref}`);
    if (expectedRow.redacted) {
      assert.equal(item.item, 'Internal Council requirement (details withheld from public map)');
      assert.equal(item.expectation, 'not-monitored');
      assert.equal(item.watched_by.length, 0);
      assert.equal(Object.hasOwn(expectedRow, 'name'), false);
      assert.equal(Object.hasOwn(expectedRow, 'public_source_urls'), false);
    } else {
      assert.equal(item.item, expectedRow.name, `${item.ref} exact public name`);
      assert.ok(Array.isArray(expectedRow.public_source_urls) && expectedRow.public_source_urls.length);
      assert.ok(expectedRow.public_source_urls.every((url) => url.startsWith('https://')));
      assert.equal(item.expectation, 'must-watch', `${item.ref} is a desired monitoring row, not an applicability label`);
    }
  }
});

test('the published viewer stays static and explains its governance boundary', () => {
  const html = readFileSync(join(HERE, 'index.html'), 'utf8');
  const readme = readFileSync(join(HERE, 'README.md'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, 'viewer code remains inline for static deployment');
  assert.doesNotMatch(html, /<script\s+src=|<link[^>]+(?:stylesheet|preconnect)/i);
  assert.doesNotMatch(html, /fonts\.googleapis\.com/);
  assert.match(html, /does not establish applicability, legal scope, compliance/i);
  assert.match(html, /Governance suite is proposed, not approved/i);
  assert.match(html, /AIG-AIMS-13/i);
  assert.match(html, /AIG-INV-04 is the System Register and owns the permanent AIR-ID\/current\s+system state; AIG-DEC-04 is the separate Gate Log for plans, events and conditions/i);
  assert.match(html, /AIG-INV-05[\s\S]*?relationship pointer, not a\s+decision, permission or approval source/i);
  assert.match(html, /Equality Act 2010 s\.149/i);
  assert.match(html, /Human Rights Act 1998 s\.6/i);
  assert.match(html, /AI Governance Toolkit/);
  assert.match(html, /proposed grouped IDs, not an approved operational edition/i);
  assert.match(html, /Older scanner\s+records retain historical labels/i);
  assert.match(html, /conditional cases need owner review/i);
  assert.match(html, /Owner review: '\+x/);
  assert.doesNotMatch(`${html}\n${readme}`, /\bWestminster\b|London borough/i);
  assert.match(readme, /reviewed-proposed-not-approved/i);
  assert.match(readme, /Draft-labelled scanner code may be published for review/i);
  assert.match(readme, /do not publish a\s+controlled suite, migrate real records or claim approval/i);
  assert.match(html, /framework-map\.json/);
  assert.match(html, /framework-register-snapshot\.json/);
  assert.match(html, /configured source alignment/i);
  assert.match(html, /AIG-AIMS-13 cross-check/i);
  assert.doesNotThrow(() => new Function(scripts[0][1]), 'inline viewer JavaScript parses');
});

test('crosswalk source reconciliation is monitoring metadata, not a legal decision', () => {
  const { rows, errors } = reconcile(map, sources);
  const registerRows = rows.filter((row) => row.section === 'register');
  assert.equal(registerRows.length, map.register_landscape.length);
  assert.deepEqual(errors, []);
  assert.ok(registerRows.every((row) => ['live', 'dark', 'gap'].includes(row.computed)));
  assert.equal(Object.hasOwn(registerRows[0], 'applicability'), false);
  assert.match(map.register_anchor, /not an authoritative register/i);
  assert.match(map.note, /case-specific screening/i);
});

test('public-source audit validates exact names and reports unmatched URLs as gaps', () => {
  const audit = auditPublicRegister(map, snapshot, sources);
  assert.deepEqual(audit.errors, []);
  assert.equal(audit.summary.checked_requirements, 51);
  assert.equal(audit.summary.public_requirements, 43);
  assert.equal(audit.summary.exact_name_matches, 43);
  assert.equal(audit.summary.redacted_internal_not_monitored, 8);
  assert.equal(audit.summary.partial, 1, 'only the explicitly documented UK GDPR proxy is partial');
  assert.equal(audit.rows.find((row) => row.ref === 'REQ-001').status, 'partial');
  assert.equal(audit.rows.find((row) => row.ref === 'REQ-001').matchedUrls.length, 0, 'proxy is not reported as a direct URL match');
  assert.ok(audit.summary.matched < audit.summary.public_requirements, 'do not imply every public requirement has a matching monitor feed');
  assert.ok(audit.summary.gaps > 0, 'unmatched requirements are surfaced as gaps');
  assert.equal(audit.summary.aig_aims_13_public_urls, 17);
  assert.equal(audit.summary.matched_aig_aims_13_public_urls, 7);
  assert.equal(audit.rows.find((row) => row.ref === 'REQ-002').status, 'matched', 'instrument-specific legislation change feeds match their instrument');
  assert.equal(audit.rows.find((row) => row.ref === 'REQ-032').status, 'gap', 'UK legislation search is not an EU source match');
  for (const id of ['REQ-011', 'REQ-039', 'REQ-041', 'REQ-042', 'REQ-043']) {
    assert.equal(audit.rows.find((row) => row.ref === id).status, 'gap', `${id} remains explicit gap`);
  }
  assert.doesNotMatch(JSON.stringify(snapshot), /Westminster\.gov\.uk|OWNER VALIDATION REQUIRED|current approved Constitution/i);
  assert.doesNotMatch(JSON.stringify(snapshot.requirements.filter((row) => row.redacted)), /Council Constitution|policy repository|contract/i);
});

test('public-source audit fails exact-name drift and protects snapshot redaction', () => {
  const changedMap = JSON.parse(JSON.stringify(map));
  changedMap.register_landscape.find((row) => row.ref === 'REQ-001').item = 'Stale requirement name';
  const mismatch = auditPublicRegister(changedMap, snapshot, sources);
  assert.ok(mismatch.errors.some((error) => /REQ-001: map name does not exactly match/.test(error)));

  const changedSnapshot = JSON.parse(JSON.stringify(snapshot));
  changedSnapshot.requirements.find((row) => row.id === 'REQ-044').internal_reference = 'unexpected field';
  const redaction = auditPublicRegister(map, changedSnapshot, sources);
  assert.ok(redaction.errors.some((error) => /REQ-044: redacted snapshot row must contain only its ID and redaction marker/.test(error)));
});

test('same-publisher searches and different query-document IDs are not direct source matches', () => {
  const tinySnapshot = JSON.parse(JSON.stringify(snapshot));
  tinySnapshot.requirements.find((row) => row.id === 'REQ-001').public_source_urls = ['https://example.org/doc?id=one'];
  const tinyMap = JSON.parse(JSON.stringify(map));
  tinyMap.register_landscape.filter((row) => /^REQ-\d{3}$/.test(row.ref))
    .forEach((row) => { row.watched_by = []; });
  tinyMap.register_landscape.find((row) => row.ref === 'REQ-001').watched_by = ['publisher-search', 'query-document'];
  tinyMap.register_landscape.find((row) => row.ref === 'REQ-001').source_alignment = 'direct';
  const result = auditPublicRegister(tinyMap, tinySnapshot, {
    sources: [
      { id: 'publisher-search', url: 'https://example.org/search?q=act' },
      { id: 'query-document', url: 'https://example.org/doc?id=two' },
    ],
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].status, 'gap');
  assert.equal(result.summary.matched_public_urls, 0);
});

// The two standards gaps (ISO/IEC 42001, NIST AI RMF) were closed on 28 July by
// adding page-watch sources. Assert they are present and now WATCHED by a live
// source, so the closure cannot silently regress back to an unwatched claim.
test('ISO/IEC 42001 and NIST are present and now watched by a live source', () => {
  const byItem = new Map(map.playbook_landscape.map((i) => [i.item, i]));
  const byId = new Map(sources.sources.map((s) => [s.id, s]));
  const live = new Set(['verified', 'form-verified']);
  for (const name of ['ISO/IEC 42001', 'NIST AI Risk Management Framework']) {
    const it = byItem.get(name);
    assert.ok(it, `${name} present in the landscape`);
    assert.ok(it.watched_by.length >= 1, `${name} now has a watching source`);
    for (const id of it.watched_by) {
      const src = byId.get(id);
      assert.ok(src, `${name} watched_by ${id} exists in the register`);
      assert.ok(live.has(src.verification_status), `${name} watch source ${id} is live`);
      assert.equal(src.type, 'page-watch', `${name} is watched by a page-watch source`);
    }
  }
});

// Localism 2011 and the Local Government Act 1999 (best value) were removed from
// the scanner on 27 July, since the playbook names neither. Guard that they do
// not creep back into the map without the source list being updated too.
test('the trimmed-out statutes are not referenced anywhere in the map', () => {
  const referenced = new Set();
  for (const section of [map.playbook_landscape, map.operational_layer]) {
    for (const it of section) for (const id of it.watched_by ?? []) referenced.add(id);
  }
  assert.ok(!referenced.has('statute-lga-1999'), 'Local Government Act 1999 (best value) removed');
  assert.ok(!referenced.has('statute-localism-2011'), 'Localism Act 2011 removed');
});

test('the four kept service statutes remain in the operational layer', () => {
  const items = new Set(map.operational_layer.map((x) => x.item));
  for (const name of ['Care Act 2014', 'Children Act 1989', 'Children Act 2004', 'Housing Act 1996']) {
    assert.ok(items.has(name), `${name} kept`);
  }
});

// reconcile must compute live/dark/gap from the source list, not echo the map,
// so drift is caught. Feed it a synthetic source list to prove the computation.
test('reconcile computes live/dark/gap from source verification_status', () => {
  const synthetic = {
    sources: [
      { id: 'live-src', verification_status: 'verified' },
      { id: 'dark-src', verification_status: 'unverified' },
    ],
  };
  const tinyMap = {
    playbook_landscape: [
      { item: 'is-live', ref: 'x', expectation: 'must-watch', watched_by: ['live-src'] },
      { item: 'is-dark', ref: 'x', expectation: 'must-watch', watched_by: ['dark-src'] },
      { item: 'is-gap', ref: 'x', expectation: 'must-watch', watched_by: [] },
    ],
    operational_layer: [],
    decisions_required: [],
  };
  const { rows, errors } = reconcile(tinyMap, synthetic);
  assert.deepEqual(errors, []);
  assert.equal(rows.find((r) => r.item === 'is-live').computed, 'live');
  assert.equal(rows.find((r) => r.item === 'is-dark').computed, 'dark');
  assert.equal(rows.find((r) => r.item === 'is-gap').computed, 'gap');

  const s = summarise(rows);
  assert.equal(s.dark_must_watch, 1);
  assert.equal(s.gap_must_watch, 1);
});

test('a broken reference is reported as an error', () => {
  const { errors } = reconcile(
    { playbook_landscape: [{ item: 'broken', ref: 'x', expectation: 'must-watch', watched_by: ['does-not-exist'] }] },
    { sources: [] },
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /does-not-exist/);
});

test('indexSources maps every source by id', () => {
  const byId = indexSources(sources);
  assert.ok(byId.has('statute-equality-2010'));
  assert.equal(byId.size, sources.sources.length);
});
