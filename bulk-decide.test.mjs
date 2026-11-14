import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBulkDecisions } from './bulk-decide.mjs';

const reviewers = { reviewers: [{ github: 'KimAbercromby', role: 'AI Governance Lead', can_approve: true }] };
const mk = (id, over = {}) => ({ record_id: id, source_id: 'statute-x', title: 'A effect on B', status: 'unreviewed', issue_number: 1, affects_artefacts: [], ...over });
const base = { decided_by: 'KimAbercromby' };
const grp = (over = {}) => ({ id: 'g1', title_equals: 'A effect on B', decision: 'no-change', note: 'Already covered by section 4.', ...over });

test('B1: stamps one decision on every matching unreviewed record', () => {
  const recs = [mk('R1'), mk('R2'), mk('R3', { title: 'Other' })];
  const rep = applyBulkDecisions(recs, { ...base, groups: [grp()] }, reviewers, { now: 'T' });
  assert.equal(rep.applied.length, 2);
  assert.equal(recs[0].status, 'reviewed');
  assert.equal(recs[0].reviewed_by, 'KimAbercromby');
  assert.equal(recs[0].reviewed_by_role, 'AI Governance Lead');
  assert.equal(recs[0].bulk_group, 'g1');
  assert.equal(recs[2].status, 'unreviewed');
});

test('B2: preview changes nothing', () => {
  const recs = [mk('R1')];
  const rep = applyBulkDecisions(recs, { ...base, groups: [grp()] }, reviewers, { preview: true });
  assert.equal(recs[0].status, 'unreviewed');
  assert.equal(rep.groups[0].state, 'would apply');
});

test('B3: an undecided group is left alone', () => {
  const recs = [mk('R1')];
  const rep = applyBulkDecisions(recs, { ...base, groups: [grp({ decision: null })] }, reviewers);
  assert.equal(recs[0].status, 'unreviewed');
  assert.equal(rep.undecided, 1);
});

test('B4: an unknown decider is refused', () => {
  const rep = applyBulkDecisions([mk('R1')], { decided_by: 'someone', groups: [grp()] }, reviewers);
  assert.ok(rep.errors.length);
});

test('B5: an invalid decision is not applied (change-required needs sections or artefacts)', () => {
  const recs = [mk('R1')];
  const rep = applyBulkDecisions(recs, { ...base, groups: [grp({ decision: 'change-required' })] }, reviewers);
  assert.ok(rep.errors.length);
  assert.equal(recs[0].status, 'unreviewed');
});

test('B6: a changed count blocks the group', () => {
  const recs = [mk('R1'), mk('R2')];
  const rep = applyBulkDecisions(recs, { ...base, groups: [grp({ expect_count: 1 })] }, reviewers);
  assert.ok(rep.errors.length);
  assert.equal(recs[0].status, 'unreviewed');
});

test('B7: overlapping groups are an error, not first-match-wins', () => {
  const recs = [mk('R1')];
  const rep = applyBulkDecisions(recs, { ...base, groups: [grp(), grp({ id: 'g2', source_id: 'statute-x', title_equals: undefined })] }, reviewers);
  assert.ok(rep.errors.some((e) => /matches both/.test(e)));
  assert.equal(recs[0].status, 'unreviewed');
});

test('B8: a group with no matcher is refused', () => {
  const rep = applyBulkDecisions([mk('R1')], { ...base, groups: [{ id: 'g', decision: 'no-change', note: 'Long enough note here.' }] }, reviewers);
  assert.ok(rep.errors.length);
});

test('B9: change-required records carry sections and artefacts, and authority', () => {
  const recs = [mk('R1', { affects_artefacts: ['DPIA Template'] })];
  applyBulkDecisions(recs, { ...base, groups: [grp({ decision: 'change-required', sections: ['4.4.6'], artefacts: ['DPIA Template'], in_force: '2026-09-01' })] }, reviewers);
  assert.deepEqual(recs[0].decided_sections, ['4.4.6']);
  assert.equal(recs[0].decision_authorised, true);
  assert.equal(recs[0].date_in_force, '2026-09-01');
});
