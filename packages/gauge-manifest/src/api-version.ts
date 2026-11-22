/** The version of the Core API that this app offers. A Gauge that needs a newer one is refused at load. */
export const CORE_API_VERSION = '1.0.0';

/** Three numbers: major, minor, patch. */
export type Version = readonly [number, number, number];

const NUMBER = '(0|[1-9][0-9]{0,8})';
const VERSION = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}$`);
const COMPARATOR = new RegExp(`^(>=|<=|>|<|=)${NUMBER}\\.${NUMBER}\\.${NUMBER}$`);

/** Reads `1.2.3`: three numbers with no leading zero and nothing else. Gives `undefined` for any other text. */
export function parseVersion(text: string): Version | undefined {
  const match = VERSION.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export type Operator = '>=' | '<=' | '>' | '<' | '=';
export interface Comparator {
  readonly operator: Operator;
  readonly version: Version;
}
/** One or two comparators. A version is in the range when it passes each one. */
export type Range = readonly Comparator[];

/** Reads a range such as `>=1.0.0 <2.0.0`: one or two comparators joined by one space. Gives `undefined` for any other text. */
export function parseRange(text: string): Range | undefined {
  const parts = text.split(' ');
  if (parts.length < 1 || parts.length > 2) return undefined;
  const comparators: Comparator[] = [];
  for (const part of parts) {
    const match = COMPARATOR.exec(part);
    if (!match) return undefined;
    comparators.push({ operator: match[1] as Operator, version: [Number(match[2]), Number(match[3]), Number(match[4])] });
  }
  return comparators;
}

/** True when the version passes every comparator of the range. */
export function rangeIncludes(range: Range, version: Version): boolean {
  return range.every(({ operator, version: bound }) => {
    const order = compareVersions(version, bound);
    switch (operator) {
      case '>=': return order >= 0;
      case '<=': return order <= 0;
      case '>': return order > 0;
      case '<': return order < 0;
      case '=': return order === 0;
    }
  });
}

/** Gives -1, 0, or 1 as the first version is lower than, equal to, or higher than the second. */
export function compareVersions(a: Version, b: Version): -1 | 0 | 1 {
  for (let index = 0; index < 3; index += 1) if (a[index]! !== b[index]!) return a[index]! < b[index]! ? -1 : 1;
  return 0;
}

/**
 * True when at least one version passes every comparator. The versions that pass form one interval, and an interval of versions has a lowest
 * version, which is `0.0.0`, a bound of a comparator, or the version just above a bound. So it is enough to try those.
 */
export function rangeIsSatisfiable(range: Range): boolean {
  const candidates: Version[] = [[0, 0, 0]];
  for (const { version } of range) candidates.push(version, [version[0], version[1], version[2] + 1]);
  return candidates.some(candidate => rangeIncludes(range, candidate));
}
