/**
 * Branded texts. A brand is a type and nothing at run time: a plain string cannot be passed where a message id, a route id, an idempotency key, a session secret, a receipt, or a nonce is wanted. Each brand is made by one guard
 * that checks the shape, so a value of the type was checked. The constructors (`routeId`, `messageId`, and the others) check and throw, for code that holds a text it knows to be good.
 */
declare const brand: unique symbol;
export type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type RouteId = Brand<string, 'RouteId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>;
export type SessionSecret = Brand<string, 'SessionSecret'>;
export type Receipt = Brand<string, 'Receipt'>;
export type Nonce = Brand<string, 'Nonce'>;

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** The length of a secret, a receipt, and a nonce: 16 to 256 characters. */
export const MIN_TOKEN_LENGTH = 16;
export const MAX_TOKEN_LENGTH = 256;
const token = (value: unknown): value is string => typeof value === 'string' && value.length >= MIN_TOKEN_LENGTH && value.length <= MAX_TOKEN_LENGTH;

export const isRouteId = (value: unknown): value is RouteId => typeof value === 'string' && ID.test(value);
export const isMessageId = (value: unknown): value is MessageId => typeof value === 'string' && ID.test(value);
export const isIdempotencyKey = (value: unknown): value is IdempotencyKey => typeof value === 'string' && KEY.test(value);
export const isSessionSecret = (value: unknown): value is SessionSecret => token(value);
export const isReceipt = (value: unknown): value is Receipt => token(value);
export const isNonce = (value: unknown): value is Nonce => token(value);

function make<T extends string>(guard: (value: unknown) => value is T, name: string): (value: string) => T {
  return (value: string): T => {
    if (!guard(value)) throw new TypeError(`relay: not a ${name}`);
    return value;
  };
}
export const routeId = make(isRouteId, 'route id');
export const messageId = make(isMessageId, 'message id');
export const idempotencyKey = make(isIdempotencyKey, 'idempotency key');
export const sessionSecret = make(isSessionSecret, 'session secret');
export const receipt = make(isReceipt, 'receipt');
export const nonce = make(isNonce, 'nonce');
