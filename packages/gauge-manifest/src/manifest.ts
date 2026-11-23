import { type GaugeCode } from '../../gauge-errors/src/index.js';
import { CORE_API_VERSION, parseRange, parseVersion, rangeIncludes, rangeIsSatisfiable } from './api-version.js';
import { unsafeNameReason, unsafePathReason } from './paths.js';
import { isPermission } from './permissions.js';
import { looksLikeSecret } from './secrets.js';
import { parseStrictJson, type JsonProblem, type JsonValue } from './strict-json.js';

/** The largest manifest, in bytes of UTF-8. A manifest of exactly this size passes. */
export const MAX_MANIFEST_BYTES = 16 * 1024;
/** The only format of this version. New formats keep the `bowerloom/` prefix until the rename. */
export const MANIFEST_FORMAT = 'bowerloom/gauge/1';

/** The four tile sizes, in order: small 1x1, medium 2x1, large 2x2, and full (every column) x 2. The grid itself is in `packages/gauge-layout`. */
export const TILE_SIZES = Object.freeze(['small', 'medium', 'large', 'full'] as const);
export type TileSize = (typeof TILE_SIZES)[number];

export interface GaugeTile {
  readonly expandable: boolean;
  readonly resizable: boolean;
  /** The file that draws the tile. `null` for a data Gauge, which holds no code. */
  readonly entry: string | null;
  /** Size hints: the sizes the tile allows, the first one preferred. Present only when the manifest declares them. A tile that cannot be resized names one size at most. */
  readonly sizes?: readonly TileSize[];
}
export interface GaugePage {
  readonly entry: string;
}
export interface GaugeDependency {
  readonly id: string;
  /** The versions of the other Gauge that this Gauge works with. */
  readonly range: string;
}

/**
 * A manifest that passed every rule. It has no `origin`: the core sets that from where it found the folder, and a manifest cannot set it.
 * `tile` and `page` are `null` when the Gauge has none.
 */
export interface GaugeManifest {
  readonly format: typeof MANIFEST_FORMAT;
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly coreApi: string;
  readonly kind: 'ui' | 'data';
  readonly protected: boolean;
  readonly engines: readonly string[];
  readonly tile: GaugeTile | null;
  readonly page: GaugePage | null;
  readonly permissions: readonly string[];
  readonly dependencies: readonly GaugeDependency[];
}

/**
 * Every reason a refusal can have, as a closed set. The code says what class of refusal it is, and the reason says which rule. A reason that holds
 * a value of a manifest never appears: the set is fixed, so a reason can never repeat a secret.
 */
export const MANIFEST_REASONS = [
  'duplicate_key', 'comment', 'trailing_comma', 'syntax',
  'not_utf8', 'too_large', 'secret', 'unknown_field', 'origin_set_by_core', 'missing_field', 'invalid_field',
  'unsupported_format', 'unsupported_kind', 'api_unsupported', 'unknown_permission',
  'link', 'hidden_name', 'dotdot_name', 'device_name', 'absolute_path', 'unsafe_folder_name',
  'internal',
] as const;

export type ManifestReason = (typeof MANIFEST_REASONS)[number];

const REASONS: ReadonlySet<string> = new Set(MANIFEST_REASONS);

/** True when the value is one of the reasons of the closed set. */
export function isManifestReason(value: unknown): value is ManifestReason {
  return typeof value === 'string' && REASONS.has(value);
}

// A compile-time check: a problem of the JSON reader is always a reason of this set.
const jsonProblemsAreReasons: JsonProblem extends ManifestReason ? true : never = true;
void jsonProblemsAreReasons;

/** The codes a manifest check can give. */
export type ManifestCode = 'GAUGE_MANIFEST_INVALID' | 'GAUGE_MANIFEST_TOO_LARGE' | 'GAUGE_PATH_UNSAFE' | 'GAUGE_SECRET_FOUND' | 'GAUGE_API_UNSUPPORTED';
// A compile-time check: a manifest code is a code of the registry.
const manifestCodesAreCodes: ManifestCode extends GaugeCode ? true : never = true;
void manifestCodesAreCodes;

export type ManifestResult =
  | { readonly ok: true; readonly manifest: GaugeManifest }
  | { readonly ok: false; readonly code: ManifestCode; readonly reason: ManifestReason };

class Refused extends Error {
  constructor(readonly code: ManifestCode, readonly reason: ManifestReason) { super(reason); }
}
function invalid(reason: ManifestReason = 'invalid_field'): never {
  throw new Refused('GAUGE_MANIFEST_INVALID', reason);
}

type Obj = { readonly [key: string]: JsonValue };
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Checks an object has only the allowed keys and all the required ones. */
function shape(value: JsonValue | undefined, required: readonly string[], optional: readonly string[] = []): Obj {
  if (!isObject(value)) return invalid();
  const keys = Object.keys(value);
  if (keys.includes('origin')) throw new Refused('GAUGE_MANIFEST_INVALID', 'origin_set_by_core');
  if (keys.some(key => !required.includes(key) && !optional.includes(key))) return invalid('unknown_field');
  if (required.some(key => !keys.includes(key))) return invalid('missing_field');
  return value;
}

/** Control, format, line-separator, and paragraph-separator characters, and the fillers that draw nothing: Hangul fillers, Braille blank, and the halfwidth Hangul filler. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u3164\u2800\u115F\u1160\uFFA0]/u;
const WHITESPACE_OR_INVISIBLE = /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u3164\u2800\u115F\u1160\uFFA0]/gu;
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PERMISSION = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;

function text(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : invalid();
}
function flag(value: JsonValue | undefined): boolean {
  return typeof value === 'boolean' ? value : invalid();
}
/** A name of a Gauge or an engine: checked as a name first (link, dots, hidden), then by shape. */
function name(value: JsonValue | undefined): string {
  const id = text(value);
  const reason = unsafeNameReason(id);
  if (reason) throw new Refused('GAUGE_PATH_UNSAFE', reason);
  return id.length <= 64 && NAME.test(id) ? id : invalid();
}
function entry(value: JsonValue | undefined): string {
  const path = text(value);
  if (path.length > 200) return invalid();
  const reason = unsafePathReason(path);
  if (reason === 'invalid_path') return invalid();
  if (reason) throw new Refused('GAUGE_PATH_UNSAFE', reason);
  // An entry names a file, so its last segment ends in a dot and an extension of letters and digits.
  if (!/[^.]\.[A-Za-z0-9]+$/.test(path.slice(path.lastIndexOf('/') + 1))) return invalid();
  return path;
}
/** Size hints: one to four names of the closed set, once each. A tile that cannot be resized names one size at most, since it has no other to offer. */
function sizeHints(value: JsonValue | undefined, resizable: boolean): readonly TileSize[] {
  const names = unique(list(value, TILE_SIZES.length).map((item): TileSize => {
    const found = TILE_SIZES.find(size => size === item);
    return found ?? invalid();
  }));
  if (names.length === 0 || (!resizable && names.length > 1)) return invalid();
  return Object.freeze([...names]);
}
function list(value: JsonValue | undefined, most: number): readonly JsonValue[] {
  return Array.isArray(value) && value.length <= most ? value : invalid();
}
function unique<T>(items: readonly T[]): readonly T[] {
  return new Set(items).size === items.length ? items : invalid();
}

function build(value: JsonValue): GaugeManifest {
  const fields = shape(value, ['format', 'id', 'title', 'version', 'coreApi', 'kind', 'protected', 'engines', 'permissions', 'dependencies'], ['tile', 'page']);
  if (typeof fields['format'] !== 'string') invalid();
  if (fields['format'] !== MANIFEST_FORMAT) invalid('unsupported_format');
  const id = name(fields['id']);
  const title = text(fields['title']);
  // A title shows a person who made the Gauge, so it has no control, format, or separator character, no invisible filler, and at least one visible character.
  if (title.length < 1 || title.length > 80 || title.trim() !== title || INVISIBLE.test(title) || title.replace(WHITESPACE_OR_INVISIBLE, '') === '') invalid();
  const version = text(fields['version']);
  if (!parseVersion(version)) invalid();
  const coreApi = text(fields['coreApi']);
  const range = parseRange(coreApi) ?? invalid();
  if (!rangeIsSatisfiable(range)) invalid();
  const kindText = text(fields['kind']);
  if (kindText === 'process' || kindText === 'adapter') invalid('unsupported_kind');
  if (kindText !== 'ui' && kindText !== 'data') invalid();
  const kind: 'ui' | 'data' = kindText;
  const isProtected = flag(fields['protected']);
  const engines = unique(list(fields['engines'], 16).map(name));

  let tile: GaugeTile | null = null;
  if (Object.hasOwn(fields, 'tile')) {
    const t = shape(fields['tile'], ['expandable', 'resizable'], ['entry', 'sizes']);
    const hasEntry = Object.hasOwn(t, 'entry');
    if (kind === 'ui' && !hasEntry) invalid('missing_field');
    if (kind === 'data' && hasEntry) invalid();
    const expandable = flag(t['expandable']), resizable = flag(t['resizable']);
    const sizes = Object.hasOwn(t, 'sizes') ? sizeHints(t['sizes'], resizable) : undefined;
    tile = Object.freeze({ expandable, resizable, entry: hasEntry ? entry(t['entry']) : null, ...(sizes ? { sizes } : {}) });
  }
  let page: GaugePage | null = null;
  if (Object.hasOwn(fields, 'page')) {
    if (kind === 'data') invalid();
    page = Object.freeze({ entry: entry(shape(fields['page'], ['entry'])['entry']) });
  }
  if (kind === 'ui' && !tile && !page) invalid();
  if (tile?.expandable && !page) invalid();

  const permissions = unique(list(fields['permissions'], 64).map(item => {
    const permission = text(item);
    if (permission.length > 64 || !PERMISSION.test(permission)) return invalid();
    // The shape is checked first. A well-formed name must also be in the permission list: a Gauge cannot invent a permission.
    return isPermission(permission) ? permission : invalid('unknown_permission');
  }));
  const dependencies = list(fields['dependencies'], 32).map((item): GaugeDependency => {
    const dependency = shape(item, ['id', 'range']);
    const dependencyId = name(dependency['id']);
    const dependencyRange = text(dependency['range']);
    const parsedRange = parseRange(dependencyRange);
    if (dependencyId === id || !parsedRange || !rangeIsSatisfiable(parsedRange)) invalid();
    return Object.freeze({ id: dependencyId, range: dependencyRange });
  });
  unique(dependencies.map(dependency => dependency.id));

  const current = parseVersion(CORE_API_VERSION);
  if (!current || !rangeIncludes(range, current)) throw new Refused('GAUGE_API_UNSUPPORTED', 'api_unsupported');

  return Object.freeze({
    format: MANIFEST_FORMAT, id, title, version, coreApi, kind, protected: isProtected,
    engines: Object.freeze([...engines]), tile, page, permissions: Object.freeze([...permissions]), dependencies: Object.freeze(dependencies),
  });
}

/**
 * Checks one `gauge.json`, given as text or as UTF-8 bytes. It gives the manifest, or a stable code and the reason. The order of the checks is fixed:
 * the size cap in bytes, UTF-8, strict JSON (no duplicate key, comment, or trailing comma), the secret scan over every key and value, then the fields.
 * A manifest that sets `origin` is refused: the core sets it. A Gauge that needs a Core API version this app does not offer is refused at the end.
 * The refusal never repeats the text of the manifest, so it never repeats a secret. This function never throws. A bug of its own is `internal`.
 */
export function validateManifest(input: string | Uint8Array): ManifestResult {
  try {
    // Only text and bytes are inputs. Anything else is a bug in the caller, so it is `internal` and not bad JSON.
    if (typeof input !== 'string' && !(input instanceof Uint8Array)) throw new Error('input is not text or bytes');
    const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
    if (bytes.byteLength > MAX_MANIFEST_BYTES) throw new Refused('GAUGE_MANIFEST_TOO_LARGE', 'too_large');
    let source: string;
    try {
      source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new Refused('GAUGE_MANIFEST_INVALID', 'not_utf8');
    }
    const parsed = parseStrictJson(source);
    if (!parsed.ok) throw new Refused('GAUGE_MANIFEST_INVALID', parsed.reason);
    if (parsed.strings.some(looksLikeSecret)) throw new Refused('GAUGE_SECRET_FOUND', 'secret');
    return { ok: true, manifest: build(parsed.value) };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, code: error.code, reason: error.reason };
    // A check that broke is a bug here and not a fault of the manifest. It is told apart from a real syntax problem, so a test can see it.
    return { ok: false, code: 'GAUGE_MANIFEST_INVALID', reason: 'internal' };
  }
}
