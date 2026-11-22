/** The Core API client and its types. The fake core and its fixtures are for tests: import them from `./fake-core.js` and `./fixtures.js`. See `README.md`. */
export { CoreProtocolError, createCoreClient } from './client.js';
export type { CoreClient } from './client.js';
export type { Core, CoreMethod, CoreReply, CoreResult, GaugeSummary } from './types.js';
