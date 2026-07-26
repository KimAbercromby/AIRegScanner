# Phase 1 controlled state reset

The stable legislative identity repair changes state keys for `atom-changes` sources from the affected page URL to the publisher supplied `EffectId`. Reusing the old state would make existing effects appear new, so the scanner now stops safely instead.

## Procedure

1. Keep `impact-log.json` and all GitHub Issues unchanged. They are the audit history.
2. Run `npm run reset:phase1` once.
3. Confirm `state-pre-effectid-v1.json` exists. This is the immutable backup of the old scanner state.
4. Run `npm run scan`. The first run establishes a clean v2 baseline and creates no review records.
5. Run the scanner again only when a genuine later change is expected, or allow the normal schedule to do so.

The reset utility refuses to overwrite an existing backup.
