import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProtectedAuthStore } from '../src/auth-store.mjs';
import { AllowlistPolicy } from '../src/policy.mjs';
import { AdapterStore } from '../src/store.mjs';
import { RealWeixinTransport } from '../src/transports/real-weixin.mjs';
import { ExistingBridgeClient } from '../src/bridge-client.mjs';
import { WeixinBridgeAdapter } from '../src/adapter.mjs';
import { loadEncryptionKey } from '../src/secrets.mjs';

async function main() {
  if (process.env.RIVEN_WEIXIN_ONESHOT !== 'OWNER_APPROVED_ONE_INBOUND_CYCLE') {
    throw new Error('ONESHOT_EXPLICIT_APPROVAL_REQUIRED');
  }
  const config = JSON.parse(readFileSync(resolve('data/weixin-runtime.json'), 'utf8'));
  if (!config.allowedPeer?.userId || config.allowedPeer.chatId !== config.allowedPeer.userId
    || config.inboundEnabled !== false || config.outboundEnabled !== false
    || config.liveApproval === 'I_APPROVE_ONE_LOCAL_LIVE_CYCLE') {
    throw new Error('ONESHOT_REQUIRES_DISABLED_PERSISTENT_CAPABILITIES');
  }
  const authStore = new ProtectedAuthStore();
  const auth = await authStore.load();
  const policy = new AllowlistPolicy({ accountId: auth.accountId, allowedPeers: [config.allowedPeer] });
  const bridge = new ExistingBridgeClient({ origin: process.env.CHATGPT_BRIDGE_ORIGIN });
  const transport = new RealWeixinTransport({
    authStore, allowedPeer: config.allowedPeer,
    inboundEnabled: true, outboundEnabled: false
  });
  const encryptionKey = loadEncryptionKey();
  const store = new AdapterStore(resolve('data/adapter.sqlite'));
  try {
    if (store.next('RECEIVED')) throw new Error('PREEXISTING_UNSENT_EVENT_REQUIRES_REVIEW');
    const adapter = new WeixinBridgeAdapter({
      accountId: auth.accountId, policy, store, transport, bridge, encryptionKey,
    });
    // Exactly one authorized getupdates poll. No outbound transport call is possible.
    const incoming = await adapter.pollInbound();
    const accepted = incoming.filter((x) => x.accepted);
    let queuedToBridge = false;
    if (accepted.length > 0) {
      const queued = await adapter.submitOneToBridge();
      queuedToBridge = Boolean(queued && queued.status === 'BRIDGE_QUEUED');
    }
    console.log(JSON.stringify({
      liveInboundCycleCompleted: true,
      acceptedCount: accepted.length,
      bridgeQueuedCount: Number(queuedToBridge),
      remainingLocalReceivedCount: store.list().filter((x) => x.status === 'RECEIVED').length,
      weixinOutboundAttempted: false,
      persistentCapabilityFlagsChanged: false
    }));
  } finally {
    store.close();
    encryptionKey.fill(0);
  }
}
try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  const code = /^[A-Z0-9_:-]{1,130}$/.test(message) ? message : 'ONESHOT_FAILED';
  console.error(code);
  process.exitCode = 1;
}
