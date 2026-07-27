# AI regulatory horizon scanner

> **What this is.** A monitor that watches a fixed list of publishers and tells you
> what changed and what it touches. It is not an assurance that you have seen
> everything. The coverage panel at the top of the viewer states what it does not
> cover, and any report drawn from it must carry that statement.

Checks a fixed list of authoritative publishers on a schedule, detects what changed,
applies a deterministic AI-governance focus gate, and maps each retained change onto
the playbook sections and artefacts it would affect.

It does not crawl, discover, or summarise the law. That is deliberate. Items excluded
by the focus gate remain in `discards.json`, so filtering is auditable.

## Scope

**England. Single-tier authority (London borough).** Full range of duties: adult
social care, children's services, housing, public health, revenues and benefits.

The register tracks the frameworks a council is actually judged against, not UK AI
policy in general. Those are different lists, and the second one is not the one a
service manager gets held to. Devolved legislation types and the Welsh, Scottish and
Northern Irish ombudsmen are deliberately out of scope; that is the first thing to add
if the toolkit is ever generalised beyond the case study.

The EU AI Act is recorded as **reference only**: the topic is tagged, the item appears
in the log, and no playbook section or artefact is flagged for change. That matches
the scope caveat already in the Current State Assessment.

## The four rules it is built around

1. **Sources are an allowlist.** Nothing is discovered, only checked. A transparent,
   deterministic focus gate then separates AI-governance changes from ordinary
   amendments and general AI news.
2. **The record is what was retrieved.** Publisher, title as published, canonical
   URL, dates, content hash. Anything a model produces lands in a separate
   `generated` block and is never the record.
3. **Every focused candidate lands unreviewed.** The gate decides only whether an
   item contains the configured AI-governance signals. A person still decides what
   the retained item means and whether anything must change.
4. **Failure is loud.** A source that 404s, returns nothing, or is not yet verified
   appears in the health panel. A silent gap is the failure mode that matters,
   because you cannot see what you did not get told about.

## Setup

```bash
npm ci
npm test          # all tests run offline against fixtures
npm run resolve   # confirm the statute chapter numbers (run once, first)
npm run verify    # dry run: calls every runnable source, writes nothing
npm run scan      # real run: writes state, impact log and health
npm run issues    # open review issues, sync closed ones back
npm run diary     # commencement diary: what comes into force soon
npm run smoke     # call the live publishers and fail loudly if unreachable
npm run discover -- <url>   # work out how to monitor a publisher with no feed
```

**You do not need Node installed.** Everything above also runs from the Actions
tab. See "Setting it up on GitHub" below.

For GitHub Pages: **Settings > Pages > Deploy from a branch > main > /(root)**.
The workflow commits to `main`, so the site updates itself.

Optional triage pass: add an `ANTHROPIC_API_KEY` repository secret. Without it the
scan is still complete; the triage step just does not run.

## Sample data

`npm run sample` writes example records so you can see the viewer before the first
real run. They are marked `sample_data: true`, which the scan clears automatically and
which stops the issues step running at all, so they cannot leak into a real log or
open issues about invented items. `npm run sample:clear` removes them by hand if you
prefer.

## The source register

`sources.json` is the heart of it. Every entry carries a `verification_status`:

| Status | Meaning | Scanner behaviour |
|---|---|---|
| `verified` | Endpoint confirmed live and returning parseable items | Called |
| `form-verified` | URL pattern confirmed against publisher documentation, live call not yet made | Called |
| `unverified` | Endpoint not confirmed | **Skipped**, and reported in the health panel |

A source that answers 200 but returns nothing is reported as `ok-but-empty` rather
than `ok`. That is the failure that actually costs you: a changed organisation slug
or a moved feed looks perfectly healthy and reports nothing forever.

Nothing is guessed at silently. Four entries ship as `unverified` on purpose, with
instructions in their `verify_note` for how to promote them.

### Promoting a source

1. Run `npm run verify` and look at the health output.
2. Confirm the endpoint by hand in a browser.
3. Fix the `url` if needed, set `verification_status` to `verified`, set
   `last_verified` to today, and rewrite `verify_note` to say what you checked.
4. Run `npm run verify` again. It should return items.

### Statutes: resolved, never typed from memory

Ten statute sources ship with a `resolve` block and no URL:

Equality Act 2010 · Data Protection Act 2018 · Data (Use and Access) Act 2025 ·
Human Rights Act 1998 · Care Act 2014 · Children Act 1989 · Children Act 2004 ·
Housing Act 1996 · Freedom of Information Act 2000 · Procurement Act 2023

`npm run resolve` asks legislation.gov.uk's own identifier service for each one:

```
GET /id?title="Equality Act 2010"&type=ukpga&year=2010
  301 -> the canonical URI       (confirmed, promoted to verified, URL written)
  300 -> several possibilities   (ambiguous, left unverified, reported)
```

A chapter number typed from memory is exactly the kind of plausible-looking error
this tool exists to prevent, so it asks the publisher instead. Anything it cannot
resolve stays skipped and tells you to fix it by hand.

Once resolved, each becomes a changes feed carrying `ukm:Effect` elements, which is
where in-force dates actually come from.

### Sources with no feed

The Ombudsman and the ICO are now connected by page scraping, because neither
publishes a usable feed. EHRC, NAO and the LGA are still unverified. Rather than guessing at their page structure, there is a tool:

**Actions > Discover a source > Run workflow**, and paste a listing page URL.

It reports whether the page advertises a feed you should use instead, whether a
sitemap exists, and if neither, which link patterns the page contains and how many
links each covers. It then prints a source entry ready to paste into `sources.json`.
It writes nothing; it only looks.

Sources monitored this way use `type: "html-list"`, which treats the links on a
listing page as items. Two honest limitations: it carries no publication date, so
records show "not recorded" rather than a guessed one, and it cannot follow pages
that build their listing in JavaScript.

### Finding a GOV.UK organisation slug

Organisation slugs change when departments do. To list them:

```
https://www.gov.uk/api/search.json?count=0&aggregate_organisations=1000
```

This matters more than it sounds. DSIT was abolished on 21 July 2026, with AI
strategy and public sector AI adoption moving to the Cabinet Office and most other
functions to a new department. A source register written a week earlier would now be
quietly returning nothing from its single most important publisher. That is why
`govuk-dsit-legacy` is kept live rather than deleted: content being withdrawn or
moved is itself a change worth catching.

## The quarterly register review

`review_cadence_days` in `sources.json` is 90. When it lapses, the health panel says
so and the run log flags it. At each review, re-check every source: does the
publisher still exist, does the endpoint still resolve, is the scope still right.

## Mapping

`mappings.json` turns a regulatory item into a statement about your own material.
Each topic lists keywords, the playbook sections it affects, the artefacts it
affects, and why. Matching is deterministic, case-insensitive, and involves no model.

When something lands with no mapping, the viewer says so and invites you to add a
keyword rather than pretending the item is irrelevant.

Update `target_playbook_version` when you bump the playbook.

### The focused AI-governance gate

`mappings.json` also holds the focus rule used by legislation.gov.uk and GOV.UK
sources. General items need both:

- an AI signal, such as artificial intelligence, automated decision-making,
  algorithmic systems, profiling or machine learning; and
- a governance consequence, such as legislation, regulation, statutory guidance,
  rights, assurance, transparency, safety, procurement or public-sector use.

Named priority frameworks such as the Data (Use and Access) Act 2025, ATRS,
ISO/IEC 42001 and the NIST AI RMF are retained directly.

For a changes feed, only the name of the **amending instrument** is tested. The
affected Act name is removed before matching. This is the key noise control: an
unrelated amendment does not become an AI-governance item merely because it affects
the Equality Act, Housing Act or another watched statute.

The web viewer opens in **AI governance focus** mode and groups multiple effects
from the same legislative instrument into one feed entry. **Full audit history**
remains available from the Feed selector; no historical records are deleted. The
GitHub review-issue queue and commencement diary apply the same focus rule, so
hidden historical noise cannot reappear through a different workflow.

## The three dates

Every record carries `date_published`, `date_in_force` and `date_retrieved`, and the
viewer shows all three side by side. In force is the one that drives action and it is
routinely a year or more after publication. Where the source does not state it, the
field reads "not stated in source" rather than being hidden, because an absent
in-force date is something you need to go and find, not something to overlook.

The legislation.gov.uk changes feeds carry it in the `ukm:Effect` element and it is
extracted properly. Most other sources do not, so expect to fill it in by hand.

## Setting it up on GitHub

1. Create a repo and upload the **contents of this folder**, keeping the folder
   structure. The application files are deliberately kept at the repository root;
   `.github/workflows/` is the only required subfolder.
2. **Settings > Pages > Deploy from a branch > main > `/(root)`.**
3. **Settings > Actions > General > Workflow permissions > Read and write.**
   Without this the scan runs but cannot commit, so the site never updates. This is
   the step people miss.
4. **Actions > Regulatory scanner > Run workflow > resolve.** Once. It confirms the
   statute chapter numbers and writes them back, and prints a table of what it
   resolved in the run summary.
5. **Actions > Regulatory scanner > Run workflow > scan.** The current workflow is
   manual while its schedule lines are commented out. Re-enable the cron only after
   a clean baseline scan.

The demo records that ship in `impact-log.json` are cleared automatically on the
first real scan, and the issues step refuses to run while they are present. You do not
need to remember to delete them.

### The first run is a baseline

The first scan absorbs everything already published into `state.json` and creates
**no records and no issues**. It writes `docs/baseline.json` listing exactly what was
absorbed, permanently, and the coverage panel states the date monitoring began. That
window is a real blind spot and it is on the record rather than hidden. Otherwise day one would be a
hundred issues about things published months ago, which is the quickest way to make
a review queue get ignored.

From the second run onwards you get genuine changes only. If you really do want the
existing backlog as reviewable records, run the scan with `--force-records`.

## Reviewing a record

Reviews happen in GitHub Issues, not in JSON.

Every unreviewed record opens an issue with the source link, the three dates, the
sections and artefacts it flags, and a checklist. To close it, comment with a
**decision block**:

```
DECISION: change-required
SECTIONS: 4.4.6, 3.10.1
ARTEFACTS: DPIA Template
IN-FORCE: 2026-10-01
NOTE: The new threshold means the escalation trigger wording no longer matches.
```

`DECISION` must be one of `no-change`, `change-required`, `already-covered`,
`not-applicable`, `superseded`. `NOTE` is required. `change-required` must name at
least one section or artefact. `IN-FORCE` is how you record a commencement date the
source did not state, and it feeds the diary.

Write whatever else you like around the block; only the block is the record. **The
last comment that parses as a decision wins, not the last comment.** A colleague
replying "+1" after your assessment cannot become the audit record.

Closing without a valid decision **reopens the issue once**, with an explanation. A
closed issue carrying no reasoning is not a review. Close it a second time without one
and the record is accepted but permanently marked as closed without a valid decision,
and the viewer says so.

Who decided is recorded too. `reviewers.json` maps GitHub usernames to names, roles
and whether they may approve a flagged change. Someone not listed can still close an
issue, but the decision is recorded as made without authority and flagged.

It works in both directions, so setting `status` to `reviewed` in the log by hand
closes the matching issue instead.

## The commencement diary

An in-force date is no use if nothing acts on it. Anything with a future commencement
raises a fresh issue at 90, 30 and 7 days out and on the day, separate from the review
issue, because the review is finished and this is about readiness. Only the closest
unfired milestone fires, so a record picked up late does not raise four issues at once.

`docs/diary.json` holds the "what bites next quarter" view, and the viewer shows it
above the records.

## Proving it looked

`docs/run-log.json` carries one entry per run whether or not anything was found,
including `"Monitored. No changes arising."` Diligence is demonstrated by the record
of looking, not only by the record of finding.

This is also why the commit step **fails** if there is nothing to commit: the run log
changes every run, so an empty commit means something is wrong. And it is why the
schedule keeps working. GitHub disables scheduled workflows after 60 days of
repository inactivity, and a scanner that only committed on change would switch itself
off during a quiet spell, with the symptom indistinguishable from the quiet spell.

## Discards

Items dropped by the relevance gate are logged to `docs/discards.json` with a reason.
"Considered and rejected" is a category the record needs, because the gate matches on
AI vocabulary and measures that introduce automated processing rarely announce it in
the title. Review the discards periodically and tune `mappings.json`.

Issues are labelled `tier-1/2/3`, one `topic:` label per matched topic, and one of:

| Label | Meaning |
|---|---|
| `flags-change` | Something in the playbook or artefact set may need to change |
| `reference-only` | Recorded for awareness, flags nothing (EU AI Act) |
| `unmapped` | No keyword matched. Read it, then either decide or extend `mappings.json` |

Reference-only records still need reviewing. They just do not flag anything.

Git history plus the closed issues gives you the audit trail for free, which is the
same argument the playbook makes for the gate log.

## Why this is not a GitHub App

A GitHub App needs a server at a public address, running continuously, holding a
private key, to receive webhooks. Nothing here responds to repository events; the
scanner is time-triggered. The only thing App identity really buys is acting on repos
you do not own, and a scheduled job in your own repo already gets a `GITHUB_TOKEN`
for free.

There is a second reason. An app with write access to a council's repository is
itself a third-party supply chain question, and would need its own supplier
assurance to answer the questions this toolkit's own Supplier DDQ asks.

If you want other councils to run this, the right shapes are a **template
repository** and a **published reusable Action**, not an App. Neither needs
hosting.

## Known limits

Carried from the QA review and not yet closed:

- **Five publishers are still not connected**: EHRC, NAO, LGA, Parliament Bills and
  Find Case Law. The coverage panel says so on every view. Use the Discover workflow.
  The last two need a new fetcher rather than configuration.
- **The ICO has withdrawn all its RSS feeds.** Confirmed 25 July 2026: the news,
  decision-notice and enforcement feeds each return a notice saying the feed is
  unavailable following a redesign and that they are considering restoring one
  "depending on demand". Scraping the media centre is the only route, and it will
  break if they redesign again. That is a limitation of the publisher, not of this
  tool, and it is exactly why the coverage panel exists.
- **Deep content hashing is capped** at 40 body fetches per run and only applies to
  sources marked `deep: true`. Feed sources are still detected on metadata and
  summary alone.
- **Mapping conflates mention with effect.** A passing reference to procurement flags
  the Supplier DDQ. Expect false positives and tune the keywords.
- **No retention policy.** The run log keeps 400 runs and discards keep 500 entries;
  the impact log grows indefinitely.
- **The optional triage step sends retrieved content to a third-party API.** Low risk
  on public documents, but the tool has no record of its own processing, which your
  own supplier questionnaire would ask for.
- **07:00 UTC year round**, so it drifts an hour against local time in summer.

## What is not in v0.5

- **The unverified sources are still unverified.** v0.4 gives you the fetcher and the
  discovery tool to fix that yourself in a few minutes each; it does not guess their
  page structure for you. LGSCO is the one to do first: the Ombudsman is where a
  resident harmed by an automated decision actually ends up, long before any court.
- **Parliament Bills API fetcher, and Find Case Law.**
- **Dates for html-list sources.** No publication date is available from a plain
  listing page, so those records show "not recorded".
- **In-force date extraction outside legislation.gov.uk.**
- **CQC and Ofsted are partial.** Both publish substantive material on their own
  sites, so the GOV.UK queries catch only some of it.

## Layout

```
sources.json          the allowlist
mappings.json         topics -> playbook sections and artefacts
fetchers.mjs          per-format adapters and parsers
scan.mjs              allowlist enforcement, change detection, record writing
triage.mjs            optional, constrained, never writes the record
resolve.mjs           confirms statute chapter numbers with the publisher
issues.mjs            opens review issues, syncs closed ones back to the log
discover.mjs          inspects a publisher page and prints a source config
decision.mjs          parses and validates a review decision block
diary.mjs             commencement diary
smoke.mjs             calls the live publishers, fails loudly
reviewers.json        who may decide, in what role, with what authority
sample.mjs            demo data for the viewer
state.json            what has been seen (internal)
index.html            viewer, single self-contained file
impact-log.json       the record
health.json           last run health
run-log.json          one entry per run, including nil returns
coverage.json         what is and is not covered
diary.json            coming into force
discards.json         considered and rejected
baseline.json         what was absorbed when monitoring began
.github/workflows/    scanner.yml (scheduled and manual tasks)
*.test.mjs            offline regression tests
```

`index.html` is deliberately one self-contained file with no external
references, matching the pattern of the other tools, so it cannot half-deploy.
