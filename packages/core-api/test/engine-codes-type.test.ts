// A compile-time check: the engine codes of the Core API are exactly the codes of the registry that hold the word ENGINE. `npm run typecheck` fails when a code is added to the registry or to the list and not to the other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_CODES, type EngineCodesMatchRegistry, type Exactly } from '../src/types.js';

test('the type that ties the engine codes to the registry holds, and it fails when the two differ', () => {
  const holds: EngineCodesMatchRegistry = true;
  const same: Exactly<'A' | 'B', 'B' | 'A'> = true;
  // @ts-expect-error a list that lacks a code is not the same set
  const missing: Exactly<'A' | 'B', 'A'> = true;
  // @ts-expect-error a list that has an extra code is not the same set
  const extra: Exactly<'A', 'A' | 'B'> = true;
  assert.deepEqual([holds, same, missing, extra], [true, true, true, true]);
  assert.equal(ENGINE_CODES.length, 7);
});
