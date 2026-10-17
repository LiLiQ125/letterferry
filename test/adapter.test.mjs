import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterStore } from '../src/store.mjs';
import { AllowlistPolicy } from '../src/policy.mjs';
import { FakeWeixinTransport } from '../src/transports/fake-weixin.mjs';
import { WeixinBridgeAdapter } from '../src/adapter.mjs';

const key = Buffer.alloc(32, 7);
const accountId = 'bot-1';
const allowed = { userId: 'user-1', chatId: 'user-1' };

function inbound(overrides = {}) {
  return {
    message_id: 'msg-1', from_user_id: 'user-1', to_user_id: 'bot-1', session_id: 'session-1',
    message_type: 1, message_state: 2, context_token: 'private-context-token',
    item_list: [{ type: 1, text_item: { text: 'hello bridge' } }], ...overrides
  };
}

class FakeBridge {
  constructor() { this.events = new Map(); this.submissions = []; }
  async enqueue(input) {
    this.submissions.push(input);
    const existing = [...this.events.values()].find((item) => item.key === input.idempotencyKey);
    if (existing) return { eventId: existing.id };
    const id = `bridge-${this.events.size + 1}`;
    this.events.set(id, { id, key: input.idempotencyKey, status: 'QUEUED', replyText: null });
    return { eventId: id };
  }
  async getEvent(id) { return this.events.get(id); }
  reply(id, text) { Object.assign(this.events.get(id), { status: 'SUCCEEDED', replyText: text }); }
}

function fixture(updates = []) {
  const dir = mkdtempSync(join(tmpdir(), 'riven-wx-'));
  const store = new AdapterStore(join(dir, 'adapter.sqlite'));
  const transport = new FakeWeixinTransport(updates);
  const bridge = new FakeBridge();
  const policy = new AllowlistPolicy({ accountId, allowedPeers: [allowed] });
  const logs = [];
  const adapter = new WeixinBridgeAdapter({ accountId, policy, store, bridge, transport, encryptionKey: key, logger: (entry) => logs.push(entry) });
  return { store, filename: store.filename, transport, bridge, adapter, logs };
}

test('authorized text makes a complete offline roundtrip with context preservation', async () => {
  const f = fixture([inbound()]);
  await f.adapter.runCycle();
  assert.equal(f.store.list()[0].status, 'BRIDGE_QUEUED');
  assert.match(f.bridge.submissions[0].text, /hello bridge/);
  f.bridge.reply('bridge-1', 'hello from ChatGPT');
  await f.adapter.runCycle();
  assert.equal(f.store.list()[0].status, 'SUCCEEDED');
  assert.deepEqual(f.transport.sent[0], {
    toUserId: 'user-1', chatId: 'user-1', clientId: f.store.list()[0].outbound_client_id,
    contextToken: 'private-context-token', text: 'hello from ChatGPT'
  });
  f.store.close();
});

test('plaintext context token is absent from the SQLite file', () => {
  const f = fixture();
  f.adapter.ingestRaw(inbound());
  f.store.close();
  assert.equal(readFileSync(f.filename).includes(Buffer.from('private-context-token')), false);
});

test('unauthorized peer is rejected before content or context is persisted', async () => {
  const f = fixture([inbound({ from_user_id: 'stranger', item_list: [{ type: 1, text_item: { text: 'private stranger text' } }] })]);
  const result = await f.adapter.pollInbound();
  assert.deepEqual(result, [{ accepted: false }]);
  assert.equal(f.store.list().length, 0);
  assert.deepEqual(f.logs, [{ event: 'inbound_rejected', reason: 'not_allowlisted' }]);
  f.store.close();
});

test('duplicate inbound message is idempotent and submitted once', async () => {
  const f = fixture([inbound(), inbound()]);
  await f.adapter.pollInbound();
  assert.equal(f.store.list().length, 1);
  await f.adapter.submitOneToBridge();
  assert.equal(f.bridge.submissions.length, 1);
  f.store.close();
});

test('same message id with conflicting content fails closed', () => {
  const f = fixture();
  assert.equal(f.adapter.ingestRaw(inbound()).accepted, true);
  assert.throws(() => f.adapter.ingestRaw(inbound({ item_list: [{ type: 1, text_item: { text: 'different' } }] })), /IDEMPOTENCY_CONFLICT/);
  f.store.close();
});

test('cursor acknowledgement is withheld when an allowed batch cannot be fully ingested', async () => {
  const f = fixture();
  f.adapter.ingestRaw(inbound());
  let committed = false;
  f.adapter.transport = {
    poll: async () => [inbound({ item_list: [{ type: 1, text_item: { text: 'conflict' } }] })],
    commitPoll: async () => { committed = true; },
  };
  await assert.rejects(() => f.adapter.pollInbound(), /IDEMPOTENCY_CONFLICT/);
  assert.equal(committed, false);
  f.store.close();
});

test('ambiguous outbound send is never automatically retried', async () => {
  const f = fixture([inbound()]);
  await f.adapter.runCycle();
  f.bridge.reply('bridge-1', 'reply');
  f.transport.failNextSend = true;
  await assert.rejects(() => f.adapter.runCycle(), /FAKE_AMBIGUOUS_SEND/);
  assert.equal(f.store.list()[0].status, 'OUTBOUND_UNKNOWN');
  await f.adapter.runCycle();
  assert.equal(f.transport.sent.length, 0);
  f.store.close();
});

test('restart converts an interrupted outbound attempt to unknown', () => {
  const f = fixture();
  const accepted = f.adapter.ingestRaw(inbound()).event;
  f.store.noteBridgeAttempt(accepted.id);
  f.store.bridgeQueued(accepted.id, 'bridge-z');
  f.store.replyReady(accepted.id, 'reply');
  f.store.beginOutbound(accepted.id);
  f.store.close();
  const reopened = new AdapterStore(f.filename);
  assert.equal(reopened.list()[0].status, 'OUTBOUND_UNKNOWN');
  assert.equal(reopened.list()[0].last_error, 'RECOVERED_AMBIGUOUS_OUTBOUND');
  reopened.close();
});

test('media, incomplete messages, and group messages fail closed', () => {
  const f = fixture();
  assert.equal(f.adapter.ingestRaw(inbound({ item_list: [{ type: 2, image_item: {} }] })).accepted, false);
  assert.equal(f.adapter.ingestRaw(inbound({ context_token: '' })).accepted, false);
  assert.equal(f.adapter.ingestRaw(inbound({ group_id: 'group-1' })).accepted, false);
  assert.equal(f.adapter.ingestRaw(inbound({ to_user_id: 'different-bot' })).accepted, false);
  assert.equal(f.store.list().length, 0);
  f.store.close();
});

test('direct normalization uses sender as canonical chat and tolerates missing or changing session metadata', () => {
  for (const [index, shape] of [
    { session_id: undefined, to_user_id: undefined, message_type: undefined, message_state: undefined },
    { session_id: 'ephemeral-a', to_user_id: undefined, message_state: 0 },
    { session_id: 'ephemeral-b', to_user_id: 'bot-1', message_state: 2 },
  ].entries()) {
    const f = fixture();
    const result = f.adapter.ingestRaw(inbound({ ...shape, message_id: `msg-dynamic-${index}` }));
    assert.equal(result.accepted, true);
    assert.equal(result.event.chat_id, 'user-1');
    f.store.close();
  }
});

test('inbound message id falls back losslessly to the first item msg_id', () => {
  const f = fixture();
  const result = f.adapter.ingestRaw(inbound({
    message_id: undefined, session_id: undefined,
    item_list: [{ type: 1, msg_id: '18446744073709551615', text_item: { text: 'fallback id' } }],
  }));
  assert.equal(result.accepted, true);
  assert.equal(result.event.message_id, '18446744073709551615');
  f.store.close();
});

test('generating, bot outbound, explicit wrong target, and numeric ids fail closed', () => {
  const f = fixture();
  for (const update of [
    inbound({ message_state: 1 }),
    inbound({ message_type: 2 }),
    inbound({ to_user_id: '' }),
    inbound({ message_id: 9007199254740992 }),
  ]) assert.equal(f.adapter.ingestRaw(update).accepted, false);
  assert.equal(f.store.list().length, 0);
  f.store.close();
});

test('prototype refuses multi-peer configuration to prevent context mixing', () => {
  assert.throws(() => new AllowlistPolicy({ accountId, allowedPeers: [allowed, { userId: 'user-2', chatId: 'session-2' }] }), /EXACTLY_ONE_PEER/);
});

test('natural one-shot routes only user question to ChatGPT while retaining exact inbound and original context',async()=>{
 const f=fixture();
 const token='RWX_CHAT_ONCE_'+'B'.repeat(24);
 const question='Hi Riven, how was your day?';
 const accepted=f.adapter.ingestRaw(inbound({
   message_id:'natural-inbound-1',
   item_list:[{type:1,text_item:{text:token+' '+question}}]
 }));
 assert.equal(accepted.accepted,true);
 assert.equal(f.store.get(accepted.event.id).text,token+' '+question);
 await f.adapter.submitOneToBridge();
 assert.equal(f.bridge.submissions.length,1);
 assert.equal(f.bridge.submissions[0].text,
   '[WeChat authorized text | adapter_event='+accepted.event.id+']\n'+question);
 assert.equal(f.bridge.submissions[0].text.includes(token),false);
 f.bridge.reply('bridge-1','Hello, 测试用户！');
 assert.equal((await f.adapter.collectOneReply()).status,'REPLY_READY');
 f.store.close();
});
test('invalid/malformed natural prefix cannot alter ordinary adapter bridge content',async()=>{
 const f=fixture();
 const prefix='RWX_CHAT_ONCE_'+'B'.repeat(24);
 const text=prefix+' '+('x'.repeat(1201));
 const accepted=f.adapter.ingestRaw(inbound({message_id:'invalid-natural',item_list:[{type:1,text_item:{text}}]}));
 assert.equal(accepted.accepted,true);
 await f.adapter.submitOneToBridge();
 assert.ok(f.bridge.submissions[0].text.includes(text));
 f.store.close();
});
