import { XMLParser } from 'fast-xml-parser';
import { parse as parseHtml } from 'node-html-parser';

const UA = 'ai-reg-scanner/0.1 (governance horizon scanning; contact repo owner)';
const TIMEOUT_MS = 30000;

// legislation.gov.uk throttles a burst of back-to-back requests by returning an
// HTML holding page with a 200 status, so it does not even look like an error.
// Pace ourselves per host instead of hammering, and retry once if a response
// comes back unparseable.
const HOST_DELAY_MS = Number(process.env.HOST_DELAY_MS ?? 1500);
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS ?? 5000);
const lastCallAt = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pace(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return; }
  const wait = HOST_DELAY_MS - (Date.now() - (lastCallAt.get(host) ?? 0));
  if (wait > 0) await sleep(wait);
  lastCallAt.set(host, Date.now());
}

/** Retries once. Used where a 200 can still carry the wrong thing. */
export async function withRetry(fn, attempts = 2, delayMs = RETRY_DELAY_MS) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try { return await fn(); } catch (e) {
      last = e;
      if (i < attempts - 1) await sleep(delayMs);
    }
  }
  throw last;
}

/** First readable text in a response, so an error says what actually came back. */
export function bodySnippet(body, n = 180) {
  return String(body)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: false,
  parseAttributeValue: false,
  trimValues: true
});

export function toArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

/** Pull plain text out of a node that may be a string, or an object with #text. */
function text(node) {
  if (node === undefined || node === null) return null;
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (typeof node === 'object' && '#text' in node) return String(node['#text']);
  return null;
}

/**
 * Atom <link> handling. An entry usually has several links; we want the
 * canonical human-readable one, not the RDF/PDF/XML alternates.
 */
function pickLink(entry) {
  const links = toArray(entry.link);
  const href = (l) => (typeof l === 'object' ? l['@href'] : null);
  const rel = (l) => (typeof l === 'object' ? l['@rel'] : null);
  const type = (l) => (typeof l === 'object' ? l['@type'] : null);

  const noRel = links.find((l) => href(l) && !rel(l) && !type(l));
  if (noRel) return href(noRel);

  const alternateHtml = links.find((l) => href(l) && type(l) === 'text/html');
  if (alternateHtml) return href(alternateHtml);

  const self = links.find((l) => href(l) && rel(l) === 'self');
  if (self) return href(self);

  const any = links.find((l) => href(l));
  return any ? href(any) : text(entry.id);
}

export async function httpGet(url, { accept } = {}) {
  await pace(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, ...(accept ? { Accept: accept } : {}) },
      redirect: 'follow',
      signal: controller.signal
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body, finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

/** Standard Atom feed -> normalised items. */
export function parseAtom(xml) {
  const doc = parser.parse(xml);
  const feed = doc.feed;
  if (!feed) throw new Error(`no <feed> element: not an Atom document. Server returned: "${bodySnippet(xml)}"`);
  return toArray(feed.entry).map((e) => ({
    raw_id: text(e.id),
    title: text(e.title),
    url: pickLink(e),
    date_published: text(e.published) || text(e.updated) || null,
    date_updated: text(e.updated) || null,
    date_in_force: null,
    summary: text(e.summary)
  }));
}

/**
 * legislation.gov.uk changes feed. Each entry wraps a <ukm:Effect> which
 * carries the in-force date. That third date is the one that drives council
 * action, so it is extracted rather than inferred.
 */
export function parseAtomChanges(xml) {
  const doc = parser.parse(xml);
  const feed = doc.feed;
  if (!feed) throw new Error(`no <feed> element: not an Atom document. Server returned: "${bodySnippet(xml)}"`);
  return toArray(feed.entry).map((e) => {
    const effect = e.content?.['ukm:Effect'] ?? e['ukm:Effect'] ?? null;
    let inForce = null;
    let effectType = null;
    if (effect) {
      effectType = effect['@Type'] ?? null;
      const inForceNodes = toArray(effect['ukm:InForceDates']?.['ukm:InForce']);
      const dates = inForceNodes.map((n) => n['@Date']).filter(Boolean).sort();
      inForce = dates.length ? dates[0] : null;
    }
    return {
      raw_id: text(e.id),
      title: text(e.title),
      url: effect?.['@AffectedURI'] ?? text(e.id),
      date_published: text(e.published) || text(e.updated) || null,
      date_updated: text(e.updated) || null,
      date_in_force: inForce,
      summary: effectType ? `Effect type: ${effectType}` : null
    };
  });
}

/** RSS 2.0 -> normalised items. */
export function parseRss(xml) {
  const doc = parser.parse(xml);
  const channel = doc.rss?.channel;
  if (!channel) throw new Error(`no <rss><channel>: not an RSS document. Server returned: "${bodySnippet(xml)}"`);
  return toArray(channel.item).map((i) => ({
    raw_id: text(i.guid) || text(i.link),
    title: text(i.title),
    url: text(i.link),
    date_published: text(i.pubDate) || null,
    date_updated: text(i.pubDate) || null,
    date_in_force: null,
    summary: text(i.description)
  }));
}

/** GOV.UK Search API JSON -> normalised items. */
export function parseGovukSearch(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  return toArray(data.results).map((r) => ({
    raw_id: r.link,
    title: r.title ?? null,
    url: r.link?.startsWith('http') ? r.link : `https://www.gov.uk${r.link}`,
    date_published: r.public_timestamp ?? null,
    date_updated: r.public_timestamp ?? null,
    date_in_force: null,
    summary: r.description ?? r.content_store_document_type ?? null
  }));
}

export function buildGovukUrl(source) {
  const u = new URL(source.url);
  const q = source.query ?? {};
  for (const [k, v] of Object.entries(q)) {
    for (const item of toArray(v)) u.searchParams.append(k, item);
  }
  if (!u.searchParams.has('fields')) {
    for (const f of ['title', 'link', 'public_timestamp', 'description', 'content_store_document_type']) {
      u.searchParams.append('fields', f);
    }
  }
  return u.toString();
}

/**
 * For publishers with no feed. Fetches a listing page and treats the links on it
 * as items. Deliberately dumb: no DOM knowledge required beyond an optional CSS
 * selector and a regex on the href. Use `npm run discover <url>` to work out what
 * to put in the config.
 */
export function parseHtmlList(html, source, pageUrl) {
  const root = parseHtml(html);
  const anchors = source.selector ? root.querySelectorAll(source.selector) : root.querySelectorAll('a[href]');
  const re = source.link_pattern ? new RegExp(source.link_pattern, 'i') : null;
  const seen = new Set();
  const items = [];

  for (const a of anchors) {
    const href = a.getAttribute('href');
    if (!href) continue;

    let abs;
    try { abs = new URL(href, pageUrl).toString(); } catch { continue; }
    abs = abs.split('#')[0];

    if (re && !re.test(abs)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);

    const title = a.text.replace(/\s+/g, ' ').trim();
    if (!title || title.length < 8) continue; // nav chrome, icons, "Read more"

    // Listing pages often put the substance beside the link rather than in it.
    // The Ombudsman is the case: link text is only "Council name (reference)"
    // while the summary, outcome and date sit in the surrounding block. Without
    // this the relevance gate would see nothing to match on.
    let summary = null;
    if (source.summary_from === 'parent') {
      summary = blockTextAround(a, title);
    }

    items.push({
      raw_id: abs,
      title,
      url: abs,
      date_published: summary ? parseLooseDate(summary) : null,
      date_updated: null,
      date_in_force: null,
      summary
    });
  }
  return items;
}

/** Text of the nearest containing block, minus the link text itself. */
export function blockTextAround(anchor, title, maxChars = 600) {
  let node = anchor.parentNode;
  let hops = 0;
  while (node && hops < 4) {
    const text = (node.text || '').replace(/\s+/g, ' ').trim();
    if (text.length > title.length + 40) {
      return text.replace(title, '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
    }
    node = node.parentNode;
    hops += 1;
  }
  return null;
}

const MONTHS = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };

/**
 * Dates on listing pages are prose, not metadata. Recognises 27-Apr-2026,
 * 27 April 2026 and 2026-04-27. Returns null rather than guessing, because a
 * wrong date is worse than an absent one.
 */
export function parseLooseDate(text) {
  if (!text) return null;
  let m = String(text).match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = String(text).match(/\b(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{4})\b/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon) return `${m[3]}-${mon}-${String(m[1]).padStart(2, '0')}`;
  }
  return null;
}

/** Looks for a feed the publisher advertises but does not link prominently. */
export function findFeedLinks(html, pageUrl) {
  const root = parseHtml(html);
  const out = [];
  for (const l of root.querySelectorAll('link[rel~="alternate"], a[type]')) {
    const type = (l.getAttribute('type') || '').toLowerCase();
    const href = l.getAttribute('href');
    if (!href) continue;
    if (!/rss|atom|xml/.test(type)) continue;
    try { out.push({ type, url: new URL(href, pageUrl).toString() }); } catch { /* ignore */ }
  }
  return out;
}

export async function fetchSource(source) {
  return withRetry(() => fetchSourceOnce(source));
}

async function fetchSourceOnce(source) {
  if (source.type === 'govuk-search') {
    const url = buildGovukUrl(source);
    const res = await httpGet(url, { accept: 'application/json' });
    if (!res.ok) return { ok: false, status: res.status, items: [], url };
    return { ok: true, status: res.status, items: parseGovukSearch(res.body), url };
  }

  if (source.type === 'html-list') {
    const res = await httpGet(source.url, { accept: 'text/html' });
    if (!res.ok) return { ok: false, status: res.status, items: [], url: source.url };
    return { ok: true, status: res.status, items: parseHtmlList(res.body, source, res.finalUrl || source.url), url: source.url };
  }

  const res = await httpGet(source.url, { accept: 'application/atom+xml, application/rss+xml, application/xml' });
  if (!res.ok) return { ok: false, status: res.status, items: [], url: source.url };

  let items;
  if (source.type === 'atom') items = parseAtom(res.body);
  else if (source.type === 'atom-changes') items = parseAtomChanges(res.body);
  else if (source.type === 'rss') items = parseRss(res.body);
  else throw new Error(`unknown source type: ${source.type}`);

  return { ok: true, status: res.status, items, url: source.url };
}
