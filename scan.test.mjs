import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAtom, parseAtomChanges, parseGovukSearch, buildGovukUrl } from './fetchers.mjs';
import { domainAllowed, classify, passesRelevanceGate } from './scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = (n) => readFileSync(join(HERE, n), 'utf8');
const mappings = JSON.parse(readFileSync(join(HERE, 'mappings.json'), 'utf8'));

test('parseAtom extracts entries with the canonical link, not the PDF or XML alternates', () => {
  const items = parseAtom(fx('legislation-new.atom.xml'));
  assert.equal(items.length, 3);
  assert.equal(items[0].title, 'The Automated Decision-Making (Public Authorities) Regulations 2026');
  assert.equal(items[0].url, 'http://www.legislation.gov.uk/uksi/2026/412');
  assert.equal(items[0].date_published, '2026-07-22T11:00:00+01:00');
});

test('parseAtomChanges extracts the in-force date from ukm:Effect', () => {
  const items = parseAtomChanges(fx('legislation-changes.atom.xml'));
  assert.equal(items.length, 1);
  assert.equal(items[0].date_in_force, '2026-02-05');
  assert.equal(items[0].url, 'http://www.legislation.gov.uk/id/ukpga/2018/12');
  assert.match(items[0].summary, /words substituted/);
});

test('in-force date is distinct from publication date', () => {
  const [item] = parseAtomChanges(fx('legislation-changes.atom.xml'));
  assert.ok(item.date_published);
  assert.ok(item.date_in_force);
  assert.notEqual(item.date_published, item.date_in_force);
});

test('parseGovukSearch absolutises relative links', () => {
  const items = parseGovukSearch(fx('govuk-search.json'));
  assert.equal(items.length, 3);
  assert.equal(items[0].url, 'https://www.gov.uk/government/publications/ai-in-the-public-sector');
  assert.equal(items[1].url, 'https://www.gov.uk/government/collections/algorithmic-transparency-recording-standard-hub');
});

test('buildGovukUrl expands repeated parameters and adds default fields', () => {
  const url = buildGovukUrl({
    url: 'https://www.gov.uk/api/search.json',
    query: { q: 'artificial intelligence', filter_organisations: ['cabinet-office', 'home-office'], count: '50' }
  });
  const u = new URL(url);
  assert.deepEqual(u.searchParams.getAll('filter_organisations'), ['cabinet-office', 'home-office']);
  assert.ok(u.searchParams.getAll('fields').includes('public_timestamp'));
});

test('domainAllowed accepts the publisher domain and its subdomains', () => {
  assert.ok(domainAllowed('https://www.legislation.gov.uk/uksi/2026/412', ['legislation.gov.uk']));
  assert.ok(domainAllowed('https://legislation.gov.uk/uksi/2026/412', ['legislation.gov.uk']));
});

test('domainAllowed rejects an off-publisher link even inside a trusted feed', () => {
  const items = parseAtom(fx('legislation-new.atom.xml'));
  const spoofed = items.find((i) => i.title.includes('Algorithmic Transparency'));
  assert.ok(spoofed, 'fixture should contain an off-domain entry');
  assert.equal(domainAllowed(spoofed.url, ['legislation.gov.uk', 'www.legislation.gov.uk']), false);
});

test('domainAllowed is not fooled by a suffix lookalike domain', () => {
  assert.equal(domainAllowed('https://notlegislation.gov.uk/x', ['legislation.gov.uk']), false);
  assert.equal(domainAllowed('https://legislation.gov.uk.evil.com/x', ['legislation.gov.uk']), false);
});

test('domainAllowed rejects malformed URLs rather than throwing', () => {
  assert.equal(domainAllowed('not a url', ['legislation.gov.uk']), false);
});

test('relevance gate keeps AI items and drops unrelated ones', () => {
  const items = parseAtom(fx('legislation-new.atom.xml'));
  assert.ok(passesRelevanceGate(items[0], mappings));
  assert.equal(passesRelevanceGate(items[1], mappings), false);
});

test('classify maps an ADM instrument onto the DPIA and approval framework', () => {
  const [adm] = parseAtom(fx('legislation-new.atom.xml'));
  const c = classify(adm, mappings);
  assert.ok(c.topics.includes('adm-article-22'));
  assert.ok(c.affects_sections.includes('3.10.1'));
  assert.ok(c.affects_artefacts.includes('DPIA Template'));
});

test('classify maps a transparency item onto the ATRS record', () => {
  const items = parseGovukSearch(fx('govuk-search.json'));
  const atrs = items.find((i) => i.title.includes('Algorithmic Transparency'));
  const c = classify(atrs, mappings);
  assert.ok(c.topics.includes('transparency-atrs'));
  assert.ok(c.affects_artefacts.includes('ATRS Record'));
});

test('classify returns empty rather than guessing on an unrelated item', () => {
  const items = parseGovukSearch(fx('govuk-search.json'));
  const annual = items.find((i) => i.title.includes('annual report'));
  const c = classify(annual, mappings);
  assert.deepEqual(c.topics, []);
  assert.deepEqual(c.affects_sections, []);
});

test('every mapping topic references at least one section and one artefact', () => {
  for (const t of mappings.topics) {
    assert.ok(t.affects_sections.length > 0, `${t.id} has no sections`);
    assert.ok(t.affects_artefacts.length > 0, `${t.id} has no artefacts`);
    assert.ok(t.why && t.why.length > 20, `${t.id} has no rationale`);
  }
});

test('source register is internally consistent', () => {
  const reg = JSON.parse(readFileSync(join(HERE, 'sources.json'), 'utf8'));
  const ids = new Set();
  for (const s of reg.sources) {
    assert.ok(!ids.has(s.id), `duplicate source id ${s.id}`);
    ids.add(s.id);
    assert.ok(s.allowed_domains?.length, `${s.id} has no allowed_domains`);
    assert.ok(['verified', 'form-verified', 'unverified'].includes(s.verification_status), `${s.id} bad status`);
    assert.ok(s.verify_note, `${s.id} has no verify_note`);
    if (s.verification_status !== 'unverified') {
      assert.ok(s.last_verified, `${s.id} is runnable but has no last_verified date`);
      assert.ok(s.url, `${s.id} is runnable but has no url`);
    }
  }
});

// ---- v0.2: council scope ----

test('a reference-only topic records but flags nothing for change', () => {
  const c = classify({ title: 'Commission adopts EU AI Act harmonised standard', summary: 'GPAI obligations.' }, mappings);
  assert.ok(c.topics.includes('eu-ai-act'));
  assert.equal(c.reference_only, true);
  assert.deepEqual(c.affects_sections, []);
  assert.deepEqual(c.affects_artefacts, []);
});

test('a mixed item is not treated as reference-only', () => {
  const c = classify({ title: 'EU AI Act and automated decision-making in adult social care', summary: '' }, mappings);
  assert.ok(c.topics.includes('eu-ai-act'));
  assert.equal(c.reference_only, false);
  assert.ok(c.affects_artefacts.length > 0);
});

test('council duty topics map to the right artefacts', () => {
  const cases = [
    ['Ombudsman finds maladministration in housing allocation', 'maladministration', 'Incident Report Form'],
    ['Statutory guidance on best value', 'psed-best-value', 'Dashboard'],
    ['Working together to safeguard children: update', 'safeguarding', 'RAIA'],
    ['Procurement Policy Note: contracting authority duties', 'procurement-regime', 'Supplier DDQ'],
    ['Freedom of Information: publication scheme guidance', 'information-rights', 'Model Card Template']
  ];
  for (const [title, topic, artefact] of cases) {
    const c = classify({ title, summary: '' }, mappings);
    assert.ok(c.topics.includes(topic), `${title} -> ${topic}`);
    assert.ok(c.affects_artefacts.includes(artefact), `${title} -> ${artefact}`);
  }
});

test('every topic declares reference_only explicitly', () => {
  for (const t of mappings.topics) {
    assert.equal(typeof t.reference_only, 'boolean', `${t.id} missing reference_only`);
  }
});

test('register is scoped to England and says so', () => {
  const reg = JSON.parse(readFileSync(join(HERE, 'sources.json'), 'utf8'));
  assert.equal(reg.scope.jurisdiction, 'England');
  assert.ok(reg.scope.note.length > 20);
});

test('no statute source is runnable before it has been resolved', () => {
  const reg = JSON.parse(readFileSync(join(HERE, 'sources.json'), 'utf8'));
  for (const s of reg.sources.filter((x) => x.resolve)) {
    if (s.verification_status !== 'unverified') {
      assert.ok(s.url, `${s.id} is promoted but has no url`);
      assert.match(s.url, /\/changes\/affected\/[a-z]+\/\d{4}\/\d+\/data\.feed/);
    } else {
      assert.equal(s.url, null, `${s.id} is unverified but carries a url`);
    }
  }
});

test('resolve builds the right lookup and feed URLs', async () => {
  const { idLookupUrl, changesFeedUrl, parseLegUri } = await import('./resolve.mjs');
  const lookup = new URL(idLookupUrl({ title: 'Equality Act 2010', type: 'ukpga', year: '2010' }));
  assert.equal(lookup.pathname, '/id');
  assert.equal(lookup.searchParams.get('title'), '"Equality Act 2010"');
  assert.equal(lookup.searchParams.get('type'), 'ukpga');

  const id = parseLegUri('https://www.legislation.gov.uk/ukpga/2010/15');
  assert.deepEqual(id, { type: 'ukpga', year: '2010', number: '15' });
  assert.equal(parseLegUri('https://www.legislation.gov.uk/id/ukpga/2010/15').number, '15');
  assert.equal(parseLegUri('https://www.legislation.gov.uk/id?title=Companies+Act'), null);

  assert.equal(changesFeedUrl(id),
    'https://www.legislation.gov.uk/changes/affected/ukpga/2010/15/data.feed?results-count=100');
});

// ---- v0.3: issues as the review workflow ----

test('issue titles carry the record id and stay within GitHub limits', async () => {
  const { issueTitle } = await import('./issues.mjs');
  const short = issueTitle({ record_id: 'REG-0001', title: 'Short title' });
  assert.equal(short, '[REG-0001] Short title');

  const long = issueTitle({ record_id: 'REG-0001', title: 'x'.repeat(400) });
  assert.ok(long.length <= 256, `title too long: ${long.length}`);
  assert.ok(long.startsWith('[REG-0001] '));
  assert.ok(long.endsWith('\u2026'));

  assert.equal(issueTitle({ record_id: 'REG-0009', title: null }), '[REG-0009] Untitled item');
});

test('labels distinguish a flagged change from a reference item', async () => {
  const { labelsFor } = await import('./issues.mjs');
  const flagged = labelsFor({ tier: 1, reference_only: false, affects_artefacts: ['DPIA Template'], topics: ['adm-article-22'] });
  assert.ok(flagged.includes('flags-change'));
  assert.ok(flagged.includes('tier-1'));
  assert.ok(flagged.includes('topic:adm-article-22'));
  assert.ok(!flagged.includes('reference-only'));

  const ref = labelsFor({ tier: 1, reference_only: true, affects_artefacts: [], topics: ['eu-ai-act'] });
  assert.ok(ref.includes('reference-only'));
  assert.ok(!ref.includes('flags-change'));

  const unmapped = labelsFor({ tier: 2, reference_only: false, affects_artefacts: [], topics: [] });
  assert.ok(unmapped.includes('unmapped'));
});

test('labels contain no duplicates', async () => {
  const { labelsFor } = await import('./issues.mjs');
  const l = labelsFor({ tier: 1, reference_only: false, affects_artefacts: ['X'], topics: ['a', 'a', 'b'] });
  assert.equal(l.length, new Set(l).size);
});

test('issue body makes a missing in-force date impossible to miss', async () => {
  const { issueBody } = await import('./issues.mjs');
  const missing = issueBody({
    record_id: 'REG-0001', publisher: 'TNA', tier: 1, source_id: 's', url: 'https://x',
    date_published: '2026-07-22T11:00:00+01:00', date_in_force: null, date_retrieved: '2026-07-24T07:00:00Z',
    event: 'new', reference_only: false, affects_sections: ['3.10.1'], affects_artefacts: ['DPIA Template'],
    content_hash: 'abc'
  });
  // Wording tightened in v0.5: the reviewer is now asked to find and record the
  // date, because the commencement diary depends on having it.
  assert.match(missing, /not stated in source/);
  assert.match(missing, /record it below/);
  assert.match(missing, /Flags a change/);
  assert.match(missing, /§3\.10\.1/);

  const present = issueBody({
    record_id: 'REG-0002', publisher: 'TNA', tier: 1, source_id: 's', url: 'https://x',
    date_published: '2026-02-05T10:00:00Z', date_in_force: '2026-10-01', date_retrieved: '2026-07-24T07:00:00Z',
    event: 'new', reference_only: false, affects_sections: [], affects_artefacts: [], content_hash: 'abc'
  });
  assert.match(present, /\| \*\*In force\*\* \| 2026-10-01 \|/);
  assert.match(present, /No mapping matched/);
});

test('a reference-only issue says it flags nothing', async () => {
  const { issueBody } = await import('./issues.mjs');
  const b = issueBody({
    record_id: 'REG-0003', publisher: 'TNA', tier: 1, source_id: 's', url: 'https://x',
    date_published: '2026-07-16T00:00:00Z', date_in_force: null, date_retrieved: '2026-07-24T07:00:00Z',
    event: 'new', reference_only: true, affects_sections: [], affects_artefacts: [], content_hash: 'abc'
  });
  assert.match(b, /Reference only/);
  assert.ok(!/Flags a change/.test(b));
});

test('issue body never presents generated content as the record', async () => {
  const { issueBody } = await import('./issues.mjs');
  const b = issueBody({
    record_id: 'REG-0001', publisher: 'TNA', tier: 1, source_id: 's', url: 'https://x',
    date_published: null, date_in_force: null, date_retrieved: null, event: 'new',
    reference_only: false, affects_sections: [], affects_artefacts: [], content_hash: 'abc'
  });
  assert.match(b, /advisory and is not the record/);
});

test('new records are created with an empty issue_number', () => {
  const src = readFileSync(join(HERE, 'scan.mjs'), 'utf8');
  assert.match(src, /issue_number: null/);
});

// ---- v0.4: workable-on-day-one fixes ----

test('html-list extracts document links and skips navigation chrome', async () => {
  const { parseHtmlList } = await import('./fetchers.mjs');
  const items = parseHtmlList(fx('listing-page.html'),
    { link_pattern: '/guidance/' }, 'https://ico.org.uk/for-organisations/');
  const urls = items.map((i) => i.url);
  assert.ok(urls.includes('https://ico.org.uk/guidance/ai-and-data-protection'));
  assert.ok(urls.some((u) => u.includes('automated-decision-making')));
  assert.ok(!urls.some((u) => u.endsWith('/about')), 'nav should not match the pattern');
  assert.ok(!urls.some((u) => u.endsWith('/privacy')));
});

test('html-list resolves relative links and drops fragments and short link text', async () => {
  const { parseHtmlList } = await import('./fetchers.mjs');
  const items = parseHtmlList(fx('listing-page.html'), {}, 'https://ico.org.uk/for-organisations/');
  assert.ok(items.every((i) => i.url.startsWith('http')), 'all links absolute');
  assert.ok(items.every((i) => !i.url.includes('#')));
  assert.ok(!items.some((i) => i.title === 'Go'), 'short link text dropped');
  assert.ok(!items.some((i) => i.title === 'Home'));
});

test('html-list never invents a publication date', async () => {
  const { parseHtmlList } = await import('./fetchers.mjs');
  const items = parseHtmlList(fx('listing-page.html'), { link_pattern: '/guidance/' }, 'https://ico.org.uk/x');
  assert.ok(items.length > 0);
  assert.ok(items.every((i) => i.date_published === null && i.date_in_force === null));
});

test('an off-domain link in a listing page is still caught by the allowlist', async () => {
  const { parseHtmlList } = await import('./fetchers.mjs');
  const items = parseHtmlList(fx('listing-page.html'), { link_pattern: '/guidance/' }, 'https://ico.org.uk/x');
  const mirror = items.find((i) => i.url.includes('third-party.example.com'));
  assert.ok(mirror, 'fixture should include an off-domain link matching the pattern');
  assert.equal(domainAllowed(mirror.url, ['ico.org.uk']), false);
});

test('discover finds an advertised feed', async () => {
  const { findFeedLinks } = await import('./fetchers.mjs');
  const feeds = findFeedLinks(fx('listing-with-feed.html'), 'https://example.org/news');
  assert.equal(feeds.length, 1);
  assert.equal(feeds[0].url, 'https://example.org/news/rss');
  assert.equal(findFeedLinks(fx('listing-page.html'), 'https://ico.org.uk/x').length, 0,
    'text/html alternates are not feeds');
});

test('discover ranks link patterns by how many links they cover', async () => {
  const { linkPatterns } = await import('./discover.mjs');
  const { parseHtmlList } = await import('./fetchers.mjs');
  const items = parseHtmlList(fx('listing-page.html'), {}, 'https://ico.org.uk/for-organisations/');
  const pats = linkPatterns(items, 'https://ico.org.uk/for-organisations/');
  assert.equal(pats[0].pattern, '/guidance/');
  assert.equal(pats[0].count, 4);
  assert.ok(!pats.some((p) => p.pattern.includes('third-party')), 'off-domain links excluded');
});

test('sample data is marked so it can never reach a real run', () => {
  const src = readFileSync(join(HERE, 'sample.mjs'), 'utf8');
  assert.match(src, /sample_data: true/, 'sample generator must mark its output');

  const scan = readFileSync(join(HERE, 'scan.mjs'), 'utf8');
  assert.match(scan, /if \(log\.sample_data\)/, 'scan must clear sample records');

  const issues = readFileSync(join(HERE, 'issues.mjs'), 'utf8');
  assert.match(issues, /if \(log\.sample_data\)/, 'issues must refuse to run on sample data');
});

// ---- v0.5: QA remediation. One test per finding, named for the finding. ----

test('C1: coverage statement names what is not covered', async () => {
  const { buildCoverage } = await import('./scan.mjs');
  const reg = JSON.parse(readFileSync(join(HERE, 'sources.json'), 'utf8'));
  const c = buildCoverage(reg, '2026-07-24T07:00:00Z');
  assert.ok(c.not_covered.length > 0, 'fixture register has unverified sources');
  assert.match(c.statement, /does NOT currently cover/);
  for (const n of c.not_covered) {
    assert.ok(c.statement.includes(n.publisher), `${n.publisher} must appear in the statement`);
    assert.ok(n.reason && n.reason.length > 5, `${n.publisher} must carry a reason`);
  }
  assert.equal(c.monitoring_since, '2026-07-24T07:00:00Z');
});

test('C2: commencement milestones fire once each, soonest first', async () => {
  const { dueMilestone, daysUntil, upcoming } = await import('./diary.mjs');
  const now = new Date('2026-07-25T00:00:00Z');
  assert.equal(daysUntil('2026-10-01', now), 68);

  const rec = { date_in_force: '2026-10-01', commencement_alerts: [] };
  assert.equal(dueMilestone(rec, now), 90, '68 days out falls inside the 90 day milestone');
  rec.commencement_alerts.push({ milestone: 90 });
  assert.equal(dueMilestone(rec, now), null, 'does not fire twice');

  const near = { date_in_force: '2026-07-28', commencement_alerts: [] };
  assert.equal(dueMilestone(near, now), 7, 'closest unfired milestone wins, not all of them');

  assert.equal(dueMilestone({ date_in_force: '2020-01-01', commencement_alerts: [] }, now), null, 'past dates ignored');
  assert.equal(dueMilestone({ date_in_force: null }, now), null);
});

test('C2: upcoming view is sorted and excludes past dates', async () => {
  const { upcoming } = await import('./diary.mjs');
  const now = new Date('2026-07-25T00:00:00Z');
  const list = upcoming([
    { record_id: 'a', date_in_force: '2026-12-01' },
    { record_id: 'b', date_in_force: '2026-08-01' },
    { record_id: 'c', date_in_force: '2020-01-01' },
    { record_id: 'd', date_in_force: null }
  ], now);
  assert.deepEqual(list.map((r) => r.record_id), ['b', 'a']);
  assert.ok(list[0].days_until < list[1].days_until);
});

test('C3: a rewritten body with unchanged metadata is now detected', async () => {
  const { metaHash, bodyHash, stripToText } = await import('./scan.mjs');
  const item = { title: 'AI and data protection', date_published: '2026-01-10', date_updated: '2026-01-10', summary: null };
  assert.equal(metaHash(item), metaHash({ ...item }), 'metadata hash still stable');

  const before = bodyHash(stripToText('<p>The guidance says one thing.</p>'));
  const after  = bodyHash(stripToText('<p>The guidance now says something quite different.</p>'));
  assert.notEqual(before, after, 'body hash must move when the body moves');
});

test('C3: summary is now part of the metadata hash', async () => {
  const { metaHash } = await import('./scan.mjs');
  const base = { title: 'X', date_published: '2026-01-01', date_updated: '2026-01-01' };
  assert.notEqual(metaHash({ ...base, summary: 'one' }), metaHash({ ...base, summary: 'two' }));
});

test('C3: body hashing ignores whitespace and case churn', async () => {
  const { bodyHash } = await import('./scan.mjs');
  assert.equal(bodyHash('The  Guidance\n\nSays'), bodyHash('the guidance says'));
});

test('C4: "+1" can no longer become the audit record', async () => {
  const { decisionFromComments, parseDecision } = await import('./decision.mjs');
  assert.equal(parseDecision('+1'), null);
  assert.equal(parseDecision('Looks fine to me'), null);

  const thread = [
    { user: { type: 'User', login: 'kim' }, body: '```decision\nDECISION: no-change\nNOTE: Already reflected in the DPIA template at section 4.\n```' },
    { user: { type: 'User', login: 'sam' }, body: '+1' },
    { user: { type: 'Bot', login: 'bot' }, body: 'automated note' }
  ];
  const d = decisionFromComments(thread);
  assert.equal(d.decision, 'no-change');
  assert.equal(d.author, 'kim');
  assert.ok(d.valid);
});

test('C4: a later decision supersedes an earlier one, ordinary comments do not', async () => {
  const { decisionFromComments } = await import('./decision.mjs');
  const d = decisionFromComments([
    { user: { type: 'User', login: 'a' }, body: '```decision\nDECISION: no-change\nNOTE: Nothing to do here at all.\n```' },
    { user: { type: 'User', login: 'b' }, body: 'hmm, actually' },
    { user: { type: 'User', login: 'c' }, body: '```decision\nDECISION: change-required\nARTEFACTS: DPIA Template\nNOTE: On reflection the template needs a new question.\n```' }
  ]);
  assert.equal(d.decision, 'change-required');
  assert.equal(d.author, 'c');
});

test('C4: malformed decisions are rejected with reasons, not silently accepted', async () => {
  const { parseDecision } = await import('./decision.mjs');

  const badVerb = parseDecision('```decision\nDECISION: maybe\nNOTE: not sure about this one\n```');
  assert.equal(badVerb.valid, false);
  assert.match(badVerb.errors.join(' '), /DECISION must be one of/);

  const noNote = parseDecision('```decision\nDECISION: no-change\n```');
  assert.equal(noNote.valid, false);
  assert.match(noNote.errors.join(' '), /NOTE is required/);

  const vague = parseDecision('```decision\nDECISION: change-required\nNOTE: something needs changing\n```');
  assert.equal(vague.valid, false);
  assert.match(vague.errors.join(' '), /must name at least one SECTION or ARTEFACT/);

  const badDate = parseDecision('```decision\nDECISION: no-change\nIN-FORCE: next October\nNOTE: nothing to do for now\n```');
  assert.equal(badDate.valid, false);
  assert.match(badDate.errors.join(' '), /IN-FORCE must be YYYY-MM-DD/);
});

test('C4: an unfenced decision block is still accepted', async () => {
  const { parseDecision } = await import('./decision.mjs');
  const d = parseDecision('DECISION: already-covered\nNOTE: The register already records this system.');
  assert.ok(d && d.valid, 'forgetting the backticks should not lose the decision');
});

test('M4: record identifiers come from a counter, not array length', async () => {
  const { nextRecordId } = await import('./scan.mjs');
  const log = { next_record_id: 1, records: [] };
  const a = nextRecordId(log); log.records.push({ record_id: a });
  const b = nextRecordId(log); log.records.push({ record_id: b });
  const c = nextRecordId(log); log.records.push({ record_id: c });
  assert.deepEqual([a, b, c], ['REG-0001', 'REG-0002', 'REG-0003']);

  log.records.splice(1, 1);              // the deletion that used to cause a collision
  const d = nextRecordId(log);
  assert.equal(d, 'REG-0004');
  assert.ok(!log.records.some((r) => r.record_id === d), 'must not collide with a surviving record');
});

test('M5: reviewer authority is resolved from the register, not assumed', async () => {
  const { authorityFor } = await import('./decision.mjs');
  const reviewers = JSON.parse(readFileSync(join(HERE, 'reviewers.json'), 'utf8'));
  assert.ok(reviewers.reviewers.length, 'at least one reviewer must be configured');

  const known = authorityFor(reviewers.reviewers[0].github, reviewers);
  assert.equal(known.known, true);
  assert.ok(known.role, 'a known reviewer must have a role');

  const stranger = authorityFor('random-person', reviewers);
  assert.equal(stranger.known, false);
  assert.equal(stranger.can_approve, false, 'unknown closers must never be able to approve');
});

test('m1: a collapse in item count is detected', async () => {
  const { detectCollapse } = await import('./scan.mjs');
  const runlog = { runs: Array.from({ length: 6 }, () => ({ sources: [{ id: 's1', items_seen: 50 }] })) };
  assert.ok(detectCollapse('s1', 2, runlog), '50 down to 2 must be flagged');
  assert.equal(detectCollapse('s1', 48, runlog), null, 'normal variation must not be flagged');
  assert.equal(detectCollapse('s1', 10, { runs: [] }), null, 'no history means no judgement');
});

test('M2: the run log records outcome even when nothing was found', () => {
  const src = readFileSync(join(HERE, 'scan.mjs'), 'utf8');
  assert.match(src, /Monitored\. No changes arising\./, 'a nil return must be a positive record');
  assert.match(src, /runlog\.runs\.push/);
});

test('M7: the run log is the heartbeat, so the monitor cannot go quiet', () => {
  const src = readFileSync(join(HERE, 'scan.mjs'), 'utf8');
  assert.match(src, /runlog\.runs\.push/, 'every run must be recorded, including nil returns');
  assert.match(src, /Monitored\. No changes arising\./, 'a nil return must still be a positive record');
});

test('no sample file can survive into a real run', () => {
  const sample = readFileSync(join(HERE, 'sample.mjs'), 'utf8');
  const marks = (sample.match(/sample_data: true/g) || []).length;
  assert.ok(marks >= 4, `every sample file must be marked; found ${marks}`);

  const scan = readFileSync(join(HERE, 'scan.mjs'), 'utf8');
  assert.match(scan, /runlog\.sample_data/, 'the run log carries the evidential claim and must be cleared');
  assert.match(scan, /discards\.sample_data/);

  const issues = readFileSync(join(HERE, 'issues.mjs'), 'utf8');
  const diary  = readFileSync(join(HERE, 'diary.mjs'), 'utf8');
  assert.match(issues, /log\.sample_data/, 'issues must refuse to run on sample data');
  assert.match(diary,  /log\.sample_data/, 'diary must refuse to raise issues on sample data');
});

// ---- v0.6: Ombudsman and ICO connected ----

test('listing pages: summary and date are lifted from beside the link', async () => {
  const { parseHtmlList, parseLooseDate } = await import('./fetchers.mjs');
  const html = '<ul><li><a href="/decisions/housing/homelessness/25-006-248">South Gloucestershire Council (25 006 248)</a>' +
               '<p>Report Upheld Homelessness 27-Apr-2026 Summary: The Council made an unsuitable automatic offer.</p></li></ul>';
  const [item] = parseHtmlList(html, { link_pattern: '/decisions/', summary_from: 'parent' }, 'https://www.lgo.org.uk/decisions/housing');
  assert.match(item.summary, /automatic offer/);
  assert.equal(item.date_published, '2026-04-27');
  assert.ok(!item.summary.includes('South Gloucestershire Council (25 006 248)'), 'link text must not be duplicated into the summary');
});

test('loose dates are parsed or refused, never guessed', async () => {
  const { parseLooseDate } = await import('./fetchers.mjs');
  assert.equal(parseLooseDate('27-Apr-2026'), '2026-04-27');
  assert.equal(parseLooseDate('issued 27 April 2026 by'), '2026-04-27');
  assert.equal(parseLooseDate('2026-04-27'), '2026-04-27');
  assert.equal(parseLooseDate('sometime last spring'), null);
  assert.equal(parseLooseDate('27-Xyz-2026'), null, 'an unrecognised month must not be guessed');
  assert.equal(parseLooseDate(null), null);
});

test('an Ombudsman decision with no automation angle is discarded, one with is kept', async () => {
  const { parseHtmlList } = await import('./fetchers.mjs');
  const { passesRelevanceGate } = await import('./scan.mjs');
  const mk = (summary) => '<li><a href="/decisions/housing/homelessness/25-000-001">A Council (25 000 001)</a><p>Statement Upheld Homelessness 21-Apr-2026 Summary: ' + summary + '</p></li>';

  const [noisy] = parseHtmlList(mk('The Council delayed responding to correspondence.'), { link_pattern: '/decisions/', summary_from: 'parent' }, 'https://www.lgo.org.uk/x');
  assert.equal(passesRelevanceGate(noisy, mappings), false, 'ordinary delay complaints must not flood the queue');

  const [relevant] = parseHtmlList(mk('The Council used an automated decision tool to assess priority banding.'), { link_pattern: '/decisions/', summary_from: 'parent' }, 'https://www.lgo.org.uk/x');
  assert.equal(passesRelevanceGate(relevant, mappings), true);
});

test('the Ombudsman link pattern matches decisions and not category pages', () => {
  const reg = JSON.parse(readFileSync(join(HERE, 'sources.json'), 'utf8'));
  const src = reg.sources.find((s) => s.id === 'lgsco-housing');
  assert.ok(src, 'lgsco-housing must be configured');
  assert.equal(src.verification_status, 'verified');
  const re = new RegExp(src.link_pattern, 'i');
  assert.ok(re.test('https://www.lgo.org.uk/decisions/housing/homelessness/25-006-248'));
  assert.ok(!re.test('https://www.lgo.org.uk/decisions/housing'), 'category pages are not decisions');
  assert.ok(!re.test('https://www.lgo.org.uk/decisions/housing/allocations'), 'subcategory pages are not decisions');
});

test('the ICO entry records that the publisher withdrew its feeds', () => {
  const reg = JSON.parse(readFileSync(join(HERE, 'sources.json'), 'utf8'));
  const ico = reg.sources.find((s) => s.id === 'ico-news');
  assert.ok(ico);
  assert.match(ico.scope + ico.verify_note, /RSS/i, 'why scraping is necessary must be on the record');
  assert.equal(ico.type, 'html-list');
});


// ---- v0.7: stable legislative EffectId identity ----

test('legislation changes use EffectId as the stable item identity', async () => {
  const { parseAtomChanges } = await import('./fetchers.mjs');
  const { itemIdentityKey } = await import('./scan.mjs');
  const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:ukm="http://www.legislation.gov.uk/namespaces/metadata"><entry><id>https://www.legislation.gov.uk/changes/affected/ukpga/2010/15/1</id><title>Effect one</title><content><ukm:Effect Id="effect-123" Type="amendment" AffectedURI="https://www.legislation.gov.uk/ukpga/2010/15/section/149" /></content></entry></feed>`;
  const [item] = parseAtomChanges(xml);
  assert.equal(item.effect_id, 'effect-123');
  assert.equal(item.raw_id, 'effect-123');
  assert.equal(itemIdentityKey({ id: 'statute-equality-2010', type: 'atom-changes' }, item), 'statute-equality-2010::effect-123');
});

test('two effects against the same provision remain separate records', async () => {
  const { itemIdentityKey } = await import('./scan.mjs');
  const source = { id: 'statute-equality-2010', type: 'atom-changes' };
  const url = 'https://www.legislation.gov.uk/ukpga/2010/15/section/149';
  assert.notEqual(
    itemIdentityKey(source, { effect_id: 'effect-A', raw_id: 'effect-A', url }),
    itemIdentityKey(source, { effect_id: 'effect-B', raw_id: 'effect-B', url })
  );
});

test('legacy legislative state triggers the Phase 1 safety stop', async () => {
  const { assertStateIdentityVersion } = await import('./scan.mjs');
  const state = { items: { 'statute-equality-2010::https://www.legislation.gov.uk/ukpga/2010/15/section/149': { hash: 'x' } } };
  assert.throws(
    () => assertStateIdentityVersion(state, { sources: [{ id: 'statute-equality-2010', type: 'atom-changes' }] }),
    /STATE IDENTITY SAFETY STOP/
  );
});
