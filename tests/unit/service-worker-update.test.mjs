import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const script = (html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [])
  .map(s => s.replace(/^<script[^>]*>|<\/script>$/gi, '')).join('\n');

function extractFunction(name) {
  const start = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{', 'm').exec(script);
  assert.ok(start, 'missing function: ' + name);
  const from = start.index + start[0].length;
  const next = script.slice(from).search(/\nfunction\s+[A-Za-z_$][\w$]*\s*\(/);
  return next < 0 ? script.slice(start.index) : script.slice(start.index, from + next);
}

test('service worker lifecycle activates waiting updates and reloads after the first controller', async () => {
  const listeners = {};
  const windowListeners = {};
  const sentMessages = [];
  let reloads = 0;
  let controller = null;
  const installingListeners = {};
  const installing = {
    state: 'installed',
    addEventListener(name, fn) { installingListeners[name] = fn; }
  };
  const registrationListeners = {};
  const registration = {
    waiting: null,
    installing,
    addEventListener(name, fn) { registrationListeners[name] = fn; },
    update() { return Promise.resolve(); }
  };
  const serviceWorker = {
    get controller() { return controller; },
    addEventListener(name, fn) { listeners[name] = fn; },
    register() { return Promise.resolve(registration); }
  };
  const context = {
    navigator: { serviceWorker },
    window: {
      addEventListener(name, fn) { windowListeners[name] = fn; },
      location: { reload() { reloads++; } }
    },
    console: { warn() {} }
  };
  vm.runInNewContext(extractFunction('initSW') + '\ninitSW();', context);
  windowListeners.load();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(typeof registrationListeners.updatefound, 'function');
  listeners.controllerchange();
  assert.equal(reloads, 0, 'initial controller acquisition must not reload the page');

  controller = {};
  registration.waiting = { postMessage(message) { sentMessages.push(message); } };
  registrationListeners.updatefound();
  installingListeners.statechange();
  assert.deepEqual(JSON.parse(JSON.stringify(sentMessages)), [{ type: 'SKIP_WAITING' }]);

  listeners.controllerchange();
  assert.equal(reloads, 1, 'a later controller change must reload to apply the update');
  listeners.controllerchange();
  assert.equal(reloads, 1, 'one update must trigger at most one reload');
});
