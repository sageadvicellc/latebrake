const UNSAFE_IN_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\]/gu;

/**
 * Makes a value safe to put in a line of a plan. A line break, a control, format, or separator character, and a backslash become a visible escape such as
 * `\u{a}`, so no value can end a line or start a new one, and a person reads what the value really holds. Every value that goes in a line a person approves goes through this one helper.
 */
export const escapeForPlan = (value: string): string => value.replace(UNSAFE_IN_TEXT, char => (char === '\\' ? '\\\\' : `\\u{${char.codePointAt(0)?.toString(16) ?? ''}}`));
