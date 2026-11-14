#!/usr/bin/env node
/**
 * Records ONE human decision against a whole group of unreviewed records.
 *
 * The reviewer (not this script) makes the judgement. They write it once per
 * group in bulk-decisions.json; this script stamps it onto every matching
 * record, with their name, role and authority, and closes the GitHub issues.
 *
 *   node bulk-decide.mjs --preview   counts per group, writes nothing, no network
 *   node bulk-decide.mjs             applies the decided groups
 *
 * A group with "decision": null is left alone and listed as undecided.
 * Nothing is deleted. Every affected record keeps a bulk_group marker so the
 * audit trail shows the decision was made once for the group.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDecision, authorityFor } from './decision.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const LOG = join(ROOT, 'impact-log.json');
const CONFIG = join(ROOT, 'bulk-decisions.json');
const REVIEWERS = join(ROOT, 'reviewers.json');

const API = 'https://api.github.com';
const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const MAX_ISSUES = Number(process.env.BULK_MAX_ISSUES ?? 300);

// ---------- pure logic (tested offline) ----------

function blockFor(group) {
  const lines = ['```decision', `DECISION: ${group.decision}`];
  if ((group.sections || []).length) lines.push(`SECTIONS: ${group.sections.join(', ')}`);
  if ((group.artefacts || []).length) lines.push(`ARTEFACTS: ${group.artefacts.join(', ')}`);
  if (group.in_force) lines.push(`IN-FORCE: ${group.in_force}`);
  lines.push(`NOTE: ${group.note ?? ''}`, '```');
  return lines.join('\n');
}

export function groupMatches(group, rec) {
  if (rec.status !== 'unreviewed') return false;
  if (group.source_id && rec.source_id !== group.source_id) return false;
  if (group.title_equals && rec.title !== group.title_equals) return false;
  return true;
}

/**
 * Works out what applying the config would do, and applies it to `records`
 * unless preview is true. Returns a report; never touches the network.
 */
export function applyBulkDecisions(records, config, reviewers, { preview = false, now = new Date().toISOString() } = {}) {
  const report = { groups: [], applied: [], undecided: 0, errors: [] };
  const groups = config.groups ?? [];
  const who = config.decided_by;
  const auth = authorityFor(who, reviewers);

  if (!who || !auth.known) {
    report.errors.push(`decided_by "${who ?? ''}" is not listed in reviewers.json. A bulk decision must name a known reviewer.`);
    return report;
  }

  for (const g of groups) {
    if (!g.id) report.errors.push('A group has no id.');
    if (!g.source_id && !g.title_equals) report.errors.push(`Group ${g.id}: needs source_id or title_equals, otherwise it would match everything.`);
  }
  if (report.errors.length) return report;

  // A record must belong to at most one group. Overlap is a config error,
  // never a silent first-match-wins.
  const owner = new Map();
  for (const g of groups) {
    for (const rec of records) {
      if (!groupMatches(g, rec)) continue;
      if (owner.has(rec.record_id)) {
        report.errors.push(`Record ${rec.record_id} matches both ${owner.get(rec.record_id)} and ${g.id}. Make the groups narrower.`);
      } else owner.set(rec.record_id, g.id);
    }
  }
  if (report.errors.length) return report;

  for (const g of groups) {
    const matched = records.filter((r) => groupMatches(g, r));
    const row = { id: g.id, label: g.label ?? '', matched: matched.length, expected: g.expect_count ?? null, state: '' };

    if (!g.decision) { row.state = 'undecided'; report.undecided += 1; report.groups.push(row); continue; }

    const parsed = parseDecision(blockFor(g));
    if (!parsed || !parsed.valid) {
      row.state = 'invalid decision';
      report.errors.push(`Group ${g.id}: ${(parsed?.errors ?? ['not a decision']).join(' ')}`);
      report.groups.push(row);
      continue;
    }
    if (g.expect_count != null && matched.length !== g.expect_count) {
      row.state = 'skipped: count changed';
      report.errors.push(`Group ${g.id}: expected ${g.expect_count} records but found ${matched.length}. Refresh expect_count after looking at what is new.`);
      report.groups.push(row);
      continue;
    }
    if (!matched.length) { row.state = 'nothing to do'; report.groups.push(row); continue; }

    row.state = preview ? 'would apply' : 'applied';
    report.groups.push(row);
    if (preview) continue;

    for (const rec of matched) {
      const flagsChange = !rec.reference_only && (rec.affects_artefacts || []).length > 0;
      rec.status = 'reviewed';
      rec.decision = parsed.decision;
      rec.decision_valid = true;
      rec.decision_authorised = flagsChange ? auth.can_approve : true;
      rec.reviewed_by = who;
      rec.reviewed_by_role = auth.role ?? null;
      rec.reviewed_at = now;
      rec.outcome = parsed.note;
      if (parsed.sections.length) rec.decided_sections = parsed.sections;
      if (parsed.artefacts.length) rec.decided_artefacts = parsed.artefacts;
      if (parsed.in_force && !rec.date_in_force) rec.date_in_force = parsed.in_force;
      rec.bulk_group = g.id;
      report.applied.push({ record: rec, group: g });
    }
  }
  return report;
}

// ---------- GitHub (apply mode only) ----------

async function gh(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'ai-reg-scanner'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { ok: res.ok, status: res.status };
}

async function closeIssues(applied, who) {
  const withIssue = applied.filter((a) => a.record.issue_number);
  let closed = 0, stopped = false;
  for (const { record, group } of withIssue.slice(0, MAX_ISSUES)) {
    const body = `Recorded in bulk by ${who} for group \`${group.id}\`${group.label ? ` (${group.label})` : ''}. One decision was made for every record in the group.\n\n${blockFor(group)}`;
    const c = await gh(`/repos/${REPO}/issues/${record.issue_number}/comments`, { method: 'POST', body: { body } });
    if (!c.ok) { stopped = c.status === 403 || c.status === 429; if (stopped) break; continue; }
    const p = await gh(`/repos/${REPO}/issues/${record.issue_number}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
    if (!p.ok) { stopped = p.status === 403 || p.status === 429; if (stopped) break; continue; }
    closed += 1;
    await new Promise((r) => setTimeout(r, 400));
  }
  const left = withIssue.length - closed;
  return { closed, left, stopped };
}

// ---------- main ----------

async function main() {
  const preview = process.argv.includes('--preview');
  if (!existsSync(CONFIG)) { console.log('No bulk-decisions.json found.'); return; }
  const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
  const reviewers = existsSync(REVIEWERS) ? JSON.parse(readFileSync(REVIEWERS, 'utf8')) : { reviewers: [] };
  const log = JSON.parse(readFileSync(LOG, 'utf8'));

  const report = applyBulkDecisions(log.records, config, reviewers, { preview });

  console.log(preview ? '### Bulk decisions: PREVIEW (nothing written)' : '### Bulk decisions');
  console.log('');
  console.log('| Group | Records | Expected | State |');
  console.log('|---|---|---|---|');
  for (const g of report.groups) console.log(`| ${g.id} ${g.label} | ${g.matched} | ${g.expected ?? ''} | ${g.state} |`);
  console.log('');
  if (report.errors.length) {
    console.log('Problems:');
    for (const e of report.errors) console.log(`- ${e}`);
  }
  console.log(`${report.undecided} group(s) still undecided.`);

  if (preview) return;
  if (!report.applied.length) { console.log('Nothing applied.'); if (report.errors.length) process.exit(1); return; }

  // Decisions are saved first, so a GitHub failure cannot lose them.
  writeFileSync(LOG, JSON.stringify(log, null, 2) + '\n');
  console.log(`${report.applied.length} record(s) decided and saved.`);

  if (!TOKEN || !REPO) { console.log('No GitHub token here, so issues were not closed. The next scan closes them.'); return; }
  const r = await closeIssues(report.applied, config.decided_by);
  console.log(`${r.closed} issue(s) commented on and closed.`);
  if (r.left) console.log(`${r.left} issue(s) still open${r.stopped ? ' (GitHub rate limit reached)' : ' (per-run cap)'}. The daily scan closes them over the next runs, or run this task again.`);
  if (report.errors.length) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
