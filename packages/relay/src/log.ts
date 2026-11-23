import { escapeText } from '../../engine-sessions/src/text.js';

/**
 * The one log of the relay. Every line goes through `write`, which cuts out every hidden value (a session secret, a receipt, a fence nonce), shows every unsafe character as an escape, and cuts the line
 * at 1,024 characters, in that order (the cut comes last, and the values were cut out before it), so nothing derived from an engine or a program is ever printed raw. The message may hold any text. The log is the `log` option, and standard error by default. A log that throws is
 * reported on standard error with the same safe line, and the writer never sees it.
 */

const REDACTED = '[redacted]';
const MIN_HIDDEN_LENGTH = 6;
/** The longest line, in characters. */
export const MAX_LOG_LINE = 1024;
/** The most kinds of line that `once` remembers. A kind past it is dropped, so a flood cannot grow the set. */
const MAX_ONCE_KEYS = 64;

/**
 * Cuts every hidden value out of a text. Every place where any value occurs is a range, ranges that overlap are merged, and each merged range is replaced once by a mark, so two values where one ends inside the other
 * leave no tail of either. A value of fewer than 6 characters is not searched for.
 */
export function redactText(hidden: readonly string[], text: string): string {
  const found: [number, number][] = [];
  for (const value of hidden) {
    if (value.length < MIN_HIDDEN_LENGTH) continue;
    for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) found.push([at, at + value.length]);
  }
  found.sort((left, right) => left[0] - right[0]);
  const ranges: [number, number][] = [];
  for (const range of found) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && range[0] < last[1]) last[1] = Math.max(last[1], range[1]);
    else ranges.push([range[0], range[1]]);
  }
  let out = '', position = 0;
  for (const [start, end] of ranges) {
    out += text.slice(position, start) + REDACTED;
    position = end;
  }
  return out + text.slice(position);
}

export interface LogOptions {
  readonly run: string;
  /** The values to cut out of every line. Read at each write. A reader that throws withholds the line: nothing is printed that could not be checked. */
  readonly hidden: () => readonly string[];
  readonly log?: ((line: string) => void) | undefined;
}

export interface RelayLog {
  /** Writes one line. It never throws. */
  write(message: string): void;
  /** Writes the line the first time for the key, and never again. At most 64 keys are kept. */
  once(key: string, message: string): void;
  /** Counts the call for the key, and writes the line when the count is 1, 2, 4, 8, and so on, with the count after the first. At most 64 keys are kept. */
  counted(key: string, message: string): void;
}

const toStandardError = (line: string): void => { process.stderr.write(`${line}\n`); };
/** Writes to standard error and never throws: a double fault (the log and standard error) is lost, and nothing else is. */
const lastResort = (line: string): void => {
  try {
    toStandardError(line);
  } catch {
    // Nothing is left to try.
  }
};

export function createLog(options: LogOptions): RelayLog {
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  const withheld = `relay ${options.run}: a line was withheld, because the values to hide could not be read`;
  /** Redacts the raw text first, so a value that holds a character that the escape would change is still found. Then every unsafe character is shown as an escape, and then the line is cut. */
  const safe = (message: string): string => {
    let hidden: readonly string[];
    try {
      hidden = options.hidden();
    } catch {
      return withheld;
    }
    const escaped = escapeText(redactText(hidden, `relay ${options.run}: ${message}`));
    return escaped.length > MAX_LOG_LINE ? `${escaped.slice(0, MAX_LOG_LINE - 3)}...` : escaped;
  };
  const write = (message: string): void => {
    const line = safe(message);
    try {
      (options.log ?? toStandardError)(line);
    } catch (error) {
      lastResort(line);
      lastResort(safe(`the log sink threw: ${error instanceof Error ? error.message : String(error)}`));
    }
  };
  return {
    write,
    once(key, message) {
      if (seen.has(key) || seen.size >= MAX_ONCE_KEYS) return;
      seen.add(key);
      write(message);
    },
    counted(key, message) {
      const known = counts.get(key);
      if (known === undefined && counts.size >= MAX_ONCE_KEYS) return;
      const count = (known ?? 0) + 1;
      counts.set(key, count);
      // A power of two has one bit set.
      if ((count & (count - 1)) === 0) write(count === 1 ? message : `${message} (${count} times so far)`);
    },
  };
}
