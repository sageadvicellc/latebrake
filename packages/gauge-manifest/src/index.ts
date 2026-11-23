/** The Gauge manifest validator. The fixtures are for tests: import them from `./fixtures.js`. See `README.md`. */
export { CORE_API_VERSION, compareVersions, parseRange, parseVersion, rangeIncludes, rangeIsSatisfiable } from './api-version.js';
export type { Comparator, Range, Version } from './api-version.js';
export { MANIFEST_FORMAT, MANIFEST_REASONS, MAX_MANIFEST_BYTES, isManifestReason, validateManifest } from './manifest.js';
export type { GaugeDependency, GaugeManifest, GaugePage, GaugeTile, ManifestCode, ManifestReason, ManifestResult } from './manifest.js';
export { isUnsafeFolderName, unsafeNameReason, unsafePathReason } from './paths.js';
export { looksLikeSecret } from './secrets.js';
export { parseStrictJson } from './strict-json.js';
export { AUDIT_REASONS, GRANT_REASONS, PERMISSIONS, PERMISSION_KINDS, PERMISSION_NAMES, isAuditReason, isGrantReason, isPermission, isTracesPermission, permissionOf } from './permissions.js';
export type { AuditReason, GrantReason, PermissionEntry, PermissionKind, PermissionName } from './permissions.js';
