/** Where a session's tokens are billed. A provider key joins when the keys and spend work is built: a spec that names it is refused when the host is made. */
export const BILLING_SOURCES = Object.freeze(['engine-plan', 'local'] as const);
export type Billing = (typeof BILLING_SOURCES)[number];
