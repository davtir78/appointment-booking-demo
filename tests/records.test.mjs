// The panel links every server event to the record it implements. These tests keep those links
// honest: a reference the server logs must be one the panel knows, and (when the sample project's
// repository sits beside this one) every record the panel links to must exist there, with the
// clause it names.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = join(ROOT, '..', 'itarchitecturepatterns', 'docs', 'samples', 'appointment-booking');
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const panel = read(join(ROOT, 'widget', 'panel.js'));
const records = new Map([...panel.matchAll(/'((?:ADR|ICR)-AB-\d{4}|REQ-[A-Z]+)': \['([^']+)'/g)].map((m) => [m[1], m[2]]));

const serverFiles = readdirSync(join(ROOT, 'server')).filter((f) => f.endsWith('.js')).map((f) => join(ROOT, 'server', f));
const logged = serverFiles.flatMap((f) => [...read(f).matchAll(/ref: `?'?((?:ADR|ICR)-AB-\d{4}|REQ-[A-Z]+)(#[a-z-]+)?/g)].map((m) => ({ id: m[1], anchor: m[2]?.slice(1), file: f })));

test('the panel knows seven decisions, three requirements and three contracts', () => {
  assert.equal([...records.keys()].filter((k) => k.startsWith('ADR')).length, 7);
  assert.equal([...records.keys()].filter((k) => k.startsWith('REQ')).length, 3);
  assert.equal([...records.keys()].filter((k) => k.startsWith('ICR')).length, 3);
});

test('every reference the server logs is a record the panel can link to', () => {
  assert.ok(logged.length > 10, `found ${logged.length} references`);
  for (const { id, file } of logged) assert.ok(records.has(id), `${file.slice(ROOT.length + 1)} logs ${id}, which the panel cannot link to`);
});

test('every component the panel names has a decision that exists', () => {
  for (const m of panel.matchAll(/adr: '(ADR-AB-\d{4})'/g)) assert.ok(records.has(m[1]), m[1]);
});

test('when the sample project is alongside, every record the panel links to exists, with the clause it names', (t) => {
  if (!existsSync(SAMPLE)) return t.skip('the sample project is not beside this repository');
  const slug = (h) => h.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s/g, '-');
  for (const [id, path] of records) {
    const file = join(SAMPLE, path);
    assert.ok(existsSync(file), `${id}: ${path} does not exist in the sample project`);
    const title = read(file).match(/^# (.+)$/m)?.[1] ?? '';
    if (id.startsWith('ADR')) assert.ok(title.startsWith(id), `${path} is titled “${title}”, not ${id}`);
  }
  for (const { id, anchor, file } of logged.filter((l) => l.anchor)) {
    const headings = [...read(join(SAMPLE, records.get(id))).matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1]));
    assert.ok(headings.includes(anchor), `${file.slice(ROOT.length + 1)} cites ${id}#${anchor}, which is not a heading there`);
  }
});
