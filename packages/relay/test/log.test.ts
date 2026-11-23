// The one log sink of the relay: it redacts every secret, escapes every unsafe character, cuts a long line, and never throws.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLog, redactText } from '../src/log.js';

const make = (hidden: string[] = [], over: { log?: (line: string) => void } = {}) => {
  const lines: string[] = [];
  const log = createLog({ run: 'run-1', hidden: () => hidden, log: over.log ?? (line => { lines.push(line); }) });
  return { log, lines };
};

test('a line starts with the run, and a plain message passes through unchanged', () => {
  const { log, lines } = make();
  log.write('route route-1 stopped by the loop cap');
  assert.deepEqual(lines, ['relay run-1: route route-1 stopped by the loop cap']);
});

test('a value that the relay keeps hidden is cut out of a line, every time it occurs', () => {
  const secret = 'S3cr3t-value-0123456789';
  const { log, lines } = make([secret]);
  log.write(`failed: ${secret} and again ${secret}!`);
  assert.deepEqual(lines, ['relay run-1: failed: [redacted] and again [redacted]!']);
});

test('two hidden values where one ends inside the other leave no tail of either', () => {
  const { log, lines } = make(['abcdefghij', 'ghijklmnop']);
  log.write('x abcdefghijklmnop y');
  assert.deepEqual(lines, ['relay run-1: x [redacted] y']);
  assert.equal(redactText(['abcdefghij', 'ghijklmnop'], 'abcdefghijklmnop'), '[redacted]');
});

test('a hidden value of fewer than 6 characters is not searched for, and an empty one never turns a line into marks', () => {
  assert.equal(redactText(['', 'abc', 'abcde'], 'abc abcde'), 'abc abcde');
  assert.equal(redactText(['abcdef'], 'abcdef abcde'), '[redacted] abcde');
});

test('a hidden value that holds a character the escape would change is found in the raw text, before the escape', () => {
  const secret = 'pa\u200bss-word-12345';
  const { log, lines } = make([secret]);
  log.write(`the engine said ${secret} twice`);
  assert.equal(lines[0], 'relay run-1: the engine said [redacted] twice');
});

test('a line feed, a carriage return, an escape character, a bidirectional mark, and a backslash are shown as escapes, so no text can forge a line', () => {
  const { log, lines } = make();
  log.write('engine said:\nrelay run-1: route route-9 stopped\r\u001b[2J‮ done \\ end');
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.includes('\n'), false);
  assert.equal(lines[0], 'relay run-1: engine said:\\u{a}relay run-1: route route-9 stopped\\u{d}\\u{1b}[2J\\u{202e} done \\\\ end');
});

test('a line is cut at 1,024 characters, after it is redacted, so a value that crosses the cut leaves no part of itself', () => {
  const secret = 'k'.repeat(40);
  const { log, lines } = make([secret]);
  log.write(`${'a'.repeat(1000)}${secret}${'b'.repeat(100)}`);
  assert.equal((lines[0] ?? '').length <= 1024, true);
  assert.equal((lines[0] ?? '').includes('kkkkkk'), false);
  assert.equal((lines[0] ?? '').endsWith('...'), true);
});

test('a log that throws is reported on standard error with the same safe line, and the writer never sees the throw', () => {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    const { log } = make(['hidden-value-1234'], { log: () => { throw new Error('sink broke hidden-value-1234'); } });
    assert.doesNotThrow(() => log.write('a line with hidden-value-1234'));
  } finally {
    process.stderr.write = original;
  }
  const all = written.join('');
  assert.match(all, /relay run-1: a line with \[redacted\]\n/);
  assert.match(all, /the log sink threw: sink broke \[redacted\]\n/);
  assert.equal(all.includes('hidden-value-1234'), false);
});

test('a hidden-values reader that throws never stops a line, and never lets one through: a fixed line is written and the text is withheld', () => {
  const lines: string[] = [];
  const log = createLog({ run: 'run-1', hidden: () => { throw new Error('no'); }, log: line => { lines.push(line); } });
  assert.doesNotThrow(() => log.write('x\ny secret-looking text'));
  assert.deepEqual(lines, ['relay run-1: a line was withheld, because the values to hide could not be read']);
});

test('a standard error that throws too is a double fault that is lost, and the writer never sees it', () => {
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => { throw new Error('standard error is closed'); }) as typeof process.stderr.write;
  try {
    const { log } = make([], { log: () => { throw new Error('the sink broke'); } });
    assert.doesNotThrow(() => log.write('a line'));
    assert.doesNotThrow(() => log.counted('k', 'a counted line'));
  } finally {
    process.stderr.write = original;
  }
});

test('counted writes the line at counts 1, 2, 4, 8, and so on, with the count after the first, for each key', () => {
  const { log, lines } = make();
  for (let i = 0; i < 9; i += 1) log.counted('refused', 'a refusal');
  log.counted('other', 'another kind');
  assert.deepEqual(lines, ['relay run-1: a refusal', 'relay run-1: a refusal (2 times so far)', 'relay run-1: a refusal (4 times so far)', 'relay run-1: a refusal (8 times so far)', 'relay run-1: another kind']);
});

test('the keys of counted are bounded: after 64 kinds a new kind is dropped, and a kind that is known goes on counting', () => {
  const { log, lines } = make();
  for (let i = 0; i < 100; i += 1) log.counted(`kind-${i}`, `line ${i}`);
  assert.equal(lines.length, 64);
  log.counted('kind-0', 'line 0');
  assert.equal(lines.length, 65);
  assert.equal(lines[64], 'relay run-1: line 0 (2 times so far)');
});

test('once writes a line the first time for its key, and never again, so a flood of one kind makes one line', () => {
  const { log, lines } = make();
  for (let i = 0; i < 50; i += 1) log.once('refused', 'a write came without the right secret');
  log.once('other', 'another');
  assert.deepEqual(lines, ['relay run-1: a write came without the right secret', 'relay run-1: another']);
});

test('the keys of once are bounded: after 64 kinds a new kind is dropped and nothing grows', () => {
  const { log, lines } = make();
  for (let i = 0; i < 100; i += 1) log.once(`kind-${i}`, `line ${i}`);
  assert.equal(lines.length, 64);
});

test('two hidden values where one sits inside the other leave no tail of the longer one', () => {
  assert.equal(redactText(['abcdefghijkl', 'cdefghi'], 'x abcdefghijkl y'), 'x [redacted] y');
  assert.equal(redactText(['cdefghi', 'abcdefghijkl'], 'x abcdefghijkl y'), 'x [redacted] y');
  assert.equal(redactText(['abcdefg', 'abcdefghij'], 'x abcdefghij y'), 'x [redacted] y');
  assert.equal(redactText(['abcdefghij', 'abcdefg'], 'x abcdefghij y'), 'x [redacted] y');
});
