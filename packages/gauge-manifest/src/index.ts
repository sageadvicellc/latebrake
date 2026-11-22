/** The Gauge manifest validator. The fixtures are for tests: import them from `./fixtures.js`. See `README.md`. */
export { CORE_API_VERSION, parseRange, parseVersion, rangeIncludes } from './api-version.js';
export type { Comparator, Range, Version } from './api-version.js';
export { MANIFEST_FORMAT, MAX_MANIFEST_BYTES, validateManifest } from './manifest.js';
export type { GaugeDependency, GaugeManifest, GaugePage, GaugeTile, ManifestReason, ManifestResult } from './manifest.js';
export { unsafeNameReason, unsafePathReason } from './paths.js';
export { looksLikeSecret } from './secrets.js';
export { parseStrictJson } from './strict-json.js';
