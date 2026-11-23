import { escapeText } from '../../engine-sessions/src/text.js';

/**
 * Makes a value safe to put in a line of a plan. A line break, a control, format, or separator character, a backslash, a space that is not the plain space, a blank letter, and a combining mark
 * become a visible escape such as `\u{a}`, so no value can end a line, start a new one, or pass for another text, and a person reads what the value really holds. Every value that goes in a line
 * a person approves goes through this one helper. It is the escape of `packages/engine-sessions`, which the logs use too.
 */
export const escapeForPlan = (value: string): string => escapeText(value);
