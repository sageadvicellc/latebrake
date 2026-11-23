// A program for a test, never imported and not a test itself: it starts a fake engine through the process launcher and then waits. The test ends it in several ways and checks that the engine goes too.
// Usage: node launcher-parent.js <mode> <tag>.
//   exit: leaves by itself once the engine and its helper run.
//   immediate: starts the engine and calls process.exit(0) in the same tick, before any event.
//   own: has a listener of its own for SIGTERM that keeps it alive, and starts a second engine after the first signal. It leaves by itself on the third signal.
//   twice: starts one engine through each of two copies of the launcher module, which share one cover.
//   once: has a `process.once` listener for SIGTERM that flushes for 100 ms and then leaves with code 0.
//   hup-app: has a listener of its own for SIGHUP that only says so, so the core stays alive.
//   any other mode: waits for a signal from the test.
import { createProcessLauncher } from '../src/process-launcher.js';
import { FAKE_ENGINE_PROGRAM } from '../src/fixtures.js';

const [mode, tag] = process.argv.slice(2);
const copies = mode === 'twice'
  ? [createProcessLauncher(), ((await import(new URL('../src/process-launcher.js?b', import.meta.url).href)) as { createProcessLauncher: typeof createProcessLauncher }).createProcessLauncher()]
  : [createProcessLauncher()];
let launches = 0;
const start = (suffix: string) => copies[launches++ % copies.length]!.launch({
  program: process.execPath,
  args: [FAKE_ENGINE_PROGRAM, '--tag', `${tag ?? 'no-tag'}${suffix}`, '--script', JSON.stringify([{ spawnChild: true }, { hold: true }])],
  cwd: process.cwd(),
  env: {},
});
const say = (text: string, then?: () => void) => process.stdout.write(`${text}\n`, then);
const watch = (suffix: string, message: string, then?: () => void) => start(suffix).onLine(line => { if (line.startsWith('child:')) say(message, then); });

if (mode === 'own') {
  let signals = 0;
  process.on('SIGTERM', () => { signals += 1; say(`got:${signals}`, () => { if (signals === 1) watch('-second', 'ready-second'); if (signals === 3) process.exit(0); }); });
}
if (mode === 'once') {
  process.once('SIGTERM', () => { say('flushing'); setTimeout(() => say('flushed', () => process.exit(0)), 100); });
}
if (mode === 'hup-app') {
  process.on('SIGHUP', () => say('hup'));
}
if (mode === 'immediate') {
  start('');
  process.exit(0);
}
// The engine says `child:<pid>` once its helper is running, so `ready` means that the engine and its helper are both alive. In the mode `exit` the parent leaves only then.
if (mode === 'twice') {
  // Two engines, one through each copy. `ready` means that both are up, with their helpers.
  let up = 0;
  for (const suffix of ['-a', '-b']) start(suffix).onLine(line => { if (line.startsWith('child:')) { up += 1; if (up === 2) say('ready'); } });
} else watch('', 'ready', () => { if (mode === 'exit') process.exit(0); });
setInterval(() => undefined, 1000);
