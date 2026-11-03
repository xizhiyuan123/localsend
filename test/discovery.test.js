import assert from 'node:assert/strict';
import test from 'node:test';

import { ipToNumber, isIPv4, parseNeighbors } from '../lib/discovery.js';

test('isIPv4 accepts normal LAN addresses', () => {
  assert.equal(isIPv4('192.168.1.23'), true);
  assert.equal(isIPv4('10.0.0.1'), true);
  assert.equal(isIPv4('127.0.0.1'), true);
  assert.equal(isIPv4('not-an-ip'), false);
  assert.equal(isIPv4('192.168.1.256'), false);
  assert.equal(isIPv4('192.168.1'), false);
});

test('ipToNumber sorts numerically', () => {
  const list = ['192.168.1.100', '192.168.1.9', '10.0.0.2'];
  list.sort((a, b) => ipToNumber(a) - ipToNumber(b));
  assert.deepEqual(list, ['10.0.0.2', '192.168.1.9', '192.168.1.100']);
});

test('parses Linux ip neigh output and drops failed entries', () => {
  const text = [
    '192.168.83.2 dev ens33 lladdr 00:50:56:e5:39:cf REACHABLE',
    '192.168.83.3 dev ens33 lladdr 00:50:56:aa:bb:01 ref 1 used 0/0/0 STALE',
    '192.168.83.254 dev ens33 lladdr 00:50:56:e7:83:0d STALE',
    '192.168.83.99 dev ens33  FAILED',
    '192.168.83.100 dev ens33 lladdr 00:50:56:aa:bb:cc DELAY',
  ].join('\n');
  const result = parseNeighbors(text, 'linux');
  assert.equal(result.size, 4);
  assert.equal(result.get('192.168.83.2').mac, '00:50:56:e5:39:cf');
  assert.equal(result.get('192.168.83.3').state, 'stale');
  assert.equal(result.get('192.168.83.254').state, 'stale');
  assert.equal(result.has('192.168.83.99'), false);
});

test('parses macOS arp output and ignores incomplete entries', () => {
  const text = [
    '? (192.168.1.10) at 0:1c:42:00:00:08 on en0 ifscope [ethernet]',
    '? (192.168.1.11) at (incomplete) on en0 ifscope [ethernet]',
  ].join('\n');
  const result = parseNeighbors(text, 'darwin');
  assert.equal(result.size, 1);
  assert.equal(result.get('192.168.1.10').mac, '0:1c:42:00:00:08');
});

test('parses Windows arp output', () => {
  const text = [
    'Interface: 192.168.1.5 --- 0x9',
    '  192.168.1.1           aa-bb-cc-dd-ee-ff     dynamic',
    '  224.0.0.22            01-00-5e-00-00-16     static',
  ].join('\r\n');
  const result = parseNeighbors(text, 'win32');
  assert.equal(result.size, 2);
  assert.equal(result.get('192.168.1.1').mac, 'aa:bb:cc:dd:ee:ff');
  assert.equal(result.get('192.168.1.1').state, 'dynamic');
});