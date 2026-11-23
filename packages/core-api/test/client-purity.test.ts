// The client is the door of a Gauge, so it must not pull the process host, the file system, or a child process into a webview bundle. This test reads the compiled module graph of the client.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT = fileURLToPath(new URL('../src/client.js', import.meta.url));
/** A static import or re-export, on one line or many, a bare `import 'x'`, and a dynamic `import('x')` or `require('x')`. */
const IMPORT = /(?:^|[\n;])\s*(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every module that the client reaches by a static import, as absolute paths, and every `node:` module on the way. */
function graph(entry: string): { readonly files: Set<string>; readonly nodes: Set<string> } {
  const files = new Set<string>(), nodes = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() ?? '';
    if (files.has(file)) continue;
    files.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT)) {
      const target = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
      if (target.startsWith('.')) queue.push(path.resolve(path.dirname(file), target));
      else nodes.add(target);
    }
  }
  return { files, nodes };
}

test('the client reaches no host, no launcher, no file system, and no child process', () => {
  const { files, nodes } = graph(CLIENT);
  const names = [...files].map(file => path.relative(path.resolve(path.dirname(CLIENT), '../..'), file).split(path.sep).join('/'));
  for (const forbidden of ['engine-sessions/src/host.js', 'engine-sessions/src/process-launcher.js', 'engine-sessions/src/fixtures.js', 'engine-sessions/src/index.js', 'core-api/src/fake-core.js', 'jobs/src/store.js', 'jobs/src/runs.js', 'jobs/src/index.js']) {
    assert.equal(names.includes(forbidden), false, `the client reaches ${forbidden}`);
  }
  for (const forbidden of ['node:fs', 'node:child_process', 'node:string_decoder', 'node:path', 'node:os', 'node:process', 'fs', 'child_process']) assert.equal(nodes.has(forbidden), false, `the client imports ${forbidden}`);
  assert.deepEqual([...nodes].sort(), ['node:crypto'], 'the one platform module that the client still reaches, through the error registry, is crypto');
  for (const needed of ['engine-sessions/src/request.js', 'engine-sessions/src/states.js', 'engine-sessions/src/text.js', 'engine-sessions/src/vocab.js', 'jobs/src/definition.js', 'jobs/src/ids.js']) assert.equal(names.includes(needed), true, needed);
});

test('the graph reader finds imports and exports, so the check above is not empty', () => {
  const { files } = graph(CLIENT);
  assert.ok(files.size >= 8, `${files.size} modules`);
  const sample = fs.readFileSync(CLIENT, 'utf8');
  assert.match(sample, /from '\.\.\/\.\.\/engine-sessions\/src\/request\.js'/);
});

test('the graph reader sees a multi-line import, a bare import, a re-export, and a dynamic import', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purity-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), "import {\n  one,\n  two,\n} from './b.js';\nimport './c.js';\nexport { x } from './d.js';\nconst e = await import('./e.js');\nconst f = await import('node:fs');\n");
    for (const name of ['b', 'c', 'd', 'e']) fs.writeFileSync(path.join(dir, `${name}.js`), 'export const x = 1;\n');
    const { files, nodes } = graph(path.join(dir, 'a.js'));
    assert.deepEqual([...files].map(file => path.basename(file)).sort(), ['a.js', 'b.js', 'c.js', 'd.js', 'e.js']);
    assert.deepEqual([...nodes], ['node:fs']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
