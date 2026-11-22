/** Why a name or a path is unsafe. Each reason belongs to the code `GAUGE_PATH_UNSAFE`, except `invalid_path`, which is a plain invalid field. */
export type PathReason = 'link' | 'hidden_name' | 'dotdot_name' | 'device_name' | 'absolute_path' | 'invalid_path';

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
/** A Windows device name, in any case, with or without an extension: `CON`, `PRN`, `AUX`, `NUL`, `COM1` to `COM9`, and `LPT1` to `LPT9`. */
const DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Why one name is unsafe, or `undefined` when it is safe. The checks run in this order: a link (a URL scheme such as `https:` or a leading `//`),
 * a name with two dots in a row (`a..b`), and a hidden name (a leading dot, which includes `.`).
 */
export function unsafeNameReason(name: string): Exclude<PathReason, 'absolute_path' | 'invalid_path'> | undefined {
  if (SCHEME.test(name) || name.startsWith('//')) return 'link';
  if (name.includes('..')) return 'dotdot_name';
  if (name.startsWith('.')) return 'hidden_name';
  if (DEVICE.test(name)) return 'device_name';
  return undefined;
}

/**
 * Why a relative path inside a Gauge folder is unsafe, or `undefined` when it is safe. A link is refused first, then an absolute path, then each
 * segment is checked as a name. A path that is empty, has an empty segment (`a//b`, a trailing slash), or holds a character outside letters,
 * digits, dot, underscore, and hyphen is `invalid_path`.
 */
export function unsafePathReason(path: string): PathReason | undefined {
  if (SCHEME.test(path) || path.startsWith('//')) return 'link';
  if (path.startsWith('/')) return 'absolute_path';
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '') return 'invalid_path';
    const reason = unsafeNameReason(segment);
    if (reason) return reason;
  }
  return segments.every(segment => SEGMENT.test(segment)) ? undefined : 'invalid_path';
}
