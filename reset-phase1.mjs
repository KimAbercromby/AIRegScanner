#!/usr/bin/env node
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const statePath = new URL('./state.json', import.meta.url);
const backupPath = new URL('./state-pre-effectid-v1.json', import.meta.url);

if (!existsSync(statePath)) {
  console.error('state.json was not found. Nothing changed.');
  process.exit(1);
}
if (existsSync(backupPath)) {
  console.error('state-pre-effectid-v1.json already exists. Refusing to overwrite the audit backup.');
  process.exit(1);
}

const current = JSON.parse(readFileSync(statePath, 'utf8'));
copyFileSync(statePath, backupPath);
writeFileSync(statePath, JSON.stringify({
  identity_version: 2,
  last_run: null,
  reset_from: 'pre-effectid-v1',
  reset_at: new Date().toISOString(),
  archived_item_count: Object.keys(current.items || {}).length,
  items: {}
}, null, 2) + '\n');

console.log('Archived old state as state-pre-effectid-v1.json.');
console.log('Created an empty identity v2 state. Run npm run scan to establish a new baseline.');
console.log('impact-log.json and GitHub Issues were not changed.');
