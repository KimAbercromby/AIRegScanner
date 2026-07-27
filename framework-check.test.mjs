import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { reconcile, summarise, indexSources } from './framework-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const readJSON = (n) => JSON.parse(readFileSync(join(HERE, n), 'utf8'));

const map = readJSON('framework-map.json');
const sources = readJSON('sources.json');

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

// The known standards gaps are deliberate. Assert they are present and still
// unmapped, so that if someone wires a source later they are nudged to update
// the map, and so the gaps cannot silently vanish from the record.
test('ISO/IEC 42001 and NIST are present and recorded as gaps', () => {
  const byItem = new Map(map.playbook_landscape.map((i) => [i.item, i]));
  for (const name of ['ISO/IEC 42001', 'NIST AI Risk Management Framework']) {
    const it = byItem.get(name);
    assert.ok(it, `${name} present in the landscape`);
    assert.equal(it.watched_by.length, 0, `${name} recorded as having no source`);
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
