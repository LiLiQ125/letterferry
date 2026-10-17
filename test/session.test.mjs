import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterStore } from '../src/store.mjs';
import { AllowlistPolicy } from '../src/policy.mjs';
import { WeixinBridgeAdapter } from '../src/adapter.mjs';
import { enforceBridgeLimit, loadSessionBinding, runBoundedSession, selectSessionDuration, SESSION_DURATION_MS, BRIDGE_PENDING_LIMIT_MS } from '../scripts/weixin-session.mjs';

const accountId = 'bot-1';
const peer = { userId: 'user-1', chatId: 'user-1' };
const key = Buffer.alloc(32, 11);

function inbound(index = 1, overrides = {}) {
  return {
    message_id: `message-${index}`, from_user_id: peer.userId, to_user_id: accountId,
    message_type: 1, message_state: 2, context_token: `context-${index}`,
    item_list: [{ type: 1, text_item: { text: `message text ${index}` } }],
    ...overrides,
  };
}

class SessionTransport {
  constructor(batches = []) {
    this.batches = [...batches];
    this.sent = [];
    this.commits = 0;
    this.sendError = null;
    this.onPoll = null;
  }
  async poll() {
    this.onPoll?.();
    const next = this.batches.length ? this.batches.shift() : [];
    if (next instanceof Error) throw next;
    return next;
  }
  async commitPoll() { this.commits++; }
  async sendText(message) {
    if (this.sendError) throw this.sendError;
    this.sent.push(structuredClone(message));
    return { accepted: true };
  }
}

class SessionBridge {
  constructor(status = 'SUCCEEDED') {
    this.status = status;
    this.events = new Map();
    this.enqueues = [];
  }
  async enqueue(input) {
    this.enqueues.push(structuredClone(input));
    const prior = [...this.events.values()].find((event) => event.key === input.idempotencyKey);
    if (prior) return { eventId: prior.id };
    const event = { id: `bridge-${this.events.size + 1}`, key: input.idempotencyKey };
    this.events.set(event.id, event);
    return { eventId: event.id };
  }
  async getEvent(eventId) {
    if (!this.events.has(eventId)) throw new Error('BRIDGE_EVENT_MISSING');
    return { status: this.status, replyText: this.status === 'SUCCEEDED' ? 'safe reply' : null };
  }
}

function fixture(batches = [], bridgeStatus = 'SUCCEEDED') {
  const directory = mkdtempSync(join(tmpdir(), 'rwb-session-'));
  const store = new AdapterStore(join(directory, 'adapter.sqlite'));
  const transport = new SessionTransport(batches);
  const bridge = new SessionBridge(bridgeStatus);
  const policy = new AllowlistPolicy({ accountId, allowedPeers: [peer] });
  const adapter = new WeixinBridgeAdapter({ accountId, policy, store, transport, bridge, encryptionKey: key });
  return { store, transport, bridge, adapter };
}

function fakeTime() {
  let value = 0;
  return { clock: () => value, sleep: async (ms) => { value += Math.max(1, ms); } };
}

async function run(f, options = {}) {
  const time = fakeTime();
  return runBoundedSession({ adapter: f.adapter, store: f.store, clock: time.clock, sleep: time.sleep,
    durationMs: 20, pollReserveMs: 0, operationReserveMs: 0,
    bridgePendingLimitMs: 5, idleDelayMs: 1, ...options });
}

test('foreground session completes a happy offline receive, bridge, and send path', async () => {
  const f = fixture([[inbound()]]);
  const summary = await run(f);
  assert.equal(summary.reason, 'DEADLINE');
  assert.equal(summary.acceptedUnique, 1);
  assert.equal(summary.bridgeQueued, 1);
  assert.equal(summary.repliesSent, 1);
  assert.equal(f.store.list()[0].status, 'SUCCEEDED');
  assert.equal(f.transport.sent.length, 1);
  f.store.close();
});

test('getupdates timeout is empty without ingestion and the 20-message limit drains inflight work', async () => {
  const timeout = new Error('GETUPDATES_TIMEOUT');
  const f = fixture([timeout, Array.from({ length: 20 }, (_, index) => inbound(index + 1))]);
  const summary = await run(f, { durationMs: 200 });
  assert.equal(summary.reason, 'MESSAGE_LIMIT_DRAINED');
  assert.equal(summary.pollTimeouts, 1);
  assert.equal(summary.acceptedUnique, 20);
  assert.equal(summary.repliesSent, 20);
  assert.equal(f.transport.sent.length, 20);
  f.store.close();
});

test('a batch larger than the remaining quota stops exactly at 20 and withholds cursor commit', async () => {
  const f = fixture([Array.from({ length: 21 }, (_, index) => inbound(index + 1))]);
  const summary = await run(f, { durationMs: 200 });
  assert.equal(summary.reason, 'MESSAGE_LIMIT_DRAINED');
  assert.equal(summary.acceptedUnique, 20);
  assert.equal(f.store.list().length, 20);
  assert.equal(f.transport.commits, 0);
  f.store.close();
});

test('duplicate ingestion counts once and bridge enqueue remains idempotent', async () => {
  const message = inbound();
  const f = fixture([[message, structuredClone(message)]]);
  const summary = await run(f);
  assert.equal(summary.acceptedUnique, 1);
  assert.equal(summary.duplicateAccepted, 1);
  assert.equal(f.store.list().length, 1);
  assert.equal(f.bridge.enqueues.length, 1);
  f.store.close();
});

test('only the configured direct peer is accepted', async () => {
  const stranger = inbound(1, { from_user_id: 'stranger' });
  const group = inbound(2, { group_id: 'group-1' });
  const f = fixture([[stranger, group, inbound(3)]]);
  const summary = await run(f);
  assert.equal(summary.acceptedUnique, 1);
  assert.equal(f.store.list().length, 1);
  assert.equal(f.store.list()[0].message_id, 'message-3');
  f.store.close();
});

test('2000-character transport boundaries fail closed without truncation or send', async () => {
  const inboundTooLargeForEnvelope = fixture([[inbound(1, {
    item_list: [{ type: 1, text_item: { text: 'x'.repeat(2000) } }],
  })]]);
  inboundTooLargeForEnvelope.adapter.bridge = enforceBridgeLimit(inboundTooLargeForEnvelope.bridge);
  await assert.rejects(() => run(inboundTooLargeForEnvelope), /BRIDGE_TEXT_LIMIT_EXCEEDED/);
  assert.equal(inboundTooLargeForEnvelope.store.list()[0].status, 'RECEIVED');
  assert.equal(inboundTooLargeForEnvelope.bridge.enqueues.length, 0);
  inboundTooLargeForEnvelope.store.close();

  const oversizedReply = fixture([]);
  const accepted = oversizedReply.adapter.ingestRaw(inbound()).event;
  oversizedReply.store.noteBridgeAttempt(accepted.id);
  oversizedReply.store.bridgeQueued(accepted.id, 'bridge-large');
  oversizedReply.bridge.events.set('bridge-large', { id: 'bridge-large', key: `weixin:${accepted.id}` });
  oversizedReply.bridge.getEvent = async () => ({ status: 'SUCCEEDED', replyText: 'y'.repeat(2001) });
  const summary = await run(oversizedReply);
  assert.equal(summary.reason, 'REPLY_TEXT_LIMIT_EXCEEDED');
  assert.equal(oversizedReply.store.list()[0].status, 'REPLY_READY');
  assert.equal(oversizedReply.transport.sent.length, 0);
  oversizedReply.store.close();
});

test('ambiguous send fails closed and restart refuses replay', async () => {
  const f = fixture([[inbound()]]);
  f.transport.sendError = new Error('SENDMESSAGE_TIMEOUT');
  await assert.rejects(() => run(f), /SENDMESSAGE_TIMEOUT/);
  assert.equal(f.store.list()[0].status, 'OUTBOUND_UNKNOWN');
  assert.equal(f.transport.sent.length, 0);
  await assert.rejects(() => run(f), /SESSION_AMBIGUOUS_OUTBOUND_REQUIRES_REVIEW/);
  f.store.close();
});

test('pending bridge wait is bounded and terminal blocked bridge fails closed', async () => {
  const pending = fixture([[inbound()]], 'QUEUED');
  const pendingSummary = await run(pending, { durationMs: 50, bridgePendingLimitMs: 3 });
  assert.equal(pendingSummary.reason, 'BRIDGE_PENDING_TIMEOUT');
  assert.equal(pending.store.list()[0].status, 'BRIDGE_QUEUED');
  assert.equal(pending.transport.sent.length, 0);
  pending.store.close();

  const blocked = fixture([[inbound()]], 'FAILED');
  await assert.rejects(() => run(blocked), /BRIDGE_TERMINAL_FAILED/);
  assert.equal(blocked.transport.sent.length, 0);
  blocked.store.close();
});

test('preexisting safe states resume without replay while an interrupted send does not', async () => {
  const safe = fixture([]);
  const accepted = safe.adapter.ingestRaw(inbound()).event;
  safe.store.noteBridgeAttempt(accepted.id);
  safe.store.bridgeQueued(accepted.id, 'bridge-existing');
  safe.bridge.events.set('bridge-existing', { id: 'bridge-existing', key: `weixin:${accepted.id}` });
  const summary = await run(safe);
  assert.equal(summary.repliesSent, 1);
  assert.equal(safe.bridge.enqueues.length, 0);
  safe.store.close();

  const unsafe = fixture([]);
  const event = unsafe.adapter.ingestRaw(inbound()).event;
  unsafe.store.noteBridgeAttempt(event.id);
  unsafe.store.bridgeQueued(event.id, 'bridge-existing');
  unsafe.store.replyReady(event.id, 'reply');
  unsafe.store.beginOutbound(event.id);
  await assert.rejects(() => run(unsafe), /SESSION_AMBIGUOUS_OUTBOUND_REQUIRES_REVIEW/);
  assert.equal(unsafe.transport.sent.length, 0);
  unsafe.store.close();
});

test('Ctrl+C-style cancellation stops before another operation', async () => {
  const controller = new AbortController();
  const f = fixture([[]]);
  f.transport.onPoll = () => controller.abort();
  const summary = await run(f, { signal: controller.signal });
  assert.equal(summary.reason, 'CANCELLED');
  assert.equal(f.transport.sent.length, 0);
  f.store.close();
});

test('session binding requires one peer and persistent permissions remain false', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rwb-session-config-'));
  const filename = join(directory, 'runtime.json');
  writeFileSync(filename, JSON.stringify({ allowedPeer: peer, inboundEnabled: false, outboundEnabled: false,
    liveApproval: 'REPLACE_ONLY_AFTER_MANUAL_APPROVAL' }));
  assert.deepEqual(loadSessionBinding(filename), { allowedPeer: peer });
  writeFileSync(filename, JSON.stringify({ allowedPeer: peer, inboundEnabled: true, outboundEnabled: false }));
  assert.throws(() => loadSessionBinding(filename), /PERSISTENT_CAPABILITIES_MUST_BE_DISABLED/);
});

test('failed getupdates API stops the session without a cursor-style commit', async () => {
  const f = fixture([[inbound()], new Error('GETUPDATES_REJECTED_-1')]);
  await assert.rejects(() => run(f), /GETUPDATES_REJECTED_-1/);
  assert.equal(f.transport.commits, 1);
  f.store.close();
});


test('foreground launcher duration is strictly limited to 30 or 60 minutes', () => {
  assert.equal(SESSION_DURATION_MS, 60 * 60_000);
  assert.equal(selectSessionDuration({}), 60 * 60_000);
  assert.equal(selectSessionDuration({ RIVEN_WEIXIN_SESSION_MINUTES: '30' }), 30 * 60_000);
  assert.equal(selectSessionDuration({ RIVEN_WEIXIN_SESSION_MINUTES: '60' }), 60 * 60_000);
  for (const invalid of ['0', '15', '90', '30.5', 'abc', '']) {
    assert.throws(() => selectSessionDuration({ RIVEN_WEIXIN_SESSION_MINUTES: invalid }), /SESSION_DURATION_NOT_ALLOWED/);
  }
  assert.equal(BRIDGE_PENDING_LIMIT_MS, 10 * 60_000);
});

test('session never starts another long Weixin poll while a browser reply is still pending',async()=>{
 const f=fixture([[inbound(10)]],'QUEUED');
 let polls=0,replies=0;
 f.transport.poll=async()=>{
   polls++;
   if(polls===1)return [inbound(10)];
   if(replies<4)throw Error('WEIXIN_POLL_BEFORE_BROWSER_REPLY');
   return [];
 };
 f.bridge.getEvent=async()=>{
   replies++;
   return replies<4?{status:'QUEUED',replyText:null}:{status:'SUCCEEDED',replyText:'short reply'};
 };
 const summary=await run(f,{durationMs:50,bridgePendingLimitMs:30});
 assert.equal(summary.repliesSent,1);
 assert.equal(f.transport.sent.length,1);
 assert.ok(replies>=4);
 f.store.close();
});
test('session processes an existing READY reply before its next long poll',async()=>{
 const f=fixture([]);
 const event=f.adapter.ingestRaw(inbound(11)).event;
 f.store.noteBridgeAttempt(event.id);
 f.store.bridgeQueued(event.id,'old-web-id');
 f.store.replyReady(event.id,'cached response');
 let polls=0;
 f.transport.poll=async()=>{polls++;if(f.transport.sent.length===0)throw Error('WAITED_FOR_POLL_BEFORE_SEND');return [];};
 const summary=await run(f,{durationMs:15});
 assert.equal(summary.repliesSent,1);
 assert.ok(polls>=1);
 assert.equal(f.transport.sent[0].text,'cached response');
 f.store.close();
});
