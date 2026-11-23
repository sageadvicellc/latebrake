import test from 'node:test';
import assert from 'node:assert/strict';
import { COLUMNS, FULL_WIDTH_PX, GAP_PX, GRID, MAX_ROWS, UNIT_PX, columnsFor, sizeUnits, spanOn } from '../src/index.js';

test('the grid has 6 columns, a unit of 200 px, and a gap of 12 px', () => {
  assert.deepEqual(GRID, { columns: 6, unit: 200, gap: 12 });
  assert.equal(Object.isFrozen(GRID), true);
  assert.deepEqual([COLUMNS, UNIT_PX, GAP_PX], [6, 200, 12]);
});

test('the full home is 1,260 px wide', () => {
  assert.equal(FULL_WIDTH_PX, 1260);
});

test('the four sizes are small 1x1, medium 2x1, large 2x2, and full width x 2', () => {
  assert.deepEqual(sizeUnits('small'), { w: 1, h: 1 });
  assert.deepEqual(sizeUnits('medium'), { w: 2, h: 1 });
  assert.deepEqual(sizeUnits('large'), { w: 2, h: 2 });
  assert.deepEqual(sizeUnits('full'), { w: 6, h: 2 });
});

test('the grid has a fixed number of rows, so a tile cannot sit at any depth', () => {
  assert.equal(MAX_ROWS, 32);
});

test('a window drops columns when it is too narrow, and the count is exact at each edge', () => {
  const cases: readonly (readonly [number, number])[] = [
    [1260, 6], [1259, 5], [1048, 5], [1047, 4], [836, 4], [835, 3], [624, 3], [623, 2], [412, 2], [411, 1], [200, 1], [0, 1], [99999, 6],
  ];
  for (const [width, columns] of cases) assert.equal(columnsFor(width), columns, String(width));
});

test('the column count of a hostile width is still a count between 1 and 6', () => {
  for (const width of [NaN, -1, -Infinity, '1260' as unknown as number, undefined as unknown as number, null as unknown as number]) assert.equal(columnsFor(width), 1, String(width));
  assert.equal(columnsFor(Infinity), 6);
});

test('a tile is as wide as its size, and no wider than the columns that the window has', () => {
  assert.equal(spanOn('full', 6), 6);
  assert.equal(spanOn('full', 4), 4);
  assert.equal(spanOn('large', 1), 1);
  assert.equal(spanOn('medium', 3), 2);
  assert.equal(spanOn('small', 1), 1);
});

test('the four sizes are rectangles that are nested and anchored at the top left, so a smaller size always lies inside a bigger one', () => {
  const order = ['small', 'medium', 'large', 'full'] as const;
  for (let index = 1; index < order.length; index += 1) {
    const smaller = sizeUnits(order[index - 1] as (typeof order)[number]), bigger = sizeUnits(order[index] as (typeof order)[number]);
    assert.ok(smaller.w <= bigger.w && smaller.h <= bigger.h, `${order[index - 1]} in ${order[index]}`);
  }
});
