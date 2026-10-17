import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProtectedAuthStore } from '../src/auth-store.mjs';
import { AdapterStore } from '../src/store.mjs';
import { AllowlistPolicy } from '../src/policy.mjs';
import { ExistingBridgeClient } from '../src/bridge-client.mjs';
import { RealWeixinTransport } from '../src/transports/real-weixin.mjs';
import { WeixinBridgeAdapter } from '../src/adapter.mjs';
import { loadEncryptionKey } from '../src/secrets.mjs';

const EXPECTED_BRIDGE_EVENT = '8a88a734-8924-42e4-9efb-feaefcff7977';
const EXPECTED_ADAPTER_EVENT = '07767bb1-31dc-438e-b433-ebb981de79b9';

async function main() {
  if (process.env.RIVEN_WEIXIN_SEND_ONCE !== 'OWNER_APPROVED_EXACT_REPLY_20261016') {
    throw new Error('SEND_ONCE_APPROVAL_REQUIRED');
  }
  const cfg = JSON.parse(readFileSync(resolve('data/weixin-runtime.json'), 'utf8'));
  if (!cfg.allowedPeer?.userId || cfg.allowedPeer.userId !== cfg.allowedPeer.chatId
    || cfg.inboundEnabled !== false || cfg.outboundEnabled !== false
    || cfg.liveApproval === 'I_APPROVE_ONE_LOCAL_LIVE_CYCLE') {
    throw new Error('PERSISTENT_CAPABILITIES_MUST_REMAIN_DISABLED');
  }
  const authStore = new ProtectedAuthStore();
  const auth = await authStore.load();
  const bridge = new ExistingBridgeClient({ origin: process.env.CHATGPT_BRIDGE_ORIGIN });
  const cryptoKey = loadEncryptionKey();
  let store;
  try {
    store = new AdapterStore(resolve('data/adapter.sqlite'));
    const events = store.list();
    if (events.length !== 1 || events[0]?.id !== EXPECTED_ADAPTER_EVENT
        || events[0]?.bridge_event_id !== EXPECTED_BRIDGE_EVENT
        || events[0]?.status !== 'BRIDGE_QUEUED') {
      throw new Error('EXACT_SINGLE_PENDING_REPLY_NOT_FOUND');
    }
    if (events[0].user_id !== cfg.allowedPeer.userId
      || events[0].chat_id !== cfg.allowedPeer.chatId) {
      throw new Error('PENDING_REPLY_PEER_MISMATCH');
    }
    const remote = await bridge.getEvent(EXPECTED_BRIDGE_EVENT);
    if (remote.status !== 'SUCCEEDED' || typeof remote.replyText !== 'string'
      || !remote.replyText.trim() || remote.replyText.length > 8000) {
      throw new Error('BRIDGE_REPLY_NOT_READY');
    }
    const policy = new AllowlistPolicy({ accountId: auth.accountId, allowedPeers: [cfg.allowedPeer] });
    const transport = new RealWeixinTransport({ authStore,
      allowedPeer: cfg.allowedPeer, inboundEnabled: false, outboundEnabled: true });
    const adapter = new WeixinBridgeAdapter({ accountId: auth.accountId,
      policy, store, transport, bridge, encryptionKey: cryptoKey });
    const collected = await adapter.collectOneReply();
    if (collected?.id !== EXPECTED_ADAPTER_EVENT || collected.status !== 'REPLY_READY') {
      throw new Error('REPLY_COLLECT_DID_NOT_MATCH');
    }
    const sent = await adapter.sendOneReply();
    if (sent?.id !== EXPECTED_ADAPTER_EVENT || sent.status !== 'SUCCEEDED') {
      throw new Error('SEND_DID_NOT_COMPLETE');
    }
    console.log(JSON.stringify({eventMatched: true, weixinApiAccepted: true,
      weixinOutboundCalls: 1, userDeliveryObserved: false, persistentFlagsChanged: false}));
  } finally {
    store?.close();
    cryptoKey.fill(0);
  }
}
try { await main(); }
catch (error) {
  const s = error instanceof Error ? error.message : '';
  console.error(/^[A-Z0-9_:-]{1,125}$/.test(s) ? s : 'SEND_ONCE_FAILED');
  process.exitCode=1;
}
