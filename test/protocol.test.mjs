import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ExistingBridgeClient } from '../src/bridge-client.mjs';
import { buildGetUpdatesRequest, buildSendTextRequest, RealWeixinTransport } from '../src/transports/real-weixin.mjs';
import { seal, unseal } from '../src/secrets.mjs';

test('context token encryption roundtrips without plaintext in ciphertext', () => {
  const key = Buffer.alloc(32, 3);
  const ciphertext = seal('sensitive-token', key);
  assert.doesNotMatch(ciphertext, /sensitive-token/);
  assert.equal(unseal(ciphertext, key), 'sensitive-token');
});

test('existing bridge client only accepts loopback capability URL', () => {
  assert.throws(() => new ExistingBridgeClient({ origin: 'https://example.com/bridge-' + 'a'.repeat(64) }), /LOOPBACK/);
  assert.throws(() => new ExistingBridgeClient({ origin: 'http://127.0.0.1:8797' }), /CAPABILITY/);
  assert.doesNotThrow(() => new ExistingBridgeClient({ origin: 'http://127.0.0.1:8797/bridge-' + 'a'.repeat(64) }));
});

test('existing bridge client matches the observed HTTP contract', async (t) => {
  const capability = `bridge-${'b'.repeat(64)}`;
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, body });
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST') response.end(JSON.stringify({ eventId: 'event-1', status: 'QUEUED', replyText: null }));
    else response.end(JSON.stringify({ eventId: 'event-1', status: 'SUCCEEDED', replyText: 'answer' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const client = new ExistingBridgeClient({ origin: `http://127.0.0.1:${port}/${capability}` });
  assert.deepEqual(await client.enqueue({ text: 'hello', idempotencyKey: 'key-1' }), { eventId: 'event-1' });
  assert.deepEqual(await client.getEvent('event-1'), { status: 'SUCCEEDED', replyText: 'answer' });
  assert.equal(requests[0].url, `/${capability}/api/send`);
  assert.equal(requests[1].url, `/${capability}/api/event/event-1`);
});

test('protocol builders preserve cursor and reply context', () => {
  assert.equal(buildGetUpdatesRequest('cursor').body.get_updates_buf, 'cursor');
  const request = buildSendTextRequest({ toUserId: 'u', clientId: 'c', contextToken: 'ctx', text: 'hi' });
  assert.equal(request.path, '/ilink/bot/sendmessage');
  assert.equal(request.body.msg.context_token, 'ctx');
  assert.equal(request.body.msg.message_type, 2);
  assert.deepEqual(request.body.msg.item_list, [{ type: 1, text_item: { text: 'hi' } }]);
});

test('real transport reports code-ready but not live-eligible capabilities', () => {
  assert.deepEqual(RealWeixinTransport.feasibility(), {
    baseUrl: 'https://ilinkai.weixin.qq.com', protocolMapped: true, qrLoginImplemented: true,
    networkEnabled: 'explicit-gates', liveEligible: false
  });
  assert.throws(() => new RealWeixinTransport({}), /AUTH_STORE_REQUIRED/);
});
