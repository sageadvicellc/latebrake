import type { SessionState } from '../../engine-sessions/src/states.js';
import type { Delivery, SessionPort } from '../src/bus.js';
import type { AdapterFidelity } from '../src/vocab.js';

/**
 * The fake engine of the tests, and the helpers around it. They are for tests: they are not in `src` and `src/index.ts` does not export them.
 *
 * A fake engine stands for an interactive engine in a terminal. It takes the text that the relay gives it as its next input, as a real terminal does: when the engine waits at a prompt, any input is taken
 * for the answer to the prompt. That is the hazard that the relay must never cause, so the engine records every input that it took as an answer in `promptAnswers`, and a test checks that the list stays empty.
 * The only way to answer a prompt on purpose is `answer`, which stands for the person. The engine prints lines with `say`, and nothing reads them: output lines never start, add, or route anything.
 */

/**
 * How `deliver` behaves. `accept`: it resolves with the fidelity. `reject`: it rejects. `throw`: it throws at once. `hang`: the engine takes the text at once, and the promise waits until `release` or `failHung`.
 * `late`: the promise waits, and the engine writes the text only at `release`, as an adapter that writes late does. `garbage`: it resolves with something that is not a fidelity.
 */
export type DeliverMode = 'accept' | 'reject' | 'throw' | 'hang' | 'late' | 'garbage';

export interface FakeEngine extends SessionPort {
  readonly session: string;
  mode: DeliverMode;
  /** The fidelity that `accept`, `hang`, and `release` answer with. */
  fidelity: AdapterFidelity;
  /** Whether a late write is dropped when the signal of the delivery was aborted. True by default. An adapter that sets it false breaks the contract of the README. */
  honorsAbort: boolean;
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
  /** How many deliveries run at this moment, and the most that ran at once. A relay that is right never runs two. */
  readonly active: number;
  readonly maxActive: number;
  setState(state: SessionState): void;
  /** The engine asks a question and waits for the person: it moves to `waiting`. */
  ask(question: string): void;
  /** The person answers the prompt: the engine runs again. Gives false when there is no prompt. */
  answer(text: string): boolean;
  /** The engine prints a line. */
  say(line: string): void;
  /** Resolves every delivery that waits, and in `late` mode writes the text of each. */
  release(): void;
  /** Rejects every delivery that waits. */
  failHung(message: string): void;
  /** How many deliveries wait now. */
  readonly hung: number;
  /** The message id and the receipt of the last input, read from its fence, or `undefined`. */
  lastReceipt(): { readonly message: string; readonly receipt: string } | undefined;
}

export interface FakeEngineOptions {
  readonly state?: SessionState;
  readonly mode?: DeliverMode;
  readonly fidelity?: AdapterFidelity;
}

/** Reads the message id, the receipt, the nonce, and the body out of the text that a relay gives an engine. Gives `undefined` for a text that is no fence. */
export function parseFence(text: string): { readonly nonce: string; readonly message: string; readonly receipt: string; readonly body: string } | undefined {
  const lines = text.split('\n');
  const begin = /^BEGIN PEER MESSAGE (\S+)$/.exec(lines[0] ?? '');
  const from = /, message (\S+), run /.exec(lines[1] ?? '');
  const receipt = /send the receipt (\S+) to the relay\.$/.exec(lines[3] ?? '');
  if (begin === null || from === null || receipt === null || lines[lines.length - 1] !== `END PEER MESSAGE ${begin[1]}` || lines[4] !== '-----' || lines[lines.length - 2] !== '-----') return undefined;
  const body = lines.slice(5, lines.length - 2);
  // Every line of the body starts with a bar and a space. A line that does not is no body line.
  if (!body.every(line => line.startsWith('| '))) return undefined;
  return { nonce: begin[1] ?? '', message: from[1] ?? '', receipt: receipt[1] ?? '', body: body.map(line => line.slice(2)).join('\n') };
}

export function createFakeEngine(session: string, options: FakeEngineOptions = {}): FakeEngine {
  let state: SessionState = options.state ?? 'running';
  let active = 0, maxActive = 0;
  const waiting: { readonly delivery: Delivery; readonly resolve: (fidelity: AdapterFidelity) => void; readonly reject: (error: Error) => void }[] = [];
  const write = (delivery: Delivery): void => {
    // A terminal takes any input at a prompt as the answer to it.
    if (engine.prompt !== null) engine.promptAnswers.push(delivery.text);
    engine.inputs.push(delivery.text);
    engine.deliveries.push(delivery);
  };
  const engine: FakeEngine = {
    session,
    mode: options.mode ?? 'accept',
    fidelity: options.fidelity ?? 'exact',
    honorsAbort: true,
    inputs: [],
    deliveries: [],
    promptAnswers: [],
    answers: [],
    lines: [],
    prompt: null,
    get active() { return active; },
    get maxActive() { return maxActive; },
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
    get hung() { return waiting.length; },
    release() {
      for (const entry of waiting.splice(0)) {
        if (engine.mode === 'late' && !(engine.honorsAbort && entry.delivery.signal.aborted)) write(entry.delivery);
        entry.resolve(engine.fidelity);
      }
    },
    failHung(message) { for (const entry of waiting.splice(0)) entry.reject(new Error(message)); },
    lastReceipt() {
      const text = engine.inputs[engine.inputs.length - 1];
      const fence = text === undefined ? undefined : parseFence(text);
      return fence === undefined ? undefined : { message: fence.message, receipt: fence.receipt };
    },
    deliver(delivery) {
      // An engine that throws or rejects took nothing.
      if (engine.mode === 'throw') throw new Error('the engine could not take the input');
      if (engine.mode === 'reject') return Promise.reject(new Error('the engine refused the input'));
      active += 1;
      maxActive = Math.max(maxActive, active);
      const finish = <T>(promise: Promise<T>): Promise<T> => promise.finally(() => { active -= 1; });
      if (engine.mode === 'hang' || engine.mode === 'late') {
        if (engine.mode === 'hang') write(delivery);
        return finish(new Promise<AdapterFidelity>((resolve, reject) => { waiting.push({ delivery, resolve, reject }); }));
      }
      write(delivery);
      if (engine.mode === 'garbage') return finish(Promise.resolve('maybe' as AdapterFidelity));
      return finish(Promise.resolve(engine.fidelity));
    },
  };
  return engine;
}
