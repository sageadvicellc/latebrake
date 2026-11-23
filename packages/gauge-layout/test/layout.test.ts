import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYOUT_REASONS, MAX_LAYOUT_BYTES, MAX_LISTED, MAX_TILES, PROTECTED_REASONS, canonicalText, checkLayout, defaultLayout, isLayoutReason, isProtectedReason, layoutOf, parseLayout, parseLayoutText,
  tileInfoOf, type GaugeTable, type Layout,
} from '../src/index.js';
import { HOME, TABLE, homeText } from './table.js';

const refusal = (result: { readonly ok: boolean; readonly code?: string; readonly reason?: string }) => (result.ok ? undefined : { code: result.code, reason: result.reason });
const parse = (input: string | Uint8Array, table: GaugeTable = TABLE) => refusal(parseLayout(input, table));
const ALL = ['engines-usage', 'jobs', 'harnesses', 'local-models', 'memory-explorer', 'projects', 'library', 'tracing', 'gauge-manager', 'fixed-clock', 'page-only', 'settings'];
type Placed = { place: string; gauge: string; default: string; col: number; row: number; size: string };
/** A layout with these tiles, and every other Gauge on the shelf, so that nothing but the tiles can be wrong. */
const arranged = (tiles: readonly Placed[], hidden: readonly string[] = []) => homeText(home => ({
  ...home, tiles, hidden, shelf: ALL.filter(id => !tiles.some(tile => tile.gauge === id) && !hidden.includes(id)).sort(),
}));
const parsed = (text: string): Layout => {
  const result = parseLayout(text, TABLE);
  assert.ok(result.ok, JSON.stringify(refusal(result)));
  return result.layout;
};

test('the home that the spec names parses, and it comes back as a frozen record in canonical order', () => {
  const layout = parsed(homeText());
  assert.deepEqual(layout, HOME);
  assert.equal(Object.isFrozen(layout), true);
  assert.equal(Object.isFrozen(layout.tiles), true);
  assert.equal(Object.isFrozen(layout.tiles[0]), true);
  assert.equal(Object.isFrozen(layout.grid), true);
  assert.equal(Object.isFrozen(layout.shelf), true);
});

test('the default layout is the five default tiles in the arrangement of the home, with the rest one step away', () => {
  const layout = defaultLayout(TABLE);
  assert.deepEqual(layout, HOME);
});

test('the default layout holds exactly the Gauges it can place, and stays a valid layout for any set of Gauges', () => {
  const tables: GaugeTable[] = [new Map(), new Map([['jobs', TABLE.get('jobs')!]]), new Map([...TABLE].filter(([id]) => id !== 'harnesses')), new Map([...TABLE].map(([id, info]) => [id, { ...info, enabled: id !== 'jobs' }]))];
  for (const table of tables) assert.equal(checkLayout(defaultLayout(table), table), undefined);
  assert.deepEqual(defaultLayout(new Map()).tiles, []);
  assert.deepEqual(defaultLayout(new Map()).shelf, ['settings']);
  const without = defaultLayout(new Map([...TABLE].map(([id, info]) => [id, { ...info, enabled: id !== 'jobs' }])));
  assert.deepEqual(without.tiles.map(tile => tile.gauge), ['engines-usage', 'harnesses', 'local-models', 'memory-explorer']);
  assert.equal(without.shelf.includes('jobs'), false);
});

test('a default tile whose size its Gauge does not allow is left off the home, and the Gauge goes on the shelf', () => {
  const table: GaugeTable = new Map(TABLE).set('jobs', { enabled: true, protected: false, tile: { resizable: false, sizes: ['small'] } });
  const layout = defaultLayout(table);
  assert.equal(layout.tiles.some(tile => tile.gauge === 'jobs'), false);
  assert.equal(layout.shelf.includes('jobs'), true);
  assert.equal(checkLayout(layout, table), undefined);
});

test('the canonical text is one line of compact JSON with the fields in a fixed order and one line feed at the end', () => {
  const text = canonicalText(parsed(homeText()));
  assert.equal(text, '{"format":"bowerloom/layout/1","grid":{"columns":6,"unit":200,"gap":12},"tiles":['
    + '{"place":"engines","gauge":"engines-usage","default":"engines-usage","col":0,"row":0,"size":"large"},'
    + '{"place":"jobs","gauge":"jobs","default":"jobs","col":2,"row":0,"size":"large"},'
    + '{"place":"harnesses","gauge":"harnesses","default":"harnesses","col":4,"row":0,"size":"medium"},'
    + '{"place":"models","gauge":"local-models","default":"local-models","col":4,"row":1,"size":"small"},'
    + '{"place":"memory","gauge":"memory-explorer","default":"memory-explorer","col":5,"row":1,"size":"small"}],'
    + '"shelf":["fixed-clock","gauge-manager","library","page-only","projects","settings","tracing"],"hidden":[]}\n');
});

test('export then import gives the same layout, in the same bytes', () => {
  const first = parsed(homeText());
  const again = parsed(canonicalText(first));
  assert.deepEqual(again, first);
  assert.equal(canonicalText(again), canonicalText(first));
});

test('an order that is not canonical is sorted on import: tiles by row then column then place, lists by code unit', () => {
  const layout = parsed(homeText(home => ({ ...home, tiles: [...home.tiles].reverse(), shelf: [...home.shelf].reverse() })));
  assert.deepEqual(layout.tiles.map(tile => tile.place), ['engines', 'jobs', 'harnesses', 'models', 'memory']);
  assert.deepEqual(layout.shelf, [...HOME.shelf]);
});

test('the layout text may carry white space around its tokens', () => {
  assert.equal(parse(`\n  ${JSON.stringify(HOME, null, 2)}\n`), undefined);
});

// Text and strict JSON.
test('a text over the size cap is refused with too_large, and exactly the cap passes the size check', () => {
  assert.equal(MAX_LAYOUT_BYTES, 32768);
  const text = homeText();
  assert.deepEqual(parse(text + ' '.repeat(MAX_LAYOUT_BYTES + 1 - Buffer.byteLength(text))), { code: 'GAUGE_LAYOUT_INVALID', reason: 'too_large' });
  assert.equal(parse(text + ' '.repeat(MAX_LAYOUT_BYTES - Buffer.byteLength(text))), undefined);
});

test('a text that is longer than the cap in characters is refused with too_large before it is encoded', () => {
  const huge = ' '.repeat(MAX_LAYOUT_BYTES + 1);
  assert.deepEqual(parse(huge), { code: 'GAUGE_LAYOUT_INVALID', reason: 'too_large' });
  // Characters of more than one byte: the text is within the cap in characters and over it in bytes.
  const wide = `${homeText().slice(0, -1)},"x":"${'\u00E9'.repeat(MAX_LAYOUT_BYTES / 2)}"}`;
  assert.deepEqual(parse(wide), { code: 'GAUGE_LAYOUT_INVALID', reason: 'too_large' });
});

test('a layout of 10,000 tiles is refused by the size cap, before any tile is read', () => {
  const tiles = Array.from({ length: 10_000 }, (_, index) => ({ place: `p${index}`, gauge: 'jobs', default: 'jobs', col: 0, row: 0, size: 'small' }));
  assert.deepEqual(parse(homeText(home => ({ ...home, tiles }))), { code: 'GAUGE_LAYOUT_INVALID', reason: 'too_large' });
});

test('more tiles than the cap, in few bytes, is refused with too_many_tiles', () => {
  const tiles = Array.from({ length: MAX_TILES + 1 }, (_, index) => ({ place: `p${index}`, gauge: 'a', default: 'a', col: 0, row: 0, size: 'small' }));
  const text = homeText(home => ({ ...home, tiles }));
  assert.ok(Buffer.byteLength(text) < MAX_LAYOUT_BYTES);
  assert.deepEqual(parse(text), { code: 'GAUGE_LAYOUT_INVALID', reason: 'too_many_tiles' });
});

test('a shelf or a hidden list over its cap is refused with too_many_listed', () => {
  const names = Array.from({ length: MAX_LISTED + 1 }, (_, index) => `g${index}`);
  assert.deepEqual(parse(homeText(home => ({ ...home, shelf: names }))), { code: 'GAUGE_LAYOUT_INVALID', reason: 'too_many_listed' });
  assert.deepEqual(parse(homeText(home => ({ ...home, hidden: names }))), { code: 'GAUGE_LAYOUT_INVALID', reason: 'too_many_listed' });
});

test('a layout with the most tiles and the longest names still fits under the size cap', () => {
  const name = (letter: string, index: number) => `${letter}${String(index).padStart(2, '0')}${'a'.repeat(61)}`;
  const tiles = Array.from({ length: MAX_TILES }, (_, index) => ({ place: name('p', index), gauge: name('g', index), default: name('d', index), col: (index % 3) * 2, row: Math.floor(index / 3), size: 'medium' }));
  const shelf = Array.from({ length: MAX_LISTED }, (_, index) => name('s', index)), hidden = Array.from({ length: MAX_LISTED }, (_, index) => name('h', index));
  const layout = layoutOf({ ...HOME, tiles, shelf, hidden }, { requireCanonical: false });
  assert.ok(layout.ok, JSON.stringify(refusal(layout)));
  assert.equal(layout.layout.tiles.length, 48);
  assert.equal(Buffer.byteLength(canonicalText(layout.layout)), 26050);
  assert.ok(Buffer.byteLength(canonicalText(layout.layout)) < MAX_LAYOUT_BYTES);
});

test('bytes that are not UTF-8 are refused with not_utf8', () => {
  assert.deepEqual(parse(Uint8Array.from([0xff, 0xfe, 0x7b])), { code: 'GAUGE_LAYOUT_INVALID', reason: 'not_utf8' });
});

test('a text with a byte order mark is refused with syntax, as text and as bytes', () => {
  assert.deepEqual(parse(`\uFEFF${homeText()}`), { code: 'GAUGE_LAYOUT_INVALID', reason: 'syntax' });
  assert.deepEqual(parse(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(homeText())])), { code: 'GAUGE_LAYOUT_INVALID', reason: 'syntax' });
});

test('strict JSON: a duplicate key, a comment, a trailing comma, and plain bad syntax each get their reason', () => {
  const text = homeText();
  assert.deepEqual(parse(text.replace('{', '{"hidden":[],')), { code: 'GAUGE_LAYOUT_INVALID', reason: 'duplicate_key' });
  assert.deepEqual(parse(`// note\n${text}`), { code: 'GAUGE_LAYOUT_INVALID', reason: 'comment' });
  assert.deepEqual(parse(`${text.slice(0, -1)},}`), { code: 'GAUGE_LAYOUT_INVALID', reason: 'trailing_comma' });
  for (const bad of ['', '{', 'null', '[]', '5', '"x"', 'true', `${text} x`, '{"a":1e999}']) assert.equal(parse(bad)?.code, 'GAUGE_LAYOUT_INVALID', bad);
});

test('a __proto__ key is an unknown field, never a change to any prototype', () => {
  assert.deepEqual(parse(homeText().replace('{', '{"__proto__":{"polluted":true},')), { code: 'GAUGE_LAYOUT_INVALID', reason: 'unknown_field' });
  const tile = { ...HOME.tiles[0] };
  Object.defineProperty(tile, '__proto__', { value: 1, enumerable: true });
  const text = JSON.stringify({ ...HOME, tiles: [tile] });
  assert.ok(text.includes('"__proto__":1'));
  assert.deepEqual(parse(text), { code: 'GAUGE_LAYOUT_INVALID', reason: 'unknown_field' });
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
});

test('an input that is not text or bytes is refused with internal, and it never throws', () => {
  for (const input of [undefined, null, 5, {}, []] as unknown[]) assert.deepEqual(parse(input as string), { code: 'GAUGE_LAYOUT_INVALID', reason: 'internal' }, String(input));
});

// The fields.
test('an unknown field and a missing field are refused, at every level', () => {
  const unknown = (change: (home: typeof HOME) => unknown) => parse(homeText(change));
  assert.deepEqual(unknown(home => ({ ...home, extra: 1 })), { code: 'GAUGE_LAYOUT_INVALID', reason: 'unknown_field' });
  assert.deepEqual(unknown(home => ({ ...home, grid: { ...home.grid, extra: 1 } })), { code: 'GAUGE_LAYOUT_INVALID', reason: 'unknown_field' });
  assert.deepEqual(unknown(home => ({ ...home, tiles: [{ ...home.tiles[0], extra: 1 }] })), { code: 'GAUGE_LAYOUT_INVALID', reason: 'unknown_field' });
  for (const field of ['format', 'grid', 'tiles', 'shelf', 'hidden']) assert.deepEqual(unknown(home => { const copy: Record<string, unknown> = { ...home }; delete copy[field]; return copy; }), { code: 'GAUGE_LAYOUT_INVALID', reason: 'missing_field' }, field);
  for (const field of ['place', 'gauge', 'default', 'col', 'row', 'size']) assert.deepEqual(unknown(home => ({ ...home, tiles: [Object.fromEntries(Object.entries(home.tiles[0]!).filter(([key]) => key !== field))] })), { code: 'GAUGE_LAYOUT_INVALID', reason: 'missing_field' }, field);
});

test('a format that is not bowerloom/layout/1 is refused with unsupported_format', () => {
  for (const format of ['bowerloom/layout/2', 'layout', '', 'bowerloom/layout-file/1']) assert.deepEqual(parse(homeText(home => ({ ...home, format }))), { code: 'GAUGE_LAYOUT_INVALID', reason: 'unsupported_format' }, format);
  for (const format of [1, null, {}, []]) assert.deepEqual(parse(homeText(home => ({ ...home, format }))), { code: 'GAUGE_LAYOUT_INVALID', reason: 'invalid_field' }, JSON.stringify(format));
});

test('a grid that is not 6 columns, 200 px, and 12 px is refused with unsupported_grid', () => {
  for (const grid of [{ columns: 5, unit: 200, gap: 12 }, { columns: 6, unit: 100, gap: 12 }, { columns: 6, unit: 200, gap: 0 }, { columns: 6.5, unit: 200, gap: 12 }]) {
    assert.deepEqual(parse(homeText(home => ({ ...home, grid }))), { code: 'GAUGE_LAYOUT_INVALID', reason: 'unsupported_grid' }, JSON.stringify(grid));
  }
  for (const grid of [null, [], 'x', { columns: '6', unit: 200, gap: 12 }]) assert.equal(parse(homeText(home => ({ ...home, grid })))?.reason, 'invalid_field', JSON.stringify(grid));
});

test('every id and name that is not a plain lower-case name is refused with invalid_field, including ids that are not text', () => {
  const tile = (field: string, value: unknown) => homeText(home => ({ ...home, tiles: [{ ...home.tiles[0], [field]: value }] }));
  for (const field of ['place', 'gauge', 'default']) {
    for (const value of [5, null, true, [], {}, '', 'A', 'a b', 'a_b', '-a', 'a-', 'a--b', '../a', 'a/b', 'a'.repeat(65), '\u0000', '__proto__', 'constructor\n', '\u{1F4A5}', 'a\u200Bb', '\uFF41', 'caf\u00E9', 'a\u202Eb']) {
      assert.deepEqual(parse(tile(field, value)), { code: 'GAUGE_LAYOUT_INVALID', reason: 'invalid_field' }, `${field} ${JSON.stringify(value)}`);
    }
  }
  assert.equal(parse(homeText(home => ({ ...home, shelf: [5] })))?.reason, 'invalid_field');
  assert.equal(parse(homeText(home => ({ ...home, hidden: ['A'] })))?.reason, 'invalid_field');
  assert.equal(parse(homeText(home => ({ ...home, shelf: 'tracing' })))?.reason, 'invalid_field');
});

test('a size that is not small, medium, large, or full is refused with unknown_size, and a size that is not text with invalid_field', () => {
  const tile = (value: unknown) => homeText(home => ({ ...home, tiles: [{ ...home.tiles[0], size: value }] }));
  for (const value of ['huge', 'Large', '', 'toString', '__proto__', 'large ', '2x2']) assert.deepEqual(parse(tile(value)), { code: 'GAUGE_LAYOUT_INVALID', reason: 'unknown_size' }, JSON.stringify(value));
  for (const value of [2, null, { w: 7, h: 1 }, ['large'], true]) assert.deepEqual(parse(tile(value)), { code: 'GAUGE_LAYOUT_INVALID', reason: 'invalid_field' }, JSON.stringify(value));
});

test('a column or row that is fractional, huge, or not a number is refused with invalid_field', () => {
  const at = (field: string, value: string) => homeText(home => ({ ...home, tiles: [{ ...home.tiles[0], [field]: 'X' }] })).replace('"X"', value);
  for (const field of ['col', 'row']) {
    for (const value of ['1.5', '0.5', '1e300', '9007199254740992', '"1"', 'null', 'true', '[]', '{}', '-0', '-0.0']) {
      assert.deepEqual(parse(at(field, value)), { code: 'GAUGE_LAYOUT_INVALID', reason: 'invalid_field' }, `${field} ${value}`);
    }
  }
});

test('a tile that starts below zero, past the last column, or past the last row is refused with out_of_grid', () => {
  const place = (col: number, row: number, size = 'small') => parse(arranged([{ place: 'one', gauge: 'projects', default: 'projects', col, row, size }]));
  for (const [col, row] of [[-1, 0], [0, -1], [6, 0], [0, 32], [-9007199254740991, 0], [9007199254740991, 0]] as const) {
    assert.deepEqual(place(col, row), { code: 'GAUGE_LAYOUT_INVALID', reason: 'out_of_grid' }, `${col} ${row}`);
  }
});

test('a tile that ends past the grid is refused with out_of_grid, for every size', () => {
  const place = (col: number, row: number, size: string) => parse(arranged([{ place: 'one', gauge: 'projects', default: 'projects', col, row, size }]));
  assert.deepEqual(place(5, 0, 'medium'), { code: 'GAUGE_LAYOUT_INVALID', reason: 'out_of_grid' });
  assert.deepEqual(place(5, 0, 'large'), { code: 'GAUGE_LAYOUT_INVALID', reason: 'out_of_grid' });
  assert.deepEqual(place(1, 0, 'full'), { code: 'GAUGE_LAYOUT_INVALID', reason: 'out_of_grid' });
  assert.deepEqual(place(0, 31, 'large'), { code: 'GAUGE_LAYOUT_INVALID', reason: 'out_of_grid' });
  assert.deepEqual(place(0, 31, 'full'), { code: 'GAUGE_LAYOUT_INVALID', reason: 'out_of_grid' });
  assert.equal(place(4, 0, 'medium'), undefined);
  assert.equal(place(0, 30, 'full'), undefined);
  assert.equal(place(5, 31, 'small'), undefined);
});

test('two tiles that share a cell are refused with overlap, and tiles that only touch are not', () => {
  const two = (a: [number, number, string], b: [number, number, string]) => parse(arranged([
    { place: 'one', gauge: 'projects', default: 'projects', col: a[0], row: a[1], size: a[2] }, { place: 'two', gauge: 'library', default: 'library', col: b[0], row: b[1], size: b[2] },
  ]));
  assert.deepEqual(two([0, 0, 'large'], [1, 1, 'large']), { code: 'GAUGE_LAYOUT_INVALID', reason: 'overlap' });
  assert.deepEqual(two([0, 0, 'large'], [0, 0, 'large']), { code: 'GAUGE_LAYOUT_INVALID', reason: 'overlap' });
  assert.deepEqual(two([0, 0, 'full'], [5, 1, 'medium']), { code: 'GAUGE_LAYOUT_INVALID', reason: 'out_of_grid' });
  assert.deepEqual(two([0, 0, 'full'], [3, 1, 'large']), { code: 'GAUGE_LAYOUT_INVALID', reason: 'overlap' });
  assert.equal(two([0, 0, 'large'], [2, 0, 'large']), undefined);
  assert.equal(two([0, 0, 'large'], [0, 2, 'large']), undefined);
  assert.equal(two([0, 0, 'full'], [0, 2, 'large']), undefined);
});

test('a place used twice, and a Gauge used twice across the home, the shelf, and the hidden list, are refused', () => {
  const tiles = (...more: object[]) => homeText(home => ({ ...home, tiles: [...home.tiles, ...more] }));
  assert.deepEqual(parse(tiles({ place: 'engines', gauge: 'tracing', default: 'tracing', col: 0, row: 2, size: 'small' })), { code: 'GAUGE_LAYOUT_INVALID', reason: 'duplicate_place' });
  assert.deepEqual(parse(tiles({ place: 'extra', gauge: 'jobs', default: 'tracing', col: 0, row: 2, size: 'small' })), { code: 'GAUGE_LAYOUT_INVALID', reason: 'duplicate_gauge' });
  assert.deepEqual(parse(tiles({ place: 'extra', gauge: 'tracing', default: 'jobs', col: 0, row: 2, size: 'small' })), { code: 'GAUGE_LAYOUT_INVALID', reason: 'duplicate_gauge' });
  assert.deepEqual(parse(homeText(home => ({ ...home, shelf: [...home.shelf, 'jobs'] }))), { code: 'GAUGE_LAYOUT_INVALID', reason: 'duplicate_gauge' });
  assert.deepEqual(parse(homeText(home => ({ ...home, shelf: [...home.shelf, 'tracing'] }))), { code: 'GAUGE_LAYOUT_INVALID', reason: 'duplicate_gauge' });
  assert.deepEqual(parse(homeText(home => ({ ...home, hidden: ['tracing'] }))), { code: 'GAUGE_LAYOUT_INVALID', reason: 'duplicate_gauge' });
});

// The Gauges.
test('every Gauge id must exist and be enabled: an unknown id and a disabled one are refused, wherever they sit', () => {
  const shelf = (id: string) => parse(homeText(home => ({ ...home, shelf: [...home.shelf, id] })));
  assert.deepEqual(shelf('no-such-gauge'), { code: 'GAUGE_LAYOUT_INVALID', reason: 'unknown_gauge' });
  assert.deepEqual(shelf('sleeper'), { code: 'GAUGE_LAYOUT_INVALID', reason: 'gauge_disabled' });
  const hidden = (id: string) => parse(homeText(home => ({ ...home, hidden: [id] })));
  assert.deepEqual(hidden('no-such-gauge'), { code: 'GAUGE_LAYOUT_INVALID', reason: 'unknown_gauge' });
  assert.deepEqual(hidden('sleeper'), { code: 'GAUGE_LAYOUT_INVALID', reason: 'gauge_disabled' });
  const tile = (field: 'gauge' | 'default', id: string) => parse(homeText(home => ({ ...home, tiles: [{ ...home.tiles[0], [field]: id }] })));
  assert.deepEqual(tile('gauge', 'no-such-gauge'), { code: 'GAUGE_LAYOUT_INVALID', reason: 'unknown_gauge' });
  assert.deepEqual(tile('default', 'sleeper'), { code: 'GAUGE_LAYOUT_INVALID', reason: 'gauge_disabled' });
});

test('a Gauge with no tile cannot fill a place, and neither can the Settings page', () => {
  const tile = (id: string) => parse(arranged([{ place: 'one', gauge: id, default: id, col: 0, row: 0, size: 'small' }]));
  assert.deepEqual(tile('page-only'), { code: 'GAUGE_LAYOUT_INVALID', reason: 'no_tile' });
  assert.deepEqual(tile('settings'), { code: 'GAUGE_LAYOUT_INVALID', reason: 'no_tile' });
});

test('a layout may only use sizes that its Gauge allows', () => {
  const size = (gauge: string, value: string) => parse(arranged([{ place: 'one', gauge, default: gauge, col: 0, row: 0, size: value }]));
  assert.deepEqual(size('local-models', 'full'), { code: 'GAUGE_LAYOUT_INVALID', reason: 'size_not_allowed' });
  assert.deepEqual(size('engines-usage', 'small'), { code: 'GAUGE_LAYOUT_INVALID', reason: 'size_not_allowed' });
  assert.deepEqual(size('harnesses', 'small'), { code: 'GAUGE_LAYOUT_INVALID', reason: 'size_not_allowed' });
});

test('a tile whose Gauge is not resizable keeps its one size, and any other size is refused with not_resizable', () => {
  const size = (gauge: string, value: string) => parse(arranged([{ place: 'one', gauge, default: gauge, col: 0, row: 0, size: value }]));
  assert.deepEqual(size('fixed-clock', 'medium'), { code: 'GAUGE_LAYOUT_INVALID', reason: 'not_resizable' });
  assert.deepEqual(size('fixed-clock', 'full'), { code: 'GAUGE_LAYOUT_INVALID', reason: 'not_resizable' });
  assert.deepEqual(size('gauge-manager', 'small'), { code: 'GAUGE_LAYOUT_INVALID', reason: 'not_resizable' });
});

test('a tile with its Gauge in a size it allows passes, for the one size of a fixed tile and for each hint of a resizable one', () => {
  const size = (gauge: string, value: string) => parse(arranged([{ place: 'one', gauge, default: gauge, col: 0, row: 0, size: value }]));
  assert.equal(size('fixed-clock', 'small'), undefined);
  assert.equal(size('gauge-manager', 'medium'), undefined);
  assert.equal(size('local-models', 'large'), undefined);
  assert.equal(size('local-models', 'small'), undefined);
  assert.equal(size('engines-usage', 'full'), undefined);
});

// The way back.
test('a layout that hides the Gauge manager or Settings is refused with GAUGE_PROTECTED and the reason hidden', () => {
  for (const id of ['gauge-manager', 'settings', 'harnesses']) {
    const text = homeText(home => ({
      ...home, tiles: home.tiles.filter(tile => tile.gauge !== id), shelf: home.shelf.filter(entry => entry !== id), hidden: [id],
    }));
    assert.deepEqual(parse(text), { code: 'GAUGE_PROTECTED', reason: 'hidden' }, id);
  }
});

test('a layout that removes the Gauge manager or Settings from the shelf is refused with GAUGE_PROTECTED and the reason removed', () => {
  for (const id of ['gauge-manager', 'settings']) assert.deepEqual(parse(homeText(home => ({ ...home, shelf: home.shelf.filter(entry => entry !== id) }))), { code: 'GAUGE_PROTECTED', reason: 'removed' }, id);
  assert.deepEqual(parse(homeText(home => ({ ...home, tiles: home.tiles.filter(tile => tile.gauge !== 'harnesses') }))), { code: 'GAUGE_PROTECTED', reason: 'removed' });
});

test('a layout that replaces a protected Gauge in its place is refused with GAUGE_PROTECTED and the reason replaced', () => {
  assert.deepEqual(parse(homeText(home => ({ ...home, tiles: home.tiles.map(tile => (tile.place === 'harnesses' ? { ...tile, gauge: 'library' } : tile)), shelf: [...home.shelf.filter(id => id !== 'library'), 'harnesses'] }))), { code: 'GAUGE_PROTECTED', reason: 'replaced' });
});

test('a place of the default home keeps its protected Gauge even when the file edits both the Gauge and the default of the place', () => {
  const edited = homeText(home => ({
    ...home, tiles: home.tiles.map(tile => (tile.place === 'harnesses' ? { ...tile, gauge: 'projects', default: 'projects' } : tile)),
    shelf: [...home.shelf.filter(id => id !== 'projects'), 'harnesses'].sort(),
  }));
  assert.deepEqual(parse(edited), { code: 'GAUGE_PROTECTED', reason: 'replaced' });
  // A protected Gauge may leave the place when the place goes too: it is then reachable from the shelf.
  const without = homeText(home => ({ ...home, tiles: home.tiles.filter(tile => tile.place !== 'harnesses'), shelf: [...home.shelf, 'harnesses'].sort() }));
  assert.equal(parse(without), undefined);
});

test('a protected Gauge may sit on the shelf or on the home, and a layout with the Gauge manager as a tile is valid', () => {
  const onHome = homeText(home => ({ ...home, tiles: [...home.tiles, { place: 'manager', gauge: 'gauge-manager', default: 'gauge-manager', col: 0, row: 2, size: 'medium' }], shelf: home.shelf.filter(id => id !== 'gauge-manager') }));
  assert.equal(parse(onHome), undefined);
});

test('a protected Gauge that is disabled does not have to be reachable, and one that does not exist is not asked for', () => {
  const table: GaugeTable = new Map(TABLE).set('harnesses', { enabled: false, protected: true, tile: null });
  assert.equal(refusal(parseLayout(homeText(home => ({ ...home, tiles: home.tiles.filter(tile => tile.gauge !== 'harnesses') })), table)), undefined);
  const smaller: GaugeTable = new Map([...TABLE].filter(([id]) => id !== 'gauge-manager'));
  assert.equal(refusal(parseLayout(homeText(home => ({ ...home, shelf: home.shelf.filter(id => id !== 'gauge-manager') })), smaller)), undefined);
});

test('the checks have a fixed order: shape, then uniqueness, then the grid, then the Gauges, then the protected Gauges', () => {
  // This layout breaks one rule of each stage. Each removal of a defect exposes the next stage.
  const tiles = [
    { place: 'a', gauge: 'jobs', default: 'jobs', col: 0, row: 0, size: 'large' },
    { place: 'a', gauge: 'jobs', default: 'jobs', col: 0, row: 0, size: 'large' },
  ];
  const home = (change: object) => homeText(h => ({ ...h, hidden: ['gauge-manager', 'no-such-gauge'], shelf: [], ...change }));
  assert.equal(parse(home({ extra: 1 }))?.reason, 'unknown_field');
  assert.equal(parse(home({ tiles }))?.reason, 'duplicate_place');
  assert.equal(parse(home({ tiles: [tiles[0], { ...tiles[1], place: 'b', gauge: 'projects', default: 'projects' }] }))?.reason, 'overlap');
  assert.equal(parse(home({ tiles: [tiles[0], { ...tiles[1], place: 'b', gauge: 'projects', default: 'projects', col: 2 }] }))?.reason, 'unknown_gauge');
  assert.deepEqual(parse(home({ tiles: [tiles[0], { ...tiles[1], place: 'b', gauge: 'projects', default: 'projects', col: 2 }], hidden: ['gauge-manager'] })), { code: 'GAUGE_PROTECTED', reason: 'hidden' });
});

test('layoutOf reads own properties only, once, and never trusts a field it inherits', () => {
  const inherited = Object.create(HOME) as unknown;
  assert.equal(layoutOf(inherited, { requireCanonical: false }).ok, false);
  let reads = 0;
  const counting = { ...HOME, get format() { reads += 1; return reads === 1 ? 'bowerloom/layout/1' : 'other'; } };
  const result = layoutOf(counting, { requireCanonical: false });
  assert.equal(result.ok, true);
  assert.equal(reads, 1);
});

test('layoutOf refuses a list with a hole and a list that is not a list', () => {
  // eslint-disable-next-line no-sparse-arrays
  assert.equal(refusal(layoutOf({ ...HOME, shelf: ['library', , 'tracing'] }, { requireCanonical: false }))?.reason, 'invalid_field');
  assert.equal(refusal(layoutOf({ ...HOME, tiles: { length: 0 } }, { requireCanonical: false }))?.reason, 'invalid_field');
  assert.equal(refusal(layoutOf({ ...HOME, tiles: new Set() }, { requireCanonical: false }))?.reason, 'invalid_field');
});

test('layoutOf with requireCanonical refuses an order that is not canonical, and parseLayoutText sorts instead', () => {
  const shuffled = { ...HOME, shelf: [...HOME.shelf].reverse() };
  assert.deepEqual(refusal(layoutOf(shuffled, { requireCanonical: true })), { code: 'GAUGE_LAYOUT_INVALID', reason: 'not_canonical' });
  assert.deepEqual(refusal(layoutOf({ ...HOME, tiles: [...HOME.tiles].reverse() }, { requireCanonical: true })), { code: 'GAUGE_LAYOUT_INVALID', reason: 'not_canonical' });
  assert.equal(layoutOf(HOME, { requireCanonical: true }).ok, true);
  assert.equal(parseLayoutText(JSON.stringify(shuffled)).ok, true);
});

test('parseLayoutText checks the shape and the grid and no Gauge, so a core can use it for a reply', () => {
  assert.equal(parseLayoutText(homeText(home => ({ ...home, shelf: ['no-such-gauge'] }))).ok, true);
  assert.deepEqual(refusal(parseLayoutText(homeText(home => ({ ...home, tiles: [{ ...home.tiles[0], col: 9 }] })))), { code: 'GAUGE_LAYOUT_INVALID', reason: 'out_of_grid' });
});

test('the tile info of a manifest tile: no hints means every size for a resizable tile and small for a fixed one', () => {
  assert.deepEqual(tileInfoOf({ resizable: true }), { resizable: true, sizes: ['small', 'medium', 'large', 'full'] });
  assert.deepEqual(tileInfoOf({ resizable: false }), { resizable: false, sizes: ['small'] });
  assert.deepEqual(tileInfoOf({ resizable: true, sizes: ['large', 'small'] }), { resizable: true, sizes: ['large', 'small'] });
  assert.deepEqual(tileInfoOf({ resizable: false, sizes: ['medium'] }), { resizable: false, sizes: ['medium'] });
});

test('the reasons are closed sets of words with no repeat, and the guards agree', () => {
  assert.equal(new Set(LAYOUT_REASONS).size, LAYOUT_REASONS.length);
  assert.deepEqual([...PROTECTED_REASONS], ['hidden', 'removed', 'replaced']);
  for (const reason of LAYOUT_REASONS) assert.equal(isLayoutReason(reason), true, reason);
  for (const reason of PROTECTED_REASONS) assert.equal(isProtectedReason(reason), true, reason);
  for (const value of ['hidden', 'constructor', '', undefined, null, 5, '__proto__']) assert.equal(isLayoutReason(value), false, String(value));
  for (const value of ['overlap', 'constructor', '', undefined, null, 5]) assert.equal(isProtectedReason(value), false, String(value));
});
