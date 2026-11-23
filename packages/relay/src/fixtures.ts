import type { SessionState } from '../../engine-sessions/src/states.js';
import { FIDELITIES, type Fidelity } from './vocab.js';
import type { Delivery, SessionPort } from './bus.js';

/**
 * The fake engine of the tests, and a pair of them. They are for tests: `src/index.ts` does not export them.
 *
 * A fake engine stands for an interactive engine in a terminal. It takes the text that the relay gives it as its next input, as a real terminal does: when the engine waits at a prompt, any input is taken
 * for the answer to the prompt. That is the hazard that the relay must never cause, so the engine records every input that it took as an answer in `promptAnswers`, and a test checks that the list stays empty.
 * The only way to answer a prompt on purpose is `answer`, which stands for the person. The engine prints lines with `say`, and nothing reads them: output lines never start, add, or route anything.
 */

/** How `deliver` behaves. `accept`: it resolves with the fidelity. `reject`: it rejects. `throw`: it throws at once. `hang`: it waits until `release` or `failHung`. `garbage`: it resolves with something that is not a fidelity. */
export type DeliverMode = 'accept' | 'reject' | 'throw' | 'hang' | 'garbage';

export interface FakeEngine extends SessionPort {
  readonly session: string;
  mode: DeliverMode;
  /** The fidelity that `accept` and `release` answer with. */
  fidelity: Fidelity;
  /** The texts the engine took as its next input, in order, and the deliveries that came with them. */
  readonly inputs: string[];
  readonly deliveries: Delivery[];
  /** The inputs that the engine took as the answer to its prompt. A relay that is right never makes one. */
  readonly promptAnswers: string[];
  /** The answers that the person gave on purpose, with `answer`. */
  readonly answers: string[];
  /** The lines that the engine printed. */
  readonly lines: string[];
  /** The question the engine waits on, or `null`. */
  prompt: string | null;
  setState(state: SessionState): void;
  /** The engine asks a question and waits for the person: it moves to `waiting`. */
  ask(question: string): void;
  /** The person answers the prompt: the engine runs again. Gives false when there is no prompt. */
  answer(text: string): boolean;
  /** The engine prints a line. */
  say(line: string): void;
  /** Resolves every delivery that hangs. */
  release(): void;
  /** Rejects every delivery that hangs. */
  failHung(message: string): void;
  /** How many deliveries hang now. */
  readonly hung: number;
  /** The message id and the receipt of the last input, read from its fence, or `undefined`. */
  lastReceipt(): { readonly message: string; readonly receipt: string } | undefined;
}

export interface FakeEngineOptions {
  readonly state?: SessionState;
  readonly mode?: DeliverMode;
  readonly fidelity?: Fidelity;
}

/** Reads the message id, the receipt, the nonce, and the body out of the text that a relay gives an engine. Gives `undefined` for a text that is no fence. */
export function parseFence(text: string): { readonly nonce: string; readonly message: string; readonly receipt: string; readonly body: string } | undefined {
  const lines = text.split('\n');
  const begin = /^BEGIN PEER MESSAGE (\S+)$/.exec(lines[0] ?? '');
  const from = /, message (\S+), run /.exec(lines[1] ?? '');
  const receipt = /send the receipt (\S+) to the relay\.$/.exec(lines[3] ?? '');
  if (begin === null || from === null || receipt === null || lines[lines.length - 1] !== `END PEER MESSAGE ${begin[1]}` || lines[4] !== '-----' || lines[lines.length - 2] !== '-----') return undefined;
  return { nonce: begin[1] ?? '', message: from[1] ?? '', receipt: receipt[1] ?? '', body: lines.slice(5, lines.length - 2).join('\n') };
}

export function createFakeEngine(session: string, options: FakeEngineOptions = {}): FakeEngine {
  let state: SessionState = options.state ?? 'running';
  const hung: { readonly resolve: (fidelity: Fidelity) => void; readonly reject: (error: Error) => void }[] = [];
  const engine: FakeEngine = {
    session,
    mode: options.mode ?? 'accept',
    fidelity: options.fidelity ?? 'exact',
    inputs: [],
    deliveries: [],
    promptAnswers: [],
    answers: [],
    lines: [],
    prompt: null,
    state: () => state,
    setState(next) { state = next; },
    ask(question) { engine.prompt = question; state = 'waiting'; },
    answer(text) {
      if (engine.prompt === null) return false;
      engine.prompt = null;
      state = 'running';
      engine.answers.push(text);
      return true;
    },
    say(line) { engine.lines.push(line); },
    get hung() { return hung.length; },
    release() { for (const waiting of hung.splice(0)) waiting.resolve(engine.fidelity); },
    failHung(message) { for (const waiting of hung.splice(0)) waiting.reject(new Error(message)); },
    lastReceipt() {
      const text = engine.inputs[engine.inputs.length - 1];
      const fence = text === undefined ? undefined : parseFence(text);
      return fence === undefined ? undefined : { message: fence.message, receipt: fence.receipt };
    },
    deliver(delivery) {
      // An engine that throws or rejects took nothing.
      if (engine.mode === 'throw') throw new Error('the engine could not take the input');
      if (engine.mode === 'reject') return Promise.reject(new Error('the engine refused the input'));
      // A terminal takes any input at a prompt as the answer to it.
      if (engine.prompt !== null) engine.promptAnswers.push(delivery.text);
      engine.inputs.push(delivery.text);
      engine.deliveries.push(delivery);
      if (engine.mode === 'hang') return new Promise<Fidelity>((resolve, reject) => { hung.push({ resolve, reject }); });
      if (engine.mode === 'garbage') return Promise.resolve('maybe' as Fidelity);
      return Promise.resolve(FIDELITIES.includes(engine.fidelity) ? engine.fidelity : 'exact');
    },
  };
  return engine;
}
