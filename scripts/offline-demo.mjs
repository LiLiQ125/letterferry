import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterStore } from '../src/store.mjs';
import { AllowlistPolicy } from '../src/policy.mjs';
import { FakeWeixinTransport } from '../src/transports/fake-weixin.mjs';
import { WeixinBridgeAdapter } from '../src/adapter.mjs';

class DemoBridge {
  constructor() { this.event = null; }
  async enqueue({ idempotencyKey }) { this.event = { id: 'offline-bridge-event', key: idempotencyKey, status: 'QUEUED' }; return { eventId: this.event.id }; }
  async getEvent() { return this.event; }
}

const update = {
  message_id: 'offline-message-1', from_user_id: 'authorized-user-1', to_user_id: 'fake-bot-account',
  session_id: 'authorized-session-1', message_type: 1, message_state: 2, context_token: 'fake-context-token',
  item_list: [{ type: 1, text_item: { text: 'Offline hello' } }]
};
const store = new AdapterStore(join(mkdtempSync(join(tmpdir(), 'riven-weixin-demo-')), 'adapter.sqlite'));
const bridge = new DemoBridge();
const transport = new FakeWeixinTransport([update]);
const policy = new AllowlistPolicy({ accountId: 'fake-bot-account', allowedPeers: [{ userId: 'authorized-user-1', chatId: 'authorized-user-1' }] });
const adapter = new WeixinBridgeAdapter({ accountId: 'fake-bot-account', policy, store, bridge, transport, encryptionKey: Buffer.alloc(32, 9) });

await adapter.runCycle();
bridge.event.status = 'SUCCEEDED';
bridge.event.replyText = 'Offline reply';
await adapter.runCycle();
console.log(JSON.stringify({ status: store.list()[0].status, outboundCount: transport.sent.length, realNetwork: false }));
store.close();
