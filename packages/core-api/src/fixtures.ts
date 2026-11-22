import type { GaugeSummary } from './types.js';

/** Synthetic Gauges for the fake core and for the client suite. No real names, clients, or people. */
export const FIXTURE_GAUGES: readonly GaugeSummary[] = Object.freeze([
  Object.freeze({ id: 'fixture-manager', title: 'Fixture Manager', version: '1.0.0', kind: 'ui', origin: 'stock', protected: true }),
  Object.freeze({ id: 'fixture-clock', title: 'Fixture Clock', version: '1.2.0', kind: 'ui', origin: 'stock', protected: false }),
  Object.freeze({ id: 'fixture-preset', title: 'Fixture Preset', version: '0.1.0', kind: 'data', origin: 'third-party', protected: false }),
] as const satisfies readonly GaugeSummary[]);
