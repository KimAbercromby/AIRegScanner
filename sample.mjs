#!/usr/bin/env node
/**
 * Writes sample records so the viewer can be checked before the first real run.
 * `npm run sample:clear` removes them. Never run this against a live log.
 */
import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const clear = process.argv.includes('--clear');

const empty = { log_version: '0.1', playbook_version: 'v19', records: [] };

const sample = {
  log_version: '0.1',
  playbook_version: 'v19',
  sample_data: true,
  records: [
    {
      record_id: 'REG-0001',
      event: 'new',
      source_id: 'legislation-new',
      publisher: 'The National Archives (legislation.gov.uk)',
      tier: 1,
      title: 'The Automated Decision-Making (Public Authorities) Regulations 2026',
      url: 'https://www.legislation.gov.uk/uksi/2026/412',
      date_published: '2026-07-22T11:00:00+01:00',
      date_in_force: null,
      date_retrieved: '2026-07-24T07:00:12.000Z',
      content_hash: 'a1b2c3d4e5f60718',
      topics: ['adm-article-22'],
      reference_only: false,
      affects_sections: ['3.10.1', '4.4.6'],
      affects_artefacts: ['AI Register', 'DPIA Template', 'Decision Record', 'RAIA'],
      status: 'unreviewed',
      issue_number: null,
      reviewed_by: null,
      reviewed_at: null,
      outcome: null,
      generated: null
    },
    {
      record_id: 'REG-0002',
      event: 'new',
      source_id: 'legislation-changes-dpa2018',
      publisher: 'The National Archives (legislation.gov.uk)',
      tier: 1,
      title: 'Data (Use and Access) Act 2025 effect on Data Protection Act 2018',
      url: 'https://www.legislation.gov.uk/id/ukpga/2018/12',
      date_published: '2026-02-05T10:00:00Z',
      date_in_force: '2026-02-05',
      date_retrieved: '2026-07-24T07:00:14.000Z',
      content_hash: 'f00ba7de4dbeef01',
      topics: ['adm-article-22'],
      reference_only: false,
      affects_sections: ['3.10.1', '4.4.6'],
      affects_artefacts: ['AI Register', 'DPIA Template', 'Decision Record', 'RAIA'],
      status: 'reviewed',
      issue_number: 12,
      reviewed_by: 'KA',
      reviewed_at: '2026-07-24T14:10:00Z',
      outcome: 'no change needed: already reflected in DPIA template s.4',
      generated: null
    },
    {
      record_id: 'REG-0003',
      event: 'changed',
      source_id: 'govuk-gds',
      publisher: 'Government Digital Service (via GOV.UK Search API)',
      tier: 2,
      title: 'Algorithmic Transparency Recording Standard hub',
      url: 'https://www.gov.uk/government/collections/algorithmic-transparency-recording-standard-hub',
      date_published: '2026-07-23T09:15:00.000+01:00',
      date_in_force: null,
      date_retrieved: '2026-07-24T07:00:18.000Z',
      content_hash: '9c8d7e6f5a4b3c2d',
      topics: ['transparency-atrs'],
      reference_only: false,
      affects_sections: ['3.11', '3.8'],
      affects_artefacts: ['ATRS Record', 'AI Register', 'Reporting Templates'],
      status: 'unreviewed',
      issue_number: null,
      reviewed_by: null,
      reviewed_at: null,
      outcome: null,
      generated: {
        model: 'claude-sonnet-4-6',
        generated_at: '2026-07-24T07:02:00.000Z',
        ok: true,
        source_chars_used: 4120,
        relevant: true,
        relevance_reason: 'The retrieved text describes the transparency recording standard and lists published records.',
        summary: 'A collection page for the algorithmic transparency recording standard and the records published against it. The retrieved text does not state whether the scope has changed.',
        agreed_sections: ['3.8'],
        note: 'The page was updated but the retrieved text does not show what changed. Compare against the previous version before deciding.',
        disclaimer: 'Generated content. Not part of the record. Never act on this without reading the source.'
      }
    },
    {
      record_id: 'REG-0005',
      event: 'new',
      source_id: 'statute-housing-1996',
      publisher: 'The National Archives (legislation.gov.uk)',
      tier: 1,
      title: 'Homelessness (Review Procedure) Amendment Regulations 2026 effect on Housing Act 1996',
      url: 'https://www.legislation.gov.uk/id/ukpga/1996/52',
      date_published: '2026-07-18T00:00:00Z',
      date_in_force: '2026-10-01',
      date_retrieved: '2026-07-24T07:00:22.000Z',
      content_hash: 'aabbccddeeff0011',
      topics: ['local-government', 'adm-article-22'],
      reference_only: false,
      affects_sections: ['3.10.1', '3.8', '4.4.6'],
      affects_artefacts: ['AI Register', 'DPIA Template', 'Decision Record', 'Intake Form', 'RAIA', 'Terms of Reference'],
      status: 'unreviewed',
      issue_number: null,
      reviewed_by: null,
      reviewed_at: null,
      outcome: null,
      generated: null
    },
    {
      record_id: 'REG-0006',
      event: 'new',
      source_id: 'legislation-search-ai-title',
      publisher: 'The National Archives (legislation.gov.uk)',
      tier: 1,
      title: 'EU AI Act harmonised standards: UK market implications',
      url: 'https://www.legislation.gov.uk/uksi/2026/399',
      date_published: '2026-07-16T00:00:00Z',
      date_in_force: null,
      date_retrieved: '2026-07-24T07:00:24.000Z',
      content_hash: '2233445566778899',
      topics: ['eu-ai-act'],
      reference_only: true,
      affects_sections: [],
      affects_artefacts: [],
      status: 'unreviewed',
      issue_number: null,
      reviewed_by: null,
      reviewed_at: null,
      outcome: null,
      generated: null
    },
    {
      record_id: 'REG-0004',
      event: 'new',
      source_id: 'govuk-cabinet-office',
      publisher: 'Cabinet Office (via GOV.UK Search API)',
      tier: 2,
      title: 'Machinery of government changes: July 2026',
      url: 'https://www.gov.uk/government/publications/machinery-of-government-changes-july-2026',
      date_published: '2026-07-21T13:00:00.000+01:00',
      date_in_force: null,
      date_retrieved: '2026-07-24T07:00:20.000Z',
      content_hash: '1122334455667788',
      topics: [],
      reference_only: false,
      affects_sections: [],
      affects_artefacts: [],
      status: 'unreviewed',
      issue_number: null,
      reviewed_by: null,
      reviewed_at: null,
      outcome: null,
      generated: null
    }
  ]
};

const health = {
  sample_data: true,
  run_at: '2026-07-24T07:00:00.000Z',
  register_version: '0.1',
  sources: [
    { id: 'legislation-new', status: 'ok', http_status: 200, items_seen: 100, items_kept: 1 },
    { id: 'legislation-changes-dpa2018', status: 'ok', http_status: 200, items_seen: 42, items_kept: 1 },
    { id: 'govuk-gds', status: 'ok-but-empty', http_status: 200, items_seen: 0, items_kept: 0, note: 'Responded 200 but returned no items. Check the endpoint still points where you think it does.' },
    { id: 'statute-care-2014', status: 'skipped-unverified', note: 'Run `npm run resolve` to have legislation.gov.uk confirm the chapter number.', items_seen: 0, items_kept: 0 },
    { id: 'lgsco-decisions', status: 'skipped-unverified', note: 'Highest-value missing source. Needs a feed URL or the html-diff fetcher.', items_seen: 0, items_kept: 0 }
  ],
  rejects: [
    { source: 'legislation-new', reason: 'domain-not-allowed', url: 'https://malicious-mirror.example.com/uksi/2026/410', title: 'The Public Sector Algorithmic Transparency Regulations 2026' }
  ],
  register_review_due: '2026-10-22',
  register_review_overdue: false,
  mode: 'normal',
  summary: { added: 5, changed: 1, absorbed: 0, unreviewed: 5 }
};

const sampleRunLog = {
  sample_data: true,
  runs: [{
    run_at: '2026-07-25T07:00:00Z', mode: 'normal', register_version: '0.2',
    sources_checked: 20, sources_skipped: 7, sources_failed: 1, items_seen: 214,
    added: 3, changed: 1, absorbed: 0, discarded: 86,
    outcome: '3 new, 1 changed.', sources: []
  }]
};

const sampleDiary = {
  sample_data: true,
  generated_at: '2026-07-25T07:00:00Z', within_30_days: 1, within_90_days: 2,
  upcoming: [
    { record_id: 'REG-0005', title: 'Homelessness (Review Procedure) Amendment Regulations 2026',
      url: 'https://www.legislation.gov.uk/id/ukpga/1996/52', publisher: 'The National Archives',
      date_in_force: '2026-08-14', days_until: 20, affects_sections: ['3.10.1'],
      affects_artefacts: ['AI Register'], status: 'reviewed', decision: 'change-required' },
    { record_id: 'REG-0001', title: 'The Automated Decision-Making (Public Authorities) Regulations 2026',
      url: 'https://www.legislation.gov.uk/uksi/2026/412', publisher: 'The National Archives',
      date_in_force: '2026-10-01', days_until: 68, affects_sections: ['3.10.1'],
      affects_artefacts: ['DPIA Template'], status: 'unreviewed', decision: null }
  ]
};

mkdirSync(ROOT, { recursive: true });
const SAMPLE_FILES = ['impact-log.json', 'health.json', 'run-log.json', 'diary.json', 'coverage.json'];

if (clear) {
  writeFileSync(join(ROOT, 'impact-log.json'), JSON.stringify(empty, null, 2) + '\n');
  for (const f of SAMPLE_FILES.slice(1)) {
    try { unlinkSync(join(ROOT, f)); } catch { /* already gone */ }
  }
  console.log('Sample records cleared.');
} else {
  writeFileSync(join(ROOT, 'run-log.json'), JSON.stringify(sampleRunLog, null, 2) + '\n');
  writeFileSync(join(ROOT, 'diary.json'), JSON.stringify(sampleDiary, null, 2) + '\n');
  writeFileSync(join(ROOT, 'impact-log.json'), JSON.stringify(sample, null, 2) + '\n');
  writeFileSync(join(ROOT, 'health.json'), JSON.stringify(health, null, 2) + '\n');
  console.log('Sample data written. Run `npm run sample:clear` before the first real scan.');
}
