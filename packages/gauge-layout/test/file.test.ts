import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FILE_FORMAT, MAX_FILE_BYTES, MAX_LAYOUT_BYTES, MAX_REVISION, MAX_REVISIONS, defaultLayout, layoutObject, newFile, parseLayoutFile, saveRevision, serializeLayoutFile, canonicalText, swapPlace,
  type Layout, type LayoutFile,
} from '../src/index.js';
import { HOME, TABLE } from './table.js';

const base = defaultLayout(TABLE);
const other = (n: number): Layout => {
  // A layout that differs from the last by one swap, so each save is a real change.
  const result = swapPlace(base, TABLE, 'models', n % 2 === 0 ? 'tracing' : 'library');
  assert.ok(result.ok);
  return result.layout;
};
const refusal = (result: { readonly ok: boolean; readonly code?: string; readonly reason?: string }) => (result.ok ? undefined : { code: result.code, reason: result.reason });
const text = (file: object) => JSON.stringify(file);
const saved = (file: LayoutFile, layout: Layout): LayoutFile => {
  const next = saveRevision(file, layout);
  assert.ok(next);
  return next;
};
const doc = (revision: number, current: object = HOME, revisions: object[] = []) => ({ format: 'bowerloom/layout-file/1', revision, current, revisions });

test('the file format is bowerloom/layout-file/1, and the revision cap is 10', () => {
  assert.equal(FILE_FORMAT, 'bowerloom/layout-file/1');
  assert.equal(MAX_REVISIONS, 10);
});

test('a new file holds the layout as revision 1, with no earlier revision', () => {
  const file = newFile(base);
  assert.equal(file.revision, 1);
  assert.deepEqual(file.revisions, []);
  assert.equal(canonicalText(file.current), canonicalText(base));
});

test('a save keeps the current layout as the newest revision, and counts up by one', () => {
  const next = saved(newFile(base), other(0));
  assert.equal(next.revision, 2);
  assert.deepEqual(next.revisions.map(entry => entry.revision), [1]);
  assert.equal(canonicalText(next.revisions[0]?.layout ?? other(1)), canonicalText(base));
  assert.equal(canonicalText(next.current), canonicalText(other(0)));
});

test('the file keeps 10 revisions: the 11th drops the oldest, newest first', () => {
  let file = newFile(base);
  for (let step = 0; step < 10; step += 1) file = saved(file, other(step));
  assert.equal(file.revision, 11);
  assert.deepEqual(file.revisions.map(entry => entry.revision), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  file = saved(file, other(10));
  assert.equal(file.revision, 12);
  assert.deepEqual(file.revisions.map(entry => entry.revision), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  assert.equal(file.revisions.length, 10);
  file = saved(file, other(11));
  assert.deepEqual(file.revisions.map(entry => entry.revision), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
});

test('the current layout is never in the revisions, and is never lost when the oldest revision is dropped', () => {
  let file = newFile(base);
  for (let step = 0; step < 15; step += 1) {
    const before = file.current;
    file = saved(file, other(step));
    assert.equal(canonicalText(file.current), canonicalText(other(step)));
    assert.equal(canonicalText(file.revisions[0]?.layout ?? base), canonicalText(before));
    assert.ok(file.revisions.every(entry => entry.revision < file.revision));
  }
});

test('a save of the layout that is already current writes no revision and returns the same file', () => {
  const file = newFile(base);
  assert.equal(saveRevision(file, base), file);
  const changed = saved(file, other(0));
  assert.equal(saveRevision(changed, other(0)), changed);
});

test('a save never changes the file it was given', () => {
  const file = newFile(base);
  const before = serializeLayoutFile(file);
  saveRevision(file, other(0));
  assert.equal(serializeLayoutFile(file), before);
  assert.equal(Object.isFrozen(saveRevision(file, other(0))), true);
});

test('a file whose counter is full cannot take a save, and a file at the last number still reads', () => {
  assert.equal(MAX_REVISION, 999_999_999);
  const result = parseLayoutFile(text(doc(MAX_REVISION)), TABLE);
  assert.ok(result.ok);
  assert.equal(saveRevision(result.file, other(0)), undefined);
  assert.deepEqual(refusal(parseLayoutFile(text(doc(MAX_REVISION + 1)), TABLE)), { code: 'GAUGE_LAYOUT_INVALID', reason: 'bad_revision' });
});

test('a file serialises to one line of compact JSON with the fields in a fixed order, and reads back the same', () => {
  let file = newFile(base);
  for (let step = 0; step < 3; step += 1) file = saved(file, other(step));
  const out = serializeLayoutFile(file);
  assert.match(out, /^\{"format":"bowerloom\/layout-file\/1","revision":4,"current":\{"format":"bowerloom\/layout\/1".*"revisions":\[\{"revision":3,"layout":\{/);
  assert.equal(out.endsWith('}\n'), true);
  assert.equal(out.indexOf('\n'), out.length - 1);
  const read = parseLayoutFile(out, TABLE);
  assert.ok(read.ok);
  assert.equal(serializeLayoutFile(read.file), out);
});

test('the layout object of a layout is plain data with the fields in a fixed order', () => {
  assert.deepEqual(Object.keys(layoutObject(base)), ['format', 'grid', 'tiles', 'shelf', 'hidden']);
  assert.deepEqual(Object.keys(layoutObject(base).tiles[0]!), ['place', 'gauge', 'default', 'col', 'row', 'size']);
});

test('a file with the most revisions of the largest layouts fits under the file size cap', () => {
  assert.equal(MAX_FILE_BYTES, (MAX_REVISIONS + 1) * MAX_LAYOUT_BYTES + 4096);
});

test('a file over the size cap is refused with too_large', () => {
  const big = text(doc(1)) + ' '.repeat(MAX_FILE_BYTES);
  assert.deepEqual(refusal(parseLayoutFile(big, TABLE)), { code: 'GAUGE_LAYOUT_INVALID', reason: 'too_large' });
});

test('a file with the wrong format, an unknown field, or a missing field is refused', () => {
  assert.deepEqual(refusal(parseLayoutFile(text({ ...doc(1), format: 'bowerloom/layout/1' }), TABLE)), { code: 'GAUGE_LAYOUT_INVALID', reason: 'unsupported_format' });
  assert.deepEqual(refusal(parseLayoutFile(text({ ...doc(1), extra: 1 }), TABLE)), { code: 'GAUGE_LAYOUT_INVALID', reason: 'unknown_field' });
  for (const field of ['format', 'revision', 'current', 'revisions']) {
    const copy: Record<string, unknown> = { ...doc(1) };
    delete copy[field];
    assert.deepEqual(refusal(parseLayoutFile(text(copy), TABLE)), { code: 'GAUGE_LAYOUT_INVALID', reason: 'missing_field' }, field);
  }
  assert.deepEqual(refusal(parseLayoutFile(text({ ...doc(1), revisions: [{ revision: 1, layout: HOME, extra: 1 }] }), TABLE)), { code: 'GAUGE_LAYOUT_INVALID', reason: 'unknown_field' });
});

test('a revision number that is not a whole number of at least 1 is refused', () => {
  for (const revision of [0, -1, 1.5, '1', null, 1e300]) assert.equal(refusal(parseLayoutFile(text(doc(revision as number)), TABLE))?.code, 'GAUGE_LAYOUT_INVALID', String(revision));
  assert.deepEqual(refusal(parseLayoutFile(text(doc(0)), TABLE)), { code: 'GAUGE_LAYOUT_INVALID', reason: 'bad_revision' });
});

test('more than 10 revisions is refused with too_many_revisions', () => {
  const revisions = Array.from({ length: 11 }, (_, index) => ({ revision: 11 - index, layout: HOME }));
  assert.deepEqual(refusal(parseLayoutFile(text(doc(12, HOME, revisions)), TABLE)), { code: 'GAUGE_LAYOUT_INVALID', reason: 'too_many_revisions' });
  assert.equal(parseLayoutFile(text(doc(12, HOME, revisions.slice(0, 10))), TABLE).ok, true);
});

test('revisions must fall one after the other and stay below the current number', () => {
  const entry = (revision: number) => ({ revision, layout: HOME });
  for (const revisions of [[entry(3), entry(3)], [entry(2), entry(3)], [entry(5)], [entry(4)], [entry(0)]]) {
    assert.deepEqual(refusal(parseLayoutFile(text(doc(4, HOME, revisions)), TABLE)), { code: 'GAUGE_LAYOUT_INVALID', reason: 'bad_revision' }, JSON.stringify(revisions.map(item => item.revision)));
  }
  assert.equal(parseLayoutFile(text(doc(4, HOME, [entry(3), entry(1)])), TABLE).ok, true);
});

test('a broken current layout is refused with its own reason, and a broken revision is refused too', () => {
  assert.deepEqual(refusal(parseLayoutFile(text(doc(1, { ...HOME, hidden: ['gauge-manager'], shelf: HOME.shelf.filter(id => id !== 'gauge-manager') })), TABLE)), { code: 'GAUGE_PROTECTED', reason: 'hidden' });
  assert.deepEqual(refusal(parseLayoutFile(text(doc(2, HOME, [{ revision: 1, layout: { ...HOME, grid: { columns: 5, unit: 200, gap: 12 } } }])), TABLE)), { code: 'GAUGE_LAYOUT_INVALID', reason: 'unsupported_grid' });
});

test('a revision may name a Gauge that is gone now, because it is checked against the Gauges only when it is restored', () => {
  const old = { ...HOME, shelf: [...HOME.shelf, 'gone-gauge'] };
  assert.equal(parseLayoutFile(text(doc(2, HOME, [{ revision: 1, layout: old }])), TABLE).ok, true);
});

test('a file with a byte order mark, bad bytes, a duplicate key, or a comment is refused', () => {
  const good = text(doc(1));
  assert.deepEqual(refusal(parseLayoutFile(`﻿${good}`, TABLE)), { code: 'GAUGE_LAYOUT_INVALID', reason: 'syntax' });
  assert.deepEqual(refusal(parseLayoutFile(Uint8Array.from([0xff, 0xfe]), TABLE)), { code: 'GAUGE_LAYOUT_INVALID', reason: 'not_utf8' });
  assert.deepEqual(refusal(parseLayoutFile(good.replace('{', '{"revision":1,'), TABLE)), { code: 'GAUGE_LAYOUT_INVALID', reason: 'duplicate_key' });
  assert.deepEqual(refusal(parseLayoutFile(`/* x */${good}`, TABLE)), { code: 'GAUGE_LAYOUT_INVALID', reason: 'comment' });
  for (const input of [undefined, null, 5, {}] as unknown[]) assert.deepEqual(refusal(parseLayoutFile(input as string, TABLE)), { code: 'GAUGE_LAYOUT_INVALID', reason: 'internal' });
});

test('a __proto__ key in a file is an unknown field', () => {
  assert.deepEqual(refusal(parseLayoutFile(text(doc(1)).replace('{', '{"__proto__":1,'), TABLE)), { code: 'GAUGE_LAYOUT_INVALID', reason: 'unknown_field' });
});
