// The client suite. It takes the core as a parameter, so the same suite runs against the fake core now and against the real core later.
// The core it is given must hold the Gauges in `expected`. The default list is written out here by hand, and it is not read from the
// fake core's own fixtures, so a wrong fake core fails the suite. A real core can pass its own list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreClient } from '../src/client.js';
import type { Core, GaugeSummary } from '../src/types.js';

/** The Gauges the suite expects the core to hold, in order. */
export const DEFAULT_EXPECTED: readonly GaugeSummary[] = [
  { id: 'fixture-manager', title: 'Fixture Manager', version: '1.0.0', kind: 'ui', origin: 'stock', protected: true },
  { id: 'fixture-clock', title: 'Fixture Clock', version: '1.2.0', kind: 'ui', origin: 'stock', protected: false },
  { id: 'fixture-preset', title: 'Fixture Preset', version: '0.1.0', kind: 'data', origin: 'third-party', protected: false },
];

/** Registers the client tests. `makeCore` gives a fresh core for each test, so no test depends on another. */
export function runClientSuite(name: string, makeCore: () => Core | Promise<Core>, expected: readonly GaugeSummary[] = DEFAULT_EXPECTED): void {
  const clientOf = async () => createCoreClient(await makeCore());

  test(`${name}: makeCore gives a distinct core on each call`, async () => {
    const one = await makeCore(), two = await makeCore();
    assert.notEqual(one, two);
  });

  test(`${name}: the client lists the Gauges the core holds`, async () => {
    assert.deepEqual(await (await clientOf()).listGauges(), { ok: true, value: expected });
  });

  if (expected === DEFAULT_EXPECTED) {
    test(`${name}: the list holds the three known ids, in order`, async () => {
      const result = await (await clientOf()).listGauges();
      assert.ok(result.ok);
      assert.deepEqual(result.value.map(gauge => gauge.id), ['fixture-manager', 'fixture-clock', 'fixture-preset']);
    });

    test(`${name}: the manager Gauge is protected and the clock Gauge is not`, async () => {
      const client = await clientOf();
      const manager = await client.getGauge('fixture-manager'), clock = await client.getGauge('fixture-clock');
      assert.ok(manager.ok && clock.ok);
      assert.equal(manager.value.protected, true);
      assert.equal(clock.value.protected, false);
    });

    test(`${name}: the clock Gauge has origin stock and the preset Gauge has origin third-party`, async () => {
      const client = await clientOf();
      const clock = await client.getGauge('fixture-clock'), preset = await client.getGauge('fixture-preset');
      assert.ok(clock.ok && preset.ok);
      assert.equal(clock.value.origin, 'stock');
      assert.equal(preset.value.origin, 'third-party');
    });
  }

  test(`${name}: the client reads one Gauge by its id`, async () => {
    const client = await clientOf();
    for (const gauge of expected) assert.deepEqual(await client.getGauge(gauge.id), { ok: true, value: gauge }, gauge.id);
  });

  test(`${name}: the client gets exactly UNKNOWN_GAUGE for each id that is not a Gauge`, async () => {
    const client = await clientOf();
    for (const id of ['no-such-gauge', '', '../escape', 'GAUGE\u0000', "x' OR '1'='1", '\u{1F4A5}']) {
      assert.deepEqual(await client.getGauge(id), { ok: false, code: 'UNKNOWN_GAUGE' }, JSON.stringify(id));
    }
  });

  test(`${name}: the same call gives the same answer twice`, async () => {
    const client = await clientOf();
    assert.deepEqual(await client.listGauges(), await client.listGauges());
  });
}
