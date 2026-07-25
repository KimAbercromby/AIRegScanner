#!/usr/bin/env node
/**
 * OPTIONAL second pass. Runs only when ANTHROPIC_API_KEY is set.
 *
 * The model is allowed to do exactly one job: read text that was actually
 * fetched from the publisher and say whether it looks relevant and which of
 * the deterministic section mappings it agrees with.
 *
 * It is NOT allowed to:
 *   - state what a regulation requires from its own training data
 *   - decide the status of a record (everything stays "unreviewed")
 *   - write anything into a field that the record depends on
 *
 * Its output lands in `generated`, which is clearly separated from the record
 * and stamped with the model and timestamp. If this script never runs, the log
 * is still complete and correct.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpGet } from './fetchers.mjs';
import { domainAllowed } from './scan.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const LOG = join(ROOT, 'impact-log.json');
const SOURCES = join(ROOT, 'sources.json');

const MODEL = process.env.TRIAGE_MODEL ?? 'claude-sonnet-4-6';
const MAX_ITEMS = Number(process.env.TRIAGE_MAX_ITEMS ?? 15);
const MAX_CHARS = 6000;

const SYSTEM = `You are triaging a single published document for a UK local authority AI governance lead.

You will be given: the document title, its publisher, and text retrieved from the document itself.

Rules you must follow exactly:
1. Use ONLY the retrieved text provided. Do not use anything you know about this document, this publisher, or this area of law from any other source.
2. If the retrieved text is too thin to judge something, say so in the "note" field. Do not fill the gap.
3. Do not state what the law requires, what an organisation must do, or what the effect of the document is. You are judging relevance, not advising.
4. Every statement in your "summary" must be supported by the retrieved text. If you cannot support it, leave it out.
5. Respond with a single JSON object and nothing else. No markdown fences, no preamble.

JSON shape:
{
  "relevant": true | false,
  "relevance_reason": "one short sentence, grounded in the retrieved text",
  "summary": "at most two sentences describing what the document is, drawn only from the retrieved text",
  "agreed_sections": ["only section ids from the candidate list you were given that the retrieved text actually supports"],
  "note": "anything the reviewer should check manually, or an empty string"
}`;

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function callClaude(payload) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('ANTHROPIC_API_KEY not set. Skipping triage. The impact log is unaffected.');
    return;
  }
  if (!existsSync(LOG)) {
    console.log('No impact log yet. Run the scan first.');
    return;
  }

  const log = JSON.parse(readFileSync(LOG, 'utf8'));
  const sources = JSON.parse(readFileSync(SOURCES, 'utf8'));
  const byId = Object.fromEntries(sources.sources.map((s) => [s.id, s]));

  const pending = log.records.filter((r) => r.generated === null).slice(0, MAX_ITEMS);
  if (!pending.length) {
    console.log('Nothing pending triage.');
    return;
  }

  for (const rec of pending) {
    const source = byId[rec.source_id];
    let retrieved = '';

    // Domain-check again before fetching. The allowlist is not a one-time gate.
    if (source && domainAllowed(rec.url, source.allowed_domains)) {
      try {
        const page = await httpGet(rec.url, { accept: 'text/html' });
        if (page.ok && domainAllowed(page.finalUrl, source.allowed_domains)) {
          retrieved = stripHtml(page.body).slice(0, MAX_CHARS);
        }
      } catch {
        retrieved = '';
      }
    }

    if (!retrieved) {
      rec.generated = {
        model: MODEL,
        generated_at: new Date().toISOString(),
        ok: false,
        error: 'no text retrieved from publisher domain; nothing to triage',
        disclaimer: 'Generated content. Not part of the record. Never act on this without reading the source.'
      };
      continue;
    }

    const user = [
      `Title: ${rec.title ?? '(none)'}`,
      `Publisher: ${rec.publisher}`,
      `Candidate section ids from deterministic keyword mapping: ${JSON.stringify(rec.affects_sections)}`,
      '',
      'Retrieved text follows between the markers.',
      '--- BEGIN RETRIEVED TEXT ---',
      retrieved,
      '--- END RETRIEVED TEXT ---'
    ].join('\n');

    try {
      const raw = await callClaude({
        model: MODEL,
        max_tokens: 1000,
        system: SYSTEM,
        messages: [{ role: 'user', content: user }]
      });
      const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);

      // The model may only narrow the deterministic mapping, never widen it.
      const allowed = new Set(rec.affects_sections);
      parsed.agreed_sections = (parsed.agreed_sections ?? []).filter((s) => allowed.has(s));

      rec.generated = {
        model: MODEL,
        generated_at: new Date().toISOString(),
        ok: true,
        source_chars_used: retrieved.length,
        ...parsed,
        disclaimer: 'Generated content. Not part of the record. Never act on this without reading the source.'
      };
    } catch (err) {
      rec.generated = {
        model: MODEL,
        generated_at: new Date().toISOString(),
        ok: false,
        error: String(err.message),
        disclaimer: 'Generated content. Not part of the record.'
      };
    }
  }

  writeFileSync(LOG, JSON.stringify(log, null, 2) + '\n');
  console.log(`Triaged ${pending.length} record(s). Status fields unchanged: all remain unreviewed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
