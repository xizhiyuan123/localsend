import assert from 'node:assert/strict';
import test from 'node:test';

import { Registry, cleanAlias, normalizeIp, publicClient } from '../lib/registry.js';

test('registry tracks clients and finds them by IP', () => {
  const registry = new Registry();
  const a = registry.create({ ip: '192.168.1.10', ua: 'UA-A' });
  const b = registry.create({ ip: '192.168.1.10', ua: 'UA-B' });
  const c = registry.create({ ip: '192.168.1.11', ua: 'UA-C' });
  registry.update(a.id, { alias: 'Laptop' });

  assert.equal(registry.get(a.id).alias, 'Laptop');
  assert.deepEqual(
    registry.byIp('192.168.1.10').map((client) => client.id).sort(),
    [a.id, b.id].sort(),
  );
  assert.equal(registry.list().length, 3);

  registry.remove(c.id);
  assert.equal(registry.get(c.id), null);
  assert.equal(registry.list().length, 2);
  assert.equal(Object.hasOwn(publicClient(registry.get(a.id)), 'lastSeen'), false);
});

test('normalizeIp unwraps IPv4-mapped IPv6', () => {
  assert.equal(normalizeIp('::ffff:192.168.1.5'), '192.168.1.5');
  assert.equal(normalizeIp('::1'), '127.0.0.1');
  assert.equal(normalizeIp('192.168.1.5'), '192.168.1.5');
});

test('cleanAlias strips control characters and enforces a fallback', () => {
  assert.equal(cleanAlias('  Living Room  '), 'Living Room');
  assert.equal(cleanAlias('A\u0000B\u001fC'), 'ABC');
  assert.equal(cleanAlias('', '浏览器'), '浏览器');
  assert.equal(cleanAlias('x'.repeat(80)).length, 40);
});