// A compile-time check: the type of an entry's code is the code type, so a caller can index the meanings with it and needs no cast.
// `npm run typecheck` fails when this stops compiling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GAUGE_ERRORS, GAUGE_MEANINGS, type GaugeCode } from '../src/index.js';

test('an entry code indexes the meanings without a cast', () => {
  for (const entry of GAUGE_ERRORS) {
    const code: GaugeCode = entry.code;
    const meaning: string = GAUGE_MEANINGS[entry.code];
    assert.equal(meaning, entry.meaning, code);
  }
});
