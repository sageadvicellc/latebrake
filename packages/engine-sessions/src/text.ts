/**
 * What counts as an unsafe character in a text that a person reads or a log keeps, and the one escape for it.
 *
 * The narrow class is a control, format, line separator, or paragraph separator character (`\p{Cc}`, `\p{Cf}`, `\p{Zl}`, `\p{Zp}`). A value that holds one is refused where it must be plain (a folder, a title, a program path).
 *
 * The wide class adds what can pass for a space or for nothing: the spaces that are not the plain space, the blank letters of Hangul and Braille (U+3164, U+2800, U+115F, U+1160, U+FFA0), the combining marks (`\p{M}`),
 * and the code points that have no assigned character, the private use ones, and the lone surrogates (`\p{Cn}`, `\p{Co}`, `\p{Cs}`), which a font may draw as nothing. `\p{Cn}` follows the Unicode version of the runtime.
 * A value that holds one is not refused, because a folder name may be written with combining marks. It is shown as a visible escape, so a person reads what it really holds.
 */
const NARROW = '\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}';
const WIDE = `${NARROW}\\p{Cn}\\p{Co}\\p{Cs}\\p{M}\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000\\u3164\\u2800\\u115f\\u1160\\uffa0`;

const NARROW_TEST = new RegExp(`[${NARROW}]`, 'u');
const WIDE_TEST = new RegExp(`[${WIDE}]`, 'u');
const WIDE_AND_BACKSLASH = new RegExp(`[${WIDE}\\\\]`, 'gu');

/** True when the text holds a control, format, line separator, or paragraph separator character. */
export const hasUnsafeChar = (text: string): boolean => NARROW_TEST.test(text);

/** True when the text holds a character of the wide class, which an escaped text never holds. */
export const hasPlanUnsafeChar = (text: string): boolean => WIDE_TEST.test(text);

/**
 * Makes a value safe to put in a line of a plan or of a log. Every character of the wide class and the backslash becomes a visible escape, such as `\u{a}`, so no value can end a line, start a new one,
 * or pass for another text. Every value that goes in a line a person reads goes through this one helper.
 */
export const escapeText = (value: string): string => value.replace(WIDE_AND_BACKSLASH, char => (char === '\\' ? '\\\\' : `\\u{${char.codePointAt(0)?.toString(16) ?? ''}}`));
