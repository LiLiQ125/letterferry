import { chmodSync, linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const ID = /^[A-Za-z0-9@._:-]{1,256}$/;

export function loadRuntimeConfig(filename = resolve('data/weixin-runtime.json')) {
  let config;
  try { config = JSON.parse(readFileSync(filename, 'utf8')); } catch { throw new Error('RUNTIME_CONFIG_REQUIRED'); }
  if (!config || typeof config !== 'object' || !ID.test(config.allowedPeer?.userId || '')
      || config.allowedPeer?.chatId !== config.allowedPeer.userId) {
    throw new Error('EXACT_ALLOWED_PEER_REQUIRED');
  }
  if (typeof config.inboundEnabled !== 'boolean' || typeof config.outboundEnabled !== 'boolean') throw new Error('EXPLICIT_CAPABILITY_FLAGS_REQUIRED');
  if (config.liveApproval !== 'I_APPROVE_ONE_LOCAL_LIVE_CYCLE') throw new Error('LIVE_APPROVAL_REQUIRED');
  return {
    allowedPeer: { userId: config.allowedPeer.userId, chatId: config.allowedPeer.chatId },
    inboundEnabled: config.inboundEnabled,
    outboundEnabled: config.outboundEnabled,
  };
}

export class RuntimeBindingStore {
  constructor(filename = resolve('data/weixin-runtime.json')) { this.filename = filename; }
  exists() { try { return statSync(this.filename).isFile(); } catch { return false; } }
  create(allowedPeer) {
    if (!ID.test(allowedPeer?.userId || '') || allowedPeer?.chatId !== allowedPeer.userId) throw new Error('INVALID_PAIRING_BINDING');
    if (this.exists()) throw new Error('PAIRING_BINDING_ALREADY_EXISTS');
    const config = {
      allowedPeer: { userId: allowedPeer.userId, chatId: allowedPeer.chatId },
      inboundEnabled: false,
      outboundEnabled: false,
      liveApproval: 'REPLACE_ONLY_AFTER_MANUAL_APPROVAL',
    };
    mkdirSync(dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    try { linkSync(temporary, this.filename); }
    catch (error) { throw new Error(`PAIRING_BINDING_COMMIT_FAILED:${error.code || 'UNKNOWN'}`); }
    try { unlinkSync(temporary); } catch {}
    try { chmodSync(this.filename, 0o600); } catch {}
    return config;
  }
}
