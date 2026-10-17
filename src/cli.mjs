import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
import { ProtectedAuthStore } from './auth-store.mjs';
import { QrLoginClient } from './qr-login.mjs';
import { loadRuntimeConfig, RuntimeBindingStore } from './runtime-config.mjs';
import { PairingDiscovery } from './pairing-discovery.mjs';
import { renderTerminalQr } from './terminal-qr.mjs';
import { RealWeixinTransport } from './transports/real-weixin.mjs';
import { AdapterStore } from './store.mjs';
import { AllowlistPolicy } from './policy.mjs';
import { ExistingBridgeClient } from './bridge-client.mjs';
import { WeixinBridgeAdapter } from './adapter.mjs';
import { loadEncryptionKey } from './secrets.mjs';

const command = process.argv[2];
const authStore = new ProtectedAuthStore();

async function login() {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('FOREGROUND_TTY_REQUIRED');
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const approval = await rl.question('This will contact the public Weixin iLink API and show a QR link locally. Type LOGIN to continue: ');
    if (approval !== 'LOGIN') throw new Error('LOGIN_NOT_APPROVED');
    const client = new QrLoginClient({
      authStore,
      promptVerifyCode: () => rl.question('Enter the digits shown in Weixin: '),
      output: (event) => {
        if (event.type === 'qrcode') {
          try {
            stdout.write(`\n${renderTerminalQr(event.content)}\n`);
            stdout.write(`If the terminal QR cannot be scanned, use this local fallback link:\n${event.content}\n\n`);
          } catch {
            stdout.write(`\nTerminal QR rendering was unavailable. Use this local fallback link:\n${event.content}\n\n`);
          }
        }
        else if (event.status === 'scaned') stdout.write('QR scanned; waiting for confirmation.\n');
        else if (event.status === 'need_verifycode') stdout.write('Weixin requested foreground verification.\n');
      },
    });
    const result = await client.login();
    if (result.alreadyConnected) stdout.write('Server reported binded_redirect. No credentials were changed.\n');
    else stdout.write('Credentials stored with Windows DPAPI. Scanner identity is unverified as an inbound peer; live transport remains disabled.\n');
  } finally { rl.close(); }
}

async function pair() {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('FOREGROUND_TTY_REQUIRED');
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const approval = await rl.question('This will read a bounded Weixin update window only to bind one DM peer. Type PAIR to continue: ');
    if (approval !== 'PAIR') throw new Error('PAIRING_NOT_APPROVED');
    const discovery = new PairingDiscovery({
      authStore,
      bindingStore: new RuntimeBindingStore(),
      output: (event) => {
        if (event.type === 'challenge') {
          stdout.write('\nSend this exact one-time text manually in your Weixin Bot DM:\n');
          stdout.write(`${event.challenge}\n\nWaiting for at most 3 minutes / 6 polls. Other messages will not be printed or stored.\n`);
        }
        else if (event.type === 'diagnostic') {
          stdout.write(`Pairing poll ${event.poll}: received=${event.received} challengeHits=${event.challengeTextHits} accepted=${event.acceptedMatches} rejected=${JSON.stringify(event.rejected)}\n`);
        }
      },
    });
    const result = await discovery.discover();
    stdout.write(`Pairing completed after ${result.polls} bounded poll(s). Inbound and outbound remain disabled.\n`);
  } finally { rl.close(); }
}

async function status() {
  const bindingPresent = new RuntimeBindingStore().exists();
  stdout.write(JSON.stringify({
    codeReady: true,
    credentialsPresent: authStore.exists(),
    bindingPresent,
    liveReady: false,
    reason: bindingPresent
      ? 'Binding exists, but live eligibility and both capability flags still require human approval.'
      : 'A foreground challenge pairing and later human-approved capability flags are still required.',
  }) + '\n');
}

async function runOnce() {
  const config = loadRuntimeConfig();
  const auth = await authStore.load();
  const policy = new AllowlistPolicy({ accountId: auth.accountId, allowedPeers: [config.allowedPeer] });
  const transport = new RealWeixinTransport({ authStore, allowedPeer: config.allowedPeer,
    inboundEnabled: config.inboundEnabled, outboundEnabled: config.outboundEnabled });
  const store = new AdapterStore(resolve('data/adapter.sqlite'));
  try {
    const adapter = new WeixinBridgeAdapter({
      accountId: auth.accountId, policy, store, transport,
      bridge: new ExistingBridgeClient({ origin: process.env.CHATGPT_BRIDGE_ORIGIN }),
      encryptionKey: loadEncryptionKey(),
    });
    const result = { inboundAccepted: 0, bridgeSubmitted: false, replyCollected: false, outboundAttempted: false };
    if (config.inboundEnabled) result.inboundAccepted = (await adapter.pollInbound()).filter((item) => item.accepted).length;
    result.bridgeSubmitted = Boolean(await adapter.submitOneToBridge());
    result.replyCollected = Boolean(await adapter.collectOneReply());
    if (config.outboundEnabled) result.outboundAttempted = Boolean(await adapter.sendOneReply());
    stdout.write(JSON.stringify(result) + '\n');
  } finally { store.close(); }
}

try {
  if (command === 'login') await login();
  else if (command === 'pair') await pair();
  else if (command === 'status') await status();
  else if (command === 'run-once') await runOnce();
  else throw new Error('USAGE: npm run weixin -- login|pair|status|run-once');
} catch (error) {
  const safe = /^[A-Z0-9_:-]{1,160}$/.test(error?.message || '') ? error.message : 'OPERATION_FAILED';
  process.stderr.write(`${safe}\n`);
  process.exitCode = 1;
}
