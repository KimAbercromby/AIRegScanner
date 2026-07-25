#!/usr/bin/env node
/**
 * Works out how to monitor a publisher that has no obvious feed, and prints a
 * source entry you can paste straight into sources.json.
 *
 * It checks, in order:
 *   1. Does the page advertise an RSS or Atom feed? Use that, it is best.
 *   2. Is there a sitemap? Worth knowing about.
 *   3. Otherwise, what link patterns does the page contain, and how many of
 *      each? The most common pattern is usually the listing itself.
 *
 * Run: npm run discover -- https://ico.org.uk/for-organisations/...
 * Or from the Actions tab: "Discover a source" with the URL as input.
 */

import { httpGet, findFeedLinks, parseHtmlList } from './fetchers.mjs';

function hostOf(u) { try { return new URL(u).hostname; } catch { return null; } }

/** Group same-domain links by their parent directory. */
export function linkPatterns(items, pageUrl) {
  const base = hostOf(pageUrl);
  const groups = new Map();
  for (const it of items) {
    const u = new URL(it.url);
    if (u.hostname !== base) continue;
    const segs = u.pathname.split('/').filter(Boolean);
    // Single-segment paths are nearly always navigation (/about, /contact).
    // A document lives inside a section, so require a parent to group by.
    if (segs.length < 2) continue;
    const key = '/' + segs.slice(0, -1).join('/') + '/';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  return [...groups.entries()]
    .map(([pattern, list]) => ({ pattern, count: list.length, sample: list.slice(0, 3) }))
    .sort((a, b) => b.count - a.count);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function main() {
  const url = process.argv.slice(2).find((a) => a.startsWith('http'));
  if (!url) {
    console.error('Usage: npm run discover -- <url>');
    process.exit(1);
  }

  console.log(`Fetching ${url}\n`);
  const res = await httpGet(url, { accept: 'text/html' });
  if (!res.ok) {
    console.log(`HTTP ${res.status}. Nothing to inspect.`);
    console.log('If this is a 403, the publisher may be blocking automated requests, which rules the source out for now.');
    return;
  }

  const host = hostOf(res.finalUrl || url);

  // 1. A real feed beats everything else.
  const feeds = findFeedLinks(res.body, res.finalUrl || url);
  if (feeds.length) {
    console.log('FEED FOUND. Use this rather than page scraping.\n');
    for (const f of feeds) console.log(`  ${f.type}  ${f.url}`);
    console.log('\nPaste into sources.json:\n');
    console.log(JSON.stringify({
      type: /atom/.test(feeds[0].type) ? 'atom' : 'rss',
      url: feeds[0].url,
      allowed_domains: [host, host.replace(/^www\./, '')].filter((v, i, a) => a.indexOf(v) === i),
      filter: 'keywords',
      verification_status: 'verified',
      last_verified: new Date().toISOString().slice(0, 10),
      verify_note: `Feed advertised by the publisher, found by discover on ${new Date().toISOString().slice(0, 10)}.`
    }, null, 2));
    return;
  }
  console.log('No feed advertised on this page.\n');

  // 2. Sitemap is worth knowing about even if we do not use it.
  const sitemap = await httpGet(new URL('/sitemap.xml', res.finalUrl || url).toString(), { accept: 'application/xml' });
  console.log(sitemap.ok ? `Sitemap exists at /sitemap.xml (HTTP ${sitemap.status}). Usually too noisy, but noted.\n`
                         : `No sitemap at /sitemap.xml (HTTP ${sitemap.status}).\n`);

  // 3. Fall back to link patterns.
  const items = parseHtmlList(res.body, {}, res.finalUrl || url);
  const patterns = linkPatterns(items, res.finalUrl || url);

  if (!patterns.length) {
    console.log('No usable links found. The page may render its listing with JavaScript, which this cannot follow.');
    return;
  }

  console.log(`${items.length} links found. Candidate patterns, most common first:\n`);
  for (const p of patterns.slice(0, 8)) {
    console.log(`  ${String(p.count).padStart(3)}  ${p.pattern}`);
    for (const s of p.sample) console.log(`         ${s.title.slice(0, 70)}`);
    console.log('');
  }

  const best = patterns[0];
  console.log('Pick the pattern that matches the documents rather than the navigation, then paste:\n');
  console.log(JSON.stringify({
    type: 'html-list',
    url: res.finalUrl || url,
    link_pattern: escapeRe(best.pattern),
    allowed_domains: [host, host.replace(/^www\./, '')].filter((v, i, a) => a.indexOf(v) === i),
    filter: 'keywords',
    verification_status: 'verified',
    last_verified: new Date().toISOString().slice(0, 10),
    verify_note: `Listing page, link_pattern ${best.pattern} matching ${best.count} links, confirmed by discover on ${new Date().toISOString().slice(0, 10)}.`
  }, null, 2));
  console.log('\nNote: html-list sources carry no publication date. The record will show "not recorded" rather than a guessed one.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
