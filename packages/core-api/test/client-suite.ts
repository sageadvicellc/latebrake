// The client suite. It takes the core as a parameter, so the same suite runs against the fake core now and against the real core later.
// The core it is given must hold the fixture Gauges of `FIXTURE_GAUGES`. Each test states one behaviour a Gauge can rely on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isGaugeCode } from '../../gauge-errors/src/index.js';
import { createCoreClient } from '../src/client.js';
import { FIXTURE_GAUGES } from '../src/fixtures.js';
import type { Core } from '../src/types.js';

/** Registers the client tests. `makeCore` gives a fresh core for each test, so no test depends on another. */
export function runClientSuite(name: string, makeCore: () => Core | Promise<Core>): void {
  const clientOf = async () => createCoreClient(await makeCore());

  test(`${name}: the client lists the Gauges the core holds`, async () => {
    const result = await (await clientOf()).listGauges();
    assert.deepEqual(result, { ok: true, value: FIXTURE_GAUGES });
  });

  test(`${name}: the client reads one Gauge by its id`, async () => {
    const [first] = FIXTURE_GAUGES;
    assert.ok(first);
    const result = await (await clientOf()).getGauge(first.id);
    assert.deepEqual(result, { ok: true, value: first });
  });

  test(`${name}: the client gets UNKNOWN_GAUGE for an id no Gauge has`, async () => {
    const result = await (await clientOf()).getGauge('no-such-gauge');
    assert.deepEqual(result, { ok: false, code: 'UNKNOWN_GAUGE' });
  });

  test(`${name}: a refusal code is always a code of the registry`, async () => {
    const client = await clientOf();
    for (const id of ['', '../escape', 'GAUGE\u0000', "x' OR '1'='1", '\u{1F4A5}']) {
      const result = await client.getGauge(id);
      assert.equal(result.ok, false, id);
      if (!result.ok) assert.equal(isGaugeCode(result.code), true, id);
    }
  });

  test(`${name}: the same call gives the same answer twice`, async () => {
    const client = await clientOf();
    assert.deepEqual(await client.listGauges(), await client.listGauges());
  });
}
