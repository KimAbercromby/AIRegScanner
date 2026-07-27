#!/usr/bin/env node
/**
 * AI regulatory horizon scanner.
 *
 * Design rules, in priority order:
 *   1. Sources are an allowlist. Nothing is discovered, only checked.
 *   2. The record is what was retrieved. Nothing generated is ever the record.
 *   3. Every focused candidate lands as "unreviewed". A person decides what it means.
 *   4. A source that fails is reported loudly, never skipped silently.
 *   5. The tool must be able to prove it looked, not only what it found.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSource, httpGet } from './fetchers.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const P = {
  sources:  join(ROOT, 'sources.json'),
  mappings: join(ROOT, 'mappings.json'),
  state:    join(ROOT, 'state.json'),
  log:      join(ROOT, 'impact-log.json'),
  health:   join(ROOT, 'health.json'),
  runlog:   join(ROOT, 'run-log.json'),
  coverage: join(ROOT, 'coverage.json'),
  discards: join(ROOT, 'discards.json'),
  baseline: join(ROOT, 'baseline.json')
};

const RUNNABLE = new Set(['verified', 'form-verified']);
const DEEP_MAX = Number(process.env.DEEP_MAX ?? 40);   // body fetches per run
const DISCARD_KEEP = 500;                              // discard entries retained
const RUNLOG_KEEP = 400;                               // runs retained
const STATE_IDENTITY_VERSION = 2;                    // v2 keys legislation by EffectId

const readJSON = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);
const writeJSON = (p, obj) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); };
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** Host must be the registered domain or a subdomain. Blocks redirects off-publisher. */
export function domainAllowed(url, allowedDomains) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return allowedDomains.some((d) => {
    const dom = d.toLowerCase();
    return host === dom || host.endsWith(`.${dom}`);
  });
}

/** Deterministic, case-insensitive. No model involved. */
export function classify(item, mappings) {
  const hay = `${item.title ?? ''} ${item.summary ?? ''}`.toLowerCase();
  const topics = [];
  const sections = new Set();
  const artefacts = new Set();

  for (const t of mappings.topics) {
    if (!t.keywords.some((k) => hay.includes(k.toLowerCase()))) continue;
    topics.push(t.id);
    // Reference-only topics are recorded and tagged but never flag the
    // playbook for change. The EU AI Act is the case.
    if (t.reference_only) continue;
    t.affects_sections.forEach((s) => sections.add(s));
    t.affects_artefacts.forEach((a) => artefacts.add(a));
  }
  return {
    topics,
    reference_only: topics.length > 0 && topics.every((id) => mappings.topics.find((x) => x.id === id)?.reference_only),
    affects_sections: [...sections].sort(),
    affects_artefacts: [...artefacts].sort()
  };
}

export function passesRelevanceGate(item, mappings) {
  const hay = `${item.title ?? ''} ${item.summary ?? ''}`.toLowerCase();
  return mappings.relevance_gate.any_of.some((k) => hay.includes(k.toLowerCase()));
}

const matchingTerms = (hay, terms = []) => terms.filter((term) => hay.includes(term.toLowerCase()));

/**
 * High-signal relevance decision. Ordinary watched-statute changes are assessed
 * against the amending instrument (the text before "effect on"), not the name
 * of the affected Act. Otherwise every amendment to the Equality Act, Housing
 * Act or another watched statute looks relevant merely because the target Act
 * appears in the generated title.
 */
export function sourceRelevanceDecision(source, item, mappings) {
  if (source.filter === 'none' || !source.filter) {
    return { keep: true, reason: 'source-unfiltered', priority: [], ai: [], governance: [] };
  }

  if (source.filter === 'keywords') {
    const keep = passesRelevanceGate(item, mappings);
    return {
      keep,
      reason: keep ? 'ai-keyword' : 'no-ai-keyword',
      priority: [],
      ai: keep ? matchingTerms(`${item.title ?? ''} ${item.summary ?? ''}`.toLowerCase(), mappings.relevance_gate.any_of) : [],
      governance: []
    };
  }

  if (source.filter !== 'ai-governance') {
    return { keep: false, reason: `unknown-filter:${source.filter}`, priority: [], ai: [], governance: [] };
  }

  const gate = mappings.focus_gate;
  if (!gate) {
    return { keep: false, reason: 'focus-gate-not-configured', priority: [], ai: [], governance: [] };
  }

  const fullTitle = String(item.title ?? '').toLowerCase();
  const instrumentTitle = source.type === 'atom-changes'
    ? fullTitle.split(/\s+effect on\s+/i)[0]
    : fullTitle;
  const hay = `${instrumentTitle} ${item.summary ?? ''}`.toLowerCase();
  const priority = matchingTerms(hay, gate.priority_phrases);
  const ai = matchingTerms(hay, gate.ai_signals);
  const governance = matchingTerms(hay, gate.governance_signals);

  const isLegislationGovUk = (source.allowed_domains ?? [])
    .some((d) => d === 'legislation.gov.uk' || d.endsWith('.legislation.gov.uk'));
  if (isLegislationGovUk && source.type !== 'atom-changes') {
    let type = null;
    try { type = new URL(item.url).pathname.split('/').filter(Boolean)[0] ?? null; } catch { /* rejected below */ }
    if (!gate.allowed_uk_legislation_types.includes(type)) {
      return { keep: false, reason: 'outside-uk-legislation-scope', priority, ai, governance };
    }
  }

  // A changes feed is already legal material, so a direct AI signal or named
  // priority framework is sufficient. General feeds must also show a legal,
  // assurance, public-sector or governance consequence.
  const keep = source.type === 'atom-changes'
    ? priority.length > 0 || ai.length > 0
    : priority.length > 0 || (ai.length > 0 && governance.length > 0);

  return {
    keep,
    reason: keep
      ? (priority.length ? 'priority-framework' : (source.type === 'atom-changes' ? 'ai-related-statutory-change' : 'ai-and-governance'))
      : (ai.length ? 'ai-without-governance-impact' : 'no-ai-governance-signal'),
    priority,
    ai,
    governance
  };
}

/** Apply the current focus policy to both new and pre-v0.8 audit records. */
export function recordIsFocused(record, sourcesFile, mappings) {
  if (record.relevance?.level === 'focused') return true;
  if (record.relevance?.level === 'excluded') return false;
  const source = (sourcesFile.sources ?? []).find((s) => s.id === record.source_id);
  return source ? sourceRelevanceDecision(source, record, mappings).keep : false;
}

/**
 * QA C3. The old hash was title plus dates, so a guidance page rewritten
 * without touching its title or timestamps registered as unchanged. Summary is
 * now included, and sources marked `deep: true` also have their body text
 * hashed so a silent rewrite is caught.
 */
export function metaHash(item) {
  return sha([item.title ?? '', item.date_published ?? '', item.date_updated ?? '', item.summary ?? ''].join('|'));
}

export function bodyHash(text) {
  return sha(String(text).replace(/\s+/g, ' ').trim().toLowerCase());
}

/** Stable identity: legislation effects use EffectId, not the affected Act URL. */
export function itemIdentityKey(source, item) {
  const stable = source.type === 'atom-changes'
    ? (item.effect_id || item.raw_id)
    : (item.raw_id || item.url);
  return `${source.id}::${stable || item.url}`;
}

/** Refuse to run old legislative state through the new identity algorithm. */
export function assertStateIdentityVersion(state, sourcesFile) {
  const keys = Object.keys(state.items || {});
  if (keys.length === 0) { state.identity_version = STATE_IDENTITY_VERSION; return; }
  if (state.identity_version === STATE_IDENTITY_VERSION) return;

  const legislativeIds = (sourcesFile.sources || [])
    .filter((s) => s.type === 'atom-changes')
    .map((s) => `${s.id}::`);
  const hasLegacyLegislativeState = keys.some((k) => legislativeIds.some((p) => k.startsWith(p)));
  if (hasLegacyLegislativeState) {
    throw new Error(
      'STATE IDENTITY SAFETY STOP: this repository contains pre-EffectId legislative state. ' +
      'Run npm run reset:phase1 to archive the old state and create a clean v2 baseline. ' +
      'Impact records and GitHub Issues are preserved.'
    );
  }
  state.identity_version = STATE_IDENTITY_VERSION;
}

export function stripToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** QA M4. Identifiers come from a persisted counter, never from array length. */
export function nextRecordId(log) {
  const n = (log.next_record_id ?? log.records.length + 1);
  log.next_record_id = n + 1;
  return `REG-${String(n).padStart(4, '0')}`;
}

/**
 * QA C1. A coverage statement generated from the register, so what the monitor
 * does NOT see is stated rather than inferred from an engineering panel.
 */
export function buildCoverage(sourcesFile, baselineDate) {
  const covered = [], notCovered = [];
  for (const s of sourcesFile.sources) {
    const entry = { id: s.id, publisher: s.publisher, tier: s.tier, authority: s.authority };
    if (RUNNABLE.has(s.verification_status)) covered.push(entry);
    else notCovered.push({ ...entry, reason: s.resolve ? 'Statute identifier not yet resolved. Run the Resolve workflow.' : (s.verify_note || 'Endpoint not confirmed.') });
  }
  return {
    generated_at: new Date().toISOString(),
    jurisdiction: sourcesFile.scope?.jurisdiction ?? null,
    authority_type: sourcesFile.scope?.authority_type ?? null,
    monitoring_since: baselineDate ?? null,
    covered_count: covered.length,
    not_covered_count: notCovered.length,
    covered,
    not_covered: notCovered,
    statement: notCovered.length
      ? `This monitor covers ${covered.length} of ${covered.length + notCovered.length} configured publishers. It does NOT currently cover: ${notCovered.map((n) => n.publisher).join('; ')}. Any assurance drawn from it must be read subject to those gaps.`
      : `This monitor covers all ${covered.length} configured publishers.`
  };
}

/** QA m1. A source collapsing from 50 items to 2 previously read as healthy. */
export function detectCollapse(sourceId, seen, runlog) {
  const history = runlog.runs
    .flatMap((r) => r.sources ?? [])
    .filter((s) => s.id === sourceId && typeof s.items_seen === 'number' && s.items_seen > 0)
    .slice(-10)
    .map((s) => s.items_seen);
  if (history.length < 3 || seen === 0) return null;
  const sorted = [...history].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median >= 5 && seen < median * 0.4) {
    return `Returned ${seen} items against a recent median of ${median}. Check the endpoint has not changed shape.`;
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.find((a) => a.startsWith('--source='))?.split('=')[1];
  const dryRun = args.includes('--dry-run');

  const sourcesFile = readJSON(P.sources);
  const mappings = readJSON(P.mappings);
  const state = readJSON(P.state, { last_run: null, items: {} });
  const runlog = readJSON(P.runlog, { runs: [] });
  const discards = readJSON(P.discards, { note: 'Items considered and rejected by the relevance gate. Retained so the gate can be audited.', entries: [] });
  const log = readJSON(P.log, { log_version: '0.5', playbook_version: mappings.target_playbook_version, next_record_id: 1, records: [] });

  assertStateIdentityVersion(state, sourcesFile);

  // Demo records are marked. Clear them rather than relying on anyone
  // remembering, because forgetting means issues about invented items.
  // Demo data ships marked. Clear ALL of it, not just the impact log: a sample
  // entry surviving in the run log would mean the monitor's own claim to have
  // run on N occasions started with a fabricated one.
  if (log.sample_data) {
    console.log('Sample data found. Clearing it before the first real run.\n');
    log.records = [];
    log.next_record_id = 1;
    delete log.sample_data;
  }
  if (runlog.sample_data) { runlog.runs = []; delete runlog.sample_data; }
  if (discards.sample_data) { discards.entries = []; delete discards.sample_data; }
  if (log.next_record_id === undefined) log.next_record_id = log.records.length + 1;

  const runAt = new Date().toISOString();

  // First run absorbs the existing backlog into state without creating records,
  // otherwise day one is a hundred issues about things published months ago.
  const isFirstRun = Object.keys(state.items).length === 0;
  const baseline = !dryRun && !args.includes('--force-records') && (args.includes('--baseline') || isFirstRun);

  if (baseline) {
    console.log('BASELINE RUN: absorbing what is already published. No records, no issues.');
    console.log('The next run reports genuine changes only. Use --force-records to override.\n');
  }

  const health = { run_at: runAt, register_version: sourcesFile.register_version, mode: baseline ? 'baseline' : 'normal', sources: [], rejects: [] };
  const baselineManifest = { taken_at: runAt, note: 'Items present when monitoring began. Absorbed as the starting position and never reviewed. Retained so the blind spot is on the record.', sources: {} };
  let added = 0, changed = 0, absorbed = 0, discardedCount = 0, deepFetches = 0, capHit = false;

  for (const source of sourcesFile.sources) {
    if (only && source.id !== only) continue;

    if (!RUNNABLE.has(source.verification_status)) {
      health.sources.push({ id: source.id, status: 'skipped-unverified', note: source.verify_note, items_seen: 0, items_kept: 0 });
      continue;
    }

    let result;
    try {
      result = await fetchSource(source);
    } catch (err) {
      health.sources.push({ id: source.id, status: 'error', error: String(err.message), items_seen: 0, items_kept: 0 });
      continue;
    }
    if (!result.ok) {
      health.sources.push({ id: source.id, status: 'http-error', http_status: result.status, items_seen: 0, items_kept: 0 });
      continue;
    }

    let kept = 0, sourceDiscards = 0;
    const baselinedHere = [];

    for (const item of result.items) {
      if (!item.url) { health.rejects.push({ source: source.id, reason: 'no-url', title: item.title }); continue; }

      // Accuracy control 1: the item must live on the publisher's own domain.
      if (!domainAllowed(item.url, source.allowed_domains)) {
        health.rejects.push({ source: source.id, reason: 'domain-not-allowed', url: item.url, title: item.title });
        continue;
      }

      const key = itemIdentityKey(source, item);
      const meta = metaHash(item);
      const prior = state.items[key];

      // Accuracy control 2: source-aware relevance gate. Rejected identities
      // are kept in state, so an unchanged low-value item is not written to the
      // discard audit on every run. If its content changes, it is reconsidered
      // and the fresh rejection is recorded.
      const relevance = sourceRelevanceDecision(source, item, mappings);
      if (!relevance.keep) {
        sourceDiscards += 1;
        if (!prior || prior.hash !== meta || !prior.discarded) {
          discardedCount += 1;
          discards.entries.push({
            run_at: runAt,
            source_id: source.id,
            title: item.title,
            url: item.url,
            reason: relevance.reason,
            signals: {
              priority: relevance.priority,
              ai: relevance.ai,
              governance: relevance.governance
            }
          });
        }
        if (!dryRun) {
          state.items[key] = {
            hash: meta,
            body: prior?.body ?? null,
            first_seen: prior?.first_seen ?? runAt,
            last_changed: prior?.hash === meta ? prior?.last_changed ?? runAt : runAt,
            discarded: true,
            discard_reason: relevance.reason
          };
        }
        continue;
      }

      // QA C3. Deep sources have their body text hashed too, so a rewrite with
      // unchanged metadata is caught. Capped, because it is one fetch per item.
      let body = prior?.body ?? null;
      if (source.deep && deepFetches < DEEP_MAX) {
        try {
          const page = await httpGet(item.url, { accept: 'text/html' });
          if (page.ok && domainAllowed(page.finalUrl, source.allowed_domains)) {
            body = bodyHash(stripToText(page.body).slice(0, 40000));
            deepFetches += 1;
          }
        } catch { /* leave body as prior; the health entry will show the source state */ }
      }

      let event = null;
      if (!prior || prior.discarded) event = 'new';
      else if (prior.hash !== meta) event = 'changed';
      else if (source.deep && body && prior.body && body !== prior.body) event = 'content-revised';
      else continue;

      kept += 1;

      if (baseline) {
        state.items[key] = { hash: meta, body, first_seen: runAt, last_changed: runAt, baselined: true };
        baselinedHere.push({ title: item.title, url: item.url });
        absorbed += 1;
        continue;
      }

      const mapped = classify(item, mappings);
      log.records.push({
        record_id: nextRecordId(log),
        event,
        source_id: source.id,
        publisher: source.publisher,
        tier: source.tier,
        title: item.title,
        url: item.url,
        date_published: item.date_published,
        date_in_force: item.date_in_force,
        date_retrieved: runAt,
        content_hash: meta,
        body_hash: body,
        previous_body_hash: prior?.body ?? null,
        topics: mapped.topics,
        reference_only: mapped.reference_only,
        affects_sections: mapped.affects_sections,
        affects_artefacts: mapped.affects_artefacts,
        status: 'unreviewed',
        issue_number: null,
        decision: null,
        decision_valid: null,
        reviewed_by: null,
        reviewed_by_role: null,
        reviewed_at: null,
        outcome: null,
        commencement_alerts: [],
        generated: null,
        relevance: {
          level: 'focused',
          reason: relevance.reason,
          signals: {
            priority: relevance.priority,
            ai: relevance.ai,
            governance: relevance.governance
          }
        }
      });

      if (!dryRun) state.items[key] = { hash: meta, body, first_seen: prior?.first_seen ?? runAt, last_changed: runAt };
      if (event === 'new') added += 1; else changed += 1;
    }

    if (baselinedHere.length) baselineManifest.sources[source.id] = { publisher: source.publisher, count: baselinedHere.length, items: baselinedHere };

    // A source answering 200 with nothing is the silent failure that matters.
    const collapse = detectCollapse(source.id, result.items.length, runlog);
    health.sources.push({
      id: source.id,
      status: result.items.length === 0 ? 'ok-but-empty' : (collapse ? 'ok-but-reduced' : 'ok'),
      http_status: result.status,
      items_seen: result.items.length,
      items_kept: kept,
      items_discarded: sourceDiscards,
      note: result.items.length === 0
        ? 'Responded 200 but returned no items. Check the endpoint still points where you think it does.'
        : (collapse ?? undefined)
    });
  }

  // Register staleness. A source list is itself a thing that rots.
  const reviewDue = new Date(sourcesFile.register_updated);
  reviewDue.setDate(reviewDue.getDate() + sourcesFile.review_cadence_days);
  health.register_review_due = reviewDue.toISOString().slice(0, 10);
  health.register_review_overdue = new Date() > reviewDue;
  health.summary = { added, changed, absorbed, discarded: discardedCount, unreviewed: log.records.filter((r) => r.status === 'unreviewed').length };

  const pendingIssues = log.records.filter((r) =>
    r.status === 'unreviewed' &&
    !r.issue_number &&
    recordIsFocused(r, sourcesFile, mappings)
  ).length;
  if (pendingIssues > 25) { capHit = true; health.issue_cap_warning = `${pendingIssues} records await an issue but only 25 are created per run. The queue will take ${Math.ceil(pendingIssues / 25)} runs to clear.`; }

  state.identity_version = STATE_IDENTITY_VERSION;
  state.last_run = runAt;

  if (dryRun) {
    console.log(JSON.stringify(health, null, 2));
    console.log(`DRY RUN: ${added} new, ${changed} changed, ${discardedCount} discarded. Nothing written.`);
    return;
  }

  // QA M2 and M7. One run record every run, whether or not anything was found.
  // This is the evidence that the tool looked, and it is also the repository
  // activity that stops GitHub disabling the schedule after 60 quiet days.
  runlog.runs.push({
    run_at: runAt,
    mode: health.mode,
    register_version: sourcesFile.register_version,
    sources_checked: health.sources.filter((s) => s.status.startsWith('ok')).length,
    sources_skipped: health.sources.filter((s) => s.status === 'skipped-unverified').length,
    sources_failed: health.sources.filter((s) => ['error', 'http-error', 'ok-but-empty', 'ok-but-reduced'].includes(s.status)).length,
    items_seen: health.sources.reduce((n, s) => n + (s.items_seen || 0), 0),
    added, changed, absorbed, discarded: discardedCount,
    outcome: added + changed === 0 ? 'Monitored. No changes arising.' : `${added} new, ${changed} changed.`,
    sources: health.sources.map((s) => ({ id: s.id, status: s.status, items_seen: s.items_seen }))
  });
  if (runlog.runs.length > RUNLOG_KEEP) runlog.runs = runlog.runs.slice(-RUNLOG_KEEP);

  if (discards.entries.length > DISCARD_KEEP) discards.entries = discards.entries.slice(-DISCARD_KEEP);

  const firstBaseline = readJSON(P.baseline, null);
  if (baseline && !firstBaseline) writeJSON(P.baseline, baselineManifest);

  writeJSON(P.state, state);
  writeJSON(P.log, log);
  writeJSON(P.health, health);
  writeJSON(P.runlog, runlog);
  writeJSON(P.discards, discards);
  writeJSON(P.coverage, buildCoverage(sourcesFile, (firstBaseline ?? (baseline ? baselineManifest : null))?.taken_at ?? null));

  if (baseline) console.log(`${absorbed} item(s) absorbed as the starting position. Nothing to review yet.`);
  else console.log(`${added} new, ${changed} changed, ${discardedCount} discarded, ${health.summary.unreviewed} unreviewed in total.`);
  for (const s of health.sources) {
    if (s.status !== 'ok') console.log(`  ! ${s.id}: ${s.status}${s.http_status ? ' ' + s.http_status : ''}${s.note ? ' — ' + s.note : ''}`);
  }
  if (capHit) console.log(`  ! ${health.issue_cap_warning}`);
  if (health.register_review_overdue) console.log(`  ! source register review overdue (was due ${health.register_review_due})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
