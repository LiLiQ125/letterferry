import { seal, unseal } from './secrets.mjs';
import { normalizeInbound } from './policy.mjs';
import {naturalContentFromText} from './natural-once.mjs';

function bridgeText(event) {
  const natural=naturalContentFromText(event.text);
  return `[WeChat authorized text | adapter_event=${event.id}]\n${natural ?? event.text}`;
}

function errorCode(error) {
  const value = error instanceof Error ? error.message : String(error);
  return /^[A-Z0-9_:-]{1,120}$/.test(value) ? value : 'REDACTED_ERROR';
}

export class WeixinBridgeAdapter {
  constructor({ accountId, policy, store, bridge, transport, encryptionKey, logger = () => {} }) {
    this.accountId = accountId;
    this.policy = policy;
    this.store = store;
    this.bridge = bridge;
    this.transport = transport;
    this.encryptionKey = encryptionKey;
    this.logger = logger;
  }

  ingestRaw(raw) {
    let update;
    try { update = normalizeInbound(raw, this.accountId); }
    catch { this.logger({ event: 'inbound_rejected', reason: 'invalid_or_unsupported' }); return { accepted: false }; }
    if (!this.policy.authorize(update)) {
      this.logger({ event: 'inbound_rejected', reason: 'not_allowlisted' });
      return { accepted: false };
    }
    const row = this.store.ingest(update, seal(update.contextToken, this.encryptionKey));
    this.logger({ event: 'inbound_accepted', adapterEventId: row.id, status: row.status });
    return { accepted: true, event: row };
  }

  async pollInbound() {
    const updates = await this.transport.poll();
    const results = updates.map((raw) => this.ingestRaw(raw));
    if (typeof this.transport.commitPoll === 'function') await this.transport.commitPoll();
    return results;
  }

  async submitOneToBridge() {
    const event = this.store.next('RECEIVED');
    if (!event) return null;
    this.store.noteBridgeAttempt(event.id);
    try {
      const result = await this.bridge.enqueue({ text: bridgeText(event), idempotencyKey: `weixin:${event.id}` });
      return this.store.bridgeQueued(event.id, result.eventId);
    } catch (error) {
      this.store.bridgeError(event.id, errorCode(error));
      throw error;
    }
  }

  async collectOneReply() {
    const event = this.store.next('BRIDGE_QUEUED');
    if (!event) return null;
    const remote = await this.bridge.getEvent(event.bridge_event_id);
    if (remote.status === 'SUCCEEDED') return this.store.replyReady(event.id, remote.replyText);
    if (['QUEUED','LEASED','DISPATCHED'].includes(remote.status)) return event;
    throw new Error(`BRIDGE_TERMINAL_${remote.status || 'UNKNOWN'}`);
  }

  async sendOneReply() {
    const candidate = this.store.next('REPLY_READY');
    if (!candidate) return null;
    const event = this.store.beginOutbound(candidate.id);
    try {
      await this.transport.sendText({
        toUserId: event.user_id,
        chatId: event.chat_id,
        clientId: event.outbound_client_id,
        contextToken: unseal(event.context_cipher, this.encryptionKey),
        text: event.reply_text
      });
      return this.store.outboundSucceeded(event.id);
    } catch (error) {
      this.store.outboundUnknown(event.id, errorCode(error));
      throw error;
    }
  }

  async runCycle() {
    const inbound = await this.pollInbound();
    const submitted = await this.submitOneToBridge();
    const collected = await this.collectOneReply();
    const sent = await this.sendOneReply();
    return { inbound, submitted, collected, sent };
  }
}
