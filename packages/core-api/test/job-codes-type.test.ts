// A compile-time check: the job and run codes of the Core API are exactly the codes of the registry that start with GAUGE_JOB_ or GAUGE_RUN_. `npm run typecheck` fails when a code is added to the registry or to the list and not to the other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GAUGE_CODES } from '../../gauge-errors/src/index.js';
import { JOB_CODES, type Exactly, type JobCodesMatchRegistry } from '../src/types.js';

test('the type that ties the job and run codes to the registry holds, and it fails when the two differ', () => {
  const holds: JobCodesMatchRegistry = true;
  // @ts-expect-error a list that lacks a code is not the same set
  const missing: Exactly<'GAUGE_JOB_A' | 'GAUGE_RUN_B', 'GAUGE_JOB_A'> = true;
  assert.deepEqual([holds, missing], [true, true]);
  assert.equal(JOB_CODES.length, 4);
  // The two codes that always carry a reason are the rest of the registry's job codes.
  assert.deepEqual(GAUGE_CODES.filter(code => code.startsWith('GAUGE_JOB_') || code.startsWith('GAUGE_RUN_')).sort(), [...JOB_CODES, 'GAUGE_JOB_INVALID', 'GAUGE_JOB_NOT_INTERACTIVE'].sort());
});
