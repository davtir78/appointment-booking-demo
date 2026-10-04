// The README's conformance table says which test checks each acceptance criterion of the three
// contracts. This test keeps that table honest: every criterion must have a test whose title starts
// "[ICR-AB-000n #m]", and the table must name every one of them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CRITERIA = { 'ICR-AB-0001': 9, 'ICR-AB-0002': 8, 'ICR-AB-0003': 6 }; // the numbered acceptance criteria in each contract
// The last criterion of each contract says its examples are valid against the specification file. The demo ships no such file, so nothing can check it: the README says so.
const NOT_AUTOMATED = new Set(['ICR-AB-0001 #9', 'ICR-AB-0002 #8', 'ICR-AB-0003 #6']);

const testFiles = readdirSync(join(ROOT, 'tests')).filter((f) => f.endsWith('.test.mjs') && f !== 'conformance.test.mjs');
const titles = testFiles.flatMap((f) => [...readFileSync(join(ROOT, 'tests', f), 'utf8').matchAll(/test\('(\[ICR-AB-000\d #\d\][^']*(?:\\'[^']*)*)'/g)].map((m) => ({ file: f, title: m[1] })));
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

test('every acceptance criterion of the three contracts has an automated test', () => {
  for (const [contract, count] of Object.entries(CRITERIA)) {
    for (let n = 1; n <= count; n++) {
      const tag = `[${contract} #${n}]`;
      if (NOT_AUTOMATED.has(`${contract} #${n}`)) { assert.ok(!titles.some((t) => t.title.startsWith(tag)), `${tag} is listed as not automated but has a test`); continue; }
      assert.ok(titles.some((t) => t.title.startsWith(tag)), `${tag} has no test`);
    }
  }
  assert.equal(new Set(titles.map((t) => t.title.slice(0, t.title.indexOf(']') + 1))).size, 20, 'and there are exactly twenty criteria');
});

test('the README’s conformance table names every criterion and the file of its test', () => {
  for (const [contract, count] of Object.entries(CRITERIA)) {
    for (let n = 1; n <= count; n++) {
      if (NOT_AUTOMATED.has(`${contract} #${n}`)) { assert.ok(readme.includes(`${contract} #${n}`) && /not automated/i.test(readme), `the README must say ${contract} #${n} is not automated`); continue; }
      const row = readme.split('\n').find((line) => line.startsWith('|') && line.includes(`${contract} #${n} `));
      assert.ok(row, `the README has no row for ${contract} #${n}`);
      const file = titles.find((t) => t.title.startsWith(`[${contract} #${n}]`)).file;
      assert.ok(row.includes(file), `the README row for ${contract} #${n} should name ${file}`);
    }
  }
});
