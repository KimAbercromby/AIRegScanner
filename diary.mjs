#!/usr/bin/env node
/**
 * Commencement diary.
 *
 * QA C2. In-force dates were extracted, displayed, and then never acted on. A
 * measure published today and in force in twelve months was reviewed, closed
 * and forgotten. The question a compliance function is actually asked is not
 * "what was published" but "what bites next quarter".
 *
 * This raises a fresh issue as commencement approaches, at 90, 30 and 7 days,
 * and on the day. Separate from the review issue, because the review is done;
 * this is about readiness.
 *
 * Run: npm run diary   (or `npm run diary -- --dry-run`)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordIsFocused } from './scan.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const LOG = join(ROOT, 'impact-log.json');
const DIARY = join(ROOT, 'diary.json');
const SOURCES = join(ROOT, 'sources.json');
const MAPPINGS = join(ROOT, 'mappings.json');

const API = 'https://api.github.com';
const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;

export const MILESTONES = [90, 30, 7, 0];

export function daysUntil(dateStr, now = new Date()) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  if (isNaN(d)) return null;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Math.round((d - today) / 86400000);
}

/**
 * Which milestone, if any, is due for this record now. Only the closest
 * not-yet-alerted milestone fires, so a record picked up late does not raise
 * four issues at once.
 */
export function dueMilestone(rec, now = new Date()) {
  if (!rec.date_in_force) return null;
  const days = daysUntil(rec.date_in_force, now);
  if (days === null || days < 0) return null;
  const already = new Set((rec.commencement_alerts ?? []).map((a) => a.milestone));
  const due = MILESTONES.filter((m) => days <= m && !already.has(m));
  return due.length ? Math.min(...due) : null;
}

/** Everything with a future commencement, soonest first. Drives the viewer. */
export function upcoming(records, now = new Date(), include = () => true) {
  return records
    .filter((r) => include(r) && r.date_in_force && daysUntil(r.date_in_force, now) !== null && daysUntil(r.date_in_force, now) >= 0)
    .map((r) => ({
      record_id: r.record_id,
      title: r.title,
      url: r.url,
      publisher: r.publisher,
      date_in_force: String(r.date_in_force).slice(0, 10),
      days_until: daysUntil(r.date_in_force, now),
      affects_sections: r.affects_sections ?? [],
      affects_artefacts: r.affects_artefacts ?? [],
      status: r.status,
      decision: r.decision ?? null
    }))
    .sort((a, b) => a.days_until - b.days_until);
}

export function diaryIssueBody(rec, milestone) {
  const when = milestone === 0 ? 'today' : `in ${milestone} days`;
  return [
    `**${rec.title}** comes into force ${when}, on **${String(rec.date_in_force).slice(0, 10)}**.`,
    '',
    rec.url,
    '',
    `Publisher: ${rec.publisher}  ·  original record: \`${rec.record_id}\``,
    rec.issue_number ? `Review issue: #${rec.issue_number}` : '',
    '',
    (rec.affects_artefacts ?? []).length
      ? `Flagged against: ${rec.affects_artefacts.map((a) => `\`${a}\``).join(' ')}`
      : 'No artefacts were flagged when this was reviewed.',
    rec.outcome ? `\nRecorded decision at review: ${rec.outcome}` : '',
    '',
    '### Readiness check',
    '- [ ] Any artefact changes agreed at review have actually been made',
    '- [ ] Affected services know',
    '- [ ] Anything live and in scope has been re-checked against the new position',
    '- [ ] The register reflects it',
    '',
    '---',
    '<sub>Raised by the commencement diary. Closing this does not change the original review record.</sub>'
  ].filter((l) => l !== '').join('\n');
}

async function gh(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', 'User-Agent': 'ai-reg-scanner'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  return { ok: res.ok, status: res.status, json, text };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (!existsSync(LOG)) { console.log('No impact log yet.'); return; }

  const log = JSON.parse(readFileSync(LOG, 'utf8'));
  if (log.sample_data) { console.log('Sample data present. Refusing to raise diary issues.'); return; }
  const sources = JSON.parse(readFileSync(SOURCES, 'utf8'));
  const mappings = JSON.parse(readFileSync(MAPPINGS, 'utf8'));
  const focused = (rec) => recordIsFocused(rec, sources, mappings);

  const now = new Date();
  const list = upcoming(log.records, now, focused);

  writeFileSync(DIARY, JSON.stringify({
    generated_at: now.toISOString(),
    note: 'Measures with a future commencement date. This is the "what bites next quarter" view.',
    within_30_days: list.filter((r) => r.days_until <= 30).length,
    within_90_days: list.filter((r) => r.days_until <= 90).length,
    upcoming: list
  }, null, 2) + '\n');

  console.log(`${list.length} measure(s) with a future commencement date.`);
  for (const r of list.slice(0, 10)) console.log(`  ${String(r.days_until).padStart(4)}d  ${r.date_in_force}  ${r.title?.slice(0, 60)}`);

  if (!dryRun && (!TOKEN || !REPO)) { console.log('\nNo GitHub credentials. Diary written, no issues raised.'); return; }

  let raised = 0;
  for (const rec of log.records) {
    if (!focused(rec)) continue;
    const milestone = dueMilestone(rec, now);
    if (milestone === null) continue;

    const days = daysUntil(rec.date_in_force, now);
    const title = `[commencement] ${String(rec.date_in_force).slice(0, 10)} — ${(rec.title || rec.record_id).slice(0, 180)}`;

    if (dryRun) {
      console.log(`--- would raise (${milestone}d milestone, ${days}d out): ${title}`);
      raised += 1;
      continue;
    }

    const r = await gh(`/repos/${REPO}/issues`, {
      method: 'POST',
      body: { title, body: diaryIssueBody(rec, milestone), labels: ['reg-scan', 'commencement', `tier-${rec.tier}`] }
    });
    if (!r.ok) { console.log(`  ! could not raise diary issue for ${rec.record_id}: ${r.status}`); continue; }

    rec.commencement_alerts = [...(rec.commencement_alerts ?? []), { milestone, raised_at: now.toISOString(), issue_number: r.json.number }];
    raised += 1;
    console.log(`  diary ${rec.record_id} -> issue #${r.json.number} (${milestone}d milestone)`);
  }

  if (!dryRun && raised) writeFileSync(LOG, JSON.stringify(log, null, 2) + '\n');
  console.log(`\n${raised} commencement issue(s) raised.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
