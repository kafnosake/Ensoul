const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { brandedEntrySource } = require('./brand-runtime');

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoul-launch-'));
const source = path.join(box, 'source');
const shell = path.join(source, '.electron/brand/windows/cache/ensoul/resources/app');
const other = path.join(box, 'other');
for (const dir of [source, shell, other]) fs.mkdirSync(dir, { recursive: true });
for (const dir of [source, other]) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'ensoul', main: 'dist/main/index.js' }));
test.after(() => fs.rmSync(box, { recursive: true, force: true }));

function boot(environment) {
  assert.equal(typeof brandedEntrySource, 'function', 'application shell supports direct executable launch');
  const env = { ...environment };
  const loads = [];
  const code = brandedEntrySource(shell, source);
  vm.runInNewContext(code, { __dirname: shell, process: { env },
    require: name => {
      if (name === 'node:fs') return fs;
      if (name === 'node:path') return path;
      loads.push(name);
    },
  });
  return { env, loads };
}

test('double-clicking the executable works without launcher environment variables', () => {
  const result = boot({});
  assert.equal(result.env.ENSOUL_SOURCE_ROOT, source);
  assert.deepEqual(result.loads, [path.join(source, 'dist/main/index.js')]);
});

test('the existing command-line launcher can explicitly select a different source root', () => {
  const result = boot({ ENSOUL_SOURCE_ROOT: other });
  assert.deepEqual(result.loads, [path.join(other, 'dist/main/index.js')]);
});
