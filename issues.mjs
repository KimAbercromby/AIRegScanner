#!/usr/bin/env node
/**
 * Turns the impact log into a review workflow using GitHub Issues.
 *
 *   unreviewed record with no issue  ->  open an issue, store its number
 *   issue closed with a decision     ->  record the decision, who made it and
 *                                        in what role
 *   issue closed without one         ->  reopened once, with the template
 *   record reviewed by hand          ->  close the issue
 *
 * Needs GITHUB_TOKEN with `issues: write` and GITHUB_REPOSITORY, both supplied
 * by Actions. Without them this exits quietly and the log is unaffected.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATE, decisionFromComments, authorityFor } from './decision.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const LOG = join(ROOT, 'impact-log.json');
const REVIEWERS = join(ROOT, 'reviewers.json');

const API = 'https://api.github.com';
const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const MAX_NEW = Number(process.env.ISSUES_MAX_NEW ?? 25);

// ---------- pure helpers (tested offline) ----------

export function issueTitle(rec) {
  const t = (rec.title || 'Untitled item').replace(/\s+/g, ' ').trim();
  const room = 240 - rec.record_id.length - 3;
  return `[${rec.record_id}] ${t.length > room ? t.slice(0, room - 1) + '\u2026' : t}`;
}

export function labelsFor(rec) {
  const labels = ['reg-scan', `tier-${rec.tier}`];
  if (rec.reference_only) labels.push('reference-only');
  else if ((rec.affects_artefacts || []).length) labels.push('flags-change');
  else labels.push('unmapped');
  if (rec.event === 'content-revised') labels.push('content-revised');
  if (rec.date_in_force) labels.push('has-commencement');
  for (const t of rec.topics || []) labels.push(`topic:${t}`);
  return [...new Set(labels)];
}

function fmt(d) {
  if (!d) return null;
  const x = new Date(d);
  return isNaN(x) ? String(d) : x.toISOString().slice(0, 10);
}

export function issueBody(rec) {
  const L = [];
  L.push(`**${rec.publisher}**  ·  tier ${rec.tier}  ·  \`${rec.source_id}\``);
  L.push('');
  L.push(rec.url);
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  L.push(`| Published | ${fmt(rec.date_published) || '—'} |`);
  L.push(`| **In force** | ${fmt(rec.date_in_force) || '**not stated in source — find it and record it below**'} |`);
  L.push(`| Retrieved | ${fmt(rec.date_retrieved) || '—'} |`);
  L.push(`| Event | ${rec.event} |`);
  L.push('');

  if (rec.event === 'content-revised') {
    L.push('> The body of this page changed while its title and dates stayed the same. Compare against the previous version before deciding.');
    L.push('');
  }

  if (rec.reference_only) {
    L.push('### Reference only');
    L.push('Recorded for awareness. No playbook section or artefact is flagged for change.');
  } else if ((rec.affects_sections || []).length || (rec.affects_artefacts || []).length) {
    L.push('### Flags a change');
    if (rec.affects_sections.length) L.push(`Sections: ${rec.affects_sections.map((s) => `\`§${s}\``).join(' ')}`);
    if (rec.affects_artefacts.length) L.push(`Artefacts: ${rec.affects_artefacts.map((a) => `\`${a}\``).join(' ')}`);
  } else {
    L.push('### No mapping matched');
    L.push('Read it and decide, or add a keyword to `mappings.json`.');
  }

  L.push('');
  L.push('### To close this');
  L.push('Comment with a decision block, then close. Anything you write around it is fine; only the block is the record.');
  L.push('');
  L.push(TEMPLATE);
  L.push('');
  L.push('Closing without a decision block reopens the issue once. That is deliberate: a closed issue with no recorded reasoning is not a review.');
  L.push('');
  L.push('---');
  L.push(`<sub>Opened automatically by the regulatory scanner. Record \`${rec.record_id}\`, content hash \`${rec.content_hash}\`. Generated triage, if any, is advisory and is not the record.</sub>`);
  return L.join('\n');
}

// ---------- API ----------

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
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  return { ok: res.ok, status: res.status, json, text };
}

const LABEL_COLOURS = {
  'reg-scan': '1F3864', 'tier-1': '8A2E2E', 'tier-2': 'B8791C', 'tier-3': '6E7781',
  'flags-change': '3E7C71', 'reference-only': 'D8D5CE', unmapped: 'C9A227',
  'content-revised': 'A83232', 'has-commencement': '2F6F8F', 'needs-decision': 'C9A227'
};

async function ensureLabels(names) {
  for (const name of names) {
    const colour = LABEL_COLOURS[name] || (name.startsWith('topic:') ? '3E7C71' : '6E7781');
    const r = await gh(`/repos/${REPO}/labels`, { method: 'POST', body: { name, color: colour } });
    if (!r.ok && r.status !== 422) console.log(`  ! could not create label ${name}: ${r.status}`);
  }
}

// ---------- main ----------

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  if (!existsSync(LOG)) { console.log('No impact log yet. Run the scan first.'); return; }
  if (!dryRun && (!TOKEN || !REPO)) {
    console.log('GITHUB_TOKEN or GITHUB_REPOSITORY not set. Skipping issues. The impact log is unaffected.');
    return;
  }

  const log = JSON.parse(readFileSync(LOG, 'utf8'));
  if (log.sample_data) {
    console.log('The impact log still contains sample records. Refusing to open issues.');
    console.log('Run the scan first; it clears them automatically.');
    return;
  }
  const reviewers = existsSync(REVIEWERS) ? JSON.parse(readFileSync(REVIEWERS, 'utf8')) : { reviewers: [] };

  let opened = 0, closed = 0, synced = 0, rejected = 0;

  // 1. Pull state back from GitHub. A closed issue is only a review if it
  //    carries a decision.
  for (const rec of log.records) {
    if (!rec.issue_number || rec.status !== 'unreviewed' || dryRun) continue;

    const r = await gh(`/repos/${REPO}/issues/${rec.issue_number}`);
    if (!r.ok || !r.json || r.json.state !== 'closed') continue;

    const cr = await gh(`/repos/${REPO}/issues/${rec.issue_number}/comments?per_page=100`);
    const decision = decisionFromComments(Array.isArray(cr.json) ? cr.json : []);

    if (!decision || !decision.valid) {
      const why = decision
        ? `The decision block could not be accepted:\n${decision.errors.map((e) => `- ${e}`).join('\n')}`
        : 'This was closed without a decision block, so there is no record of what was decided or why.';

      if (rec.reopen_count >= 1) {
        // Reopened once already. Accept the close, but the record says plainly
        // that no valid decision was ever made.
        rec.status = 'reviewed';
        rec.decision = decision?.decision ?? null;
        rec.decision_valid = false;
        rec.reviewed_by = r.json.closed_by?.login ?? null;
        rec.reviewed_by_role = authorityFor(r.json.closed_by?.login, reviewers).role;
        rec.reviewed_at = r.json.closed_at ?? new Date().toISOString();
        rec.outcome = 'Closed without a valid decision block. No reasoning was recorded.';
        rejected += 1;
        console.log(`  !     ${rec.record_id} closed again without a decision. Recorded as invalid.`);
        continue;
      }

      await gh(`/repos/${REPO}/issues/${rec.issue_number}/comments`, {
        method: 'POST',
        body: { body: `${why}\n\nReopening once. Please comment with:\n\n${TEMPLATE}\n\nThen close again.` }
      });
      await gh(`/repos/${REPO}/issues/${rec.issue_number}`, { method: 'PATCH', body: { state: 'open' } });
      rec.reopen_count = (rec.reopen_count ?? 0) + 1;
      console.log(`  reopen ${rec.record_id} issue #${rec.issue_number}: no valid decision`);
      continue;
    }

    // QA M5. Record the capacity in which the decision was made.
    const auth = authorityFor(decision.author, reviewers);
    const flagsChange = !rec.reference_only && (rec.affects_artefacts || []).length > 0;

    if (reviewers.require_second_approver_for_flagged_changes && flagsChange && !auth.can_approve) {
      await gh(`/repos/${REPO}/issues/${rec.issue_number}/comments`, {
        method: 'POST',
        body: `This record flags a change to the playbook, and \`${decision.author}\` is not listed in \`reviewers.json\` as able to approve one.\n\nThe decision is recorded, but marked as made without authority. Add the reviewer to \`reviewers.json\`, or have an approver confirm with their own decision block.`
      });
    }

    rec.status = 'reviewed';
    rec.decision = decision.decision;
    rec.decision_valid = true;
    rec.decision_authorised = flagsChange ? auth.can_approve : true;
    rec.reviewed_by = decision.author ?? r.json.closed_by?.login ?? null;
    rec.reviewed_by_role = auth.role ?? (auth.known ? null : 'not listed in reviewers.json');
    rec.reviewed_at = decision.at ?? r.json.closed_at ?? new Date().toISOString();
    rec.outcome = decision.note;
    if (decision.sections.length) rec.decided_sections = decision.sections;
    if (decision.artefacts.length) rec.decided_artefacts = decision.artefacts;
    // A reviewer who found the in-force date the source did not state.
    if (decision.in_force && !rec.date_in_force) rec.date_in_force = decision.in_force;

    synced += 1;
    console.log(`  sync  ${rec.record_id} ${decision.decision} by ${rec.reviewed_by} (${rec.reviewed_by_role ?? 'role unknown'})`);
  }

  // 2. A record reviewed by hand closes its issue.
  for (const rec of log.records) {
    if (!rec.issue_number || rec.status === 'unreviewed' || dryRun) continue;
    const r = await gh(`/repos/${REPO}/issues/${rec.issue_number}`);
    if (!r.ok || !r.json || r.json.state === 'closed') continue;
    await gh(`/repos/${REPO}/issues/${rec.issue_number}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
    closed += 1;
    console.log(`  close ${rec.record_id} issue #${rec.issue_number} (reviewed in the log)`);
  }

  // 3. Open issues for anything unreviewed without one.
  const queue = log.records.filter((r) => r.status === 'unreviewed' && !r.issue_number);
  const pending = queue.slice(0, MAX_NEW);

  if (pending.length && !dryRun) {
    const all = new Set();
    pending.forEach((r) => labelsFor(r).forEach((l) => all.add(l)));
    await ensureLabels([...all]);
  }

  for (const rec of pending) {
    const payload = { title: issueTitle(rec), body: issueBody(rec), labels: labelsFor(rec) };
    if (dryRun) {
      console.log(`--- would open: ${payload.title}`);
      console.log(`    labels: ${payload.labels.join(', ')}`);
      opened += 1;
      continue;
    }
    const r = await gh(`/repos/${REPO}/issues`, { method: 'POST', body: payload });
    if (!r.ok) { console.log(`  ! could not open issue for ${rec.record_id}: ${r.status} ${r.text?.slice(0, 200)}`); continue; }
    rec.issue_number = r.json.number;
    opened += 1;
    console.log(`  open  ${rec.record_id} -> issue #${r.json.number}`);
  }

  if (queue.length > pending.length) {
    console.log(`  ! ${queue.length - pending.length} record(s) still waiting for an issue (cap is ${MAX_NEW} per run).`);
  }

  if (!dryRun) writeFileSync(LOG, JSON.stringify(log, null, 2) + '\n');
  console.log(`\n${opened} opened, ${closed} closed, ${synced} reviewed, ${rejected} closed without a valid decision.`);
  const remaining = log.records.filter((r) => r.status === 'unreviewed').length;
  if (remaining) console.log(`${remaining} record(s) still unreviewed.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
