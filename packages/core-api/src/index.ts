/** The Core API client and the fake core. See `README.md`. */
export { CoreProtocolError, createCoreClient } from './client.js';
export type { CoreClient } from './client.js';
export { createFakeCore } from './fake-core.js';
export { FIXTURE_GAUGES } from './fixtures.js';
export type { Core, CoreMethod, CoreReply, CoreResult, GaugeSummary } from './types.js';
