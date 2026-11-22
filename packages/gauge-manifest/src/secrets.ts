/**
 * The secret scan. It is simple and deterministic: it reads one string and gives true or false, with no score and no random part.
 * A string looks like a secret when any one rule matches:
 *
 * 1. It holds a private key header, `-----BEGIN` then any capitals and spaces then `PRIVATE KEY-----`.
 * 2. It holds an access key id: `AKIA` or `ASIA` then 16 capitals or digits.
 * 3. It holds a token with a known prefix: `ghp_`, `gho_`, `ghu_`, `ghs_`, or `ghr_` then 20 or more letters or digits; `sk-`, `pk-`, or `rk-` then
 *    20 or more letters, digits, underscores, or hyphens; or `xoxa-`, `xoxb-`, `xoxp-`, `xoxr-`, or `xoxs-` then 10 or more letters, digits, or hyphens.
 * 4. It holds three base64url parts joined by dots, the first starting with `eyJ`, each of at least 10 characters (a signed web token).
 * 5. It holds a run of 32 or more characters from letters, digits, `_`, `+`, `=`, and `-` that has a lower-case letter, an upper-case letter,
 *    and a digit. A run is maximal, so a slash or a space ends it.
 *
 * The scan has limits. It cannot find a secret with no known prefix that is shorter than 32 characters, or one that is all lower case or all digits.
 * It may flag a long mixed-case name that is not a secret. A manifest holds no hash or token of its own, so that false alarm is cheap.
 */
const PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{7,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];
const LONG_RUN = /[A-Za-z0-9_+=-]{32,}/g;

/** True when the string looks like a secret, by the rules above. */
export function looksLikeSecret(text: string): boolean {
  if (PATTERNS.some(pattern => pattern.test(text))) return true;
  for (const [run] of text.matchAll(LONG_RUN)) {
    if (/[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run)) return true;
  }
  return false;
}
