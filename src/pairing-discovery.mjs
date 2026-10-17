import { randomBytes } from 'node:crypto';
import {
  buildGetUpdatesRequest, normalizeGetUpdatesResponse, protocolInternalsForTest, validateApiBaseUrl,
} from './transports/real-weixin.mjs';
import { canonicalDirectChatId, directEnvelopeRejection } from './policy.mjs';

export const PAIRING_TTL_MS = 3 * 60_000;
export const PAIRING_MAX_POLLS = 6;
const PAIRING_POLL_TIMEOUT_MS = 35_000;

export function createPairingChallenge(random = randomBytes) {
  return `RIVEN-PAIR-v1:${random(24).toString('base64url')}`;
}

function classifyPairingMessage(message, challenge, accountId) {
  const item = Array.isArray(message?.item_list) && message.item_list.length === 1 ? message.item_list[0] : null;
  const challengeHit = item?.type === 1 && typeof item?.text_item?.text === 'string'
    && item.text_item.text === challenge;
  const envelopeRejection = directEnvelopeRejection(message, accountId);
  if (envelopeRejection) return { reason: envelopeRejection, challengeHit };
  if (!Array.isArray(message.item_list) || message.item_list.length !== 1) return { reason: 'not_single_item', challengeHit };
  if (item?.type !== 1 || typeof item?.text_item?.text !== 'string') return { reason: 'not_single_text', challengeHit: false };
  if (item.text_item.text !== challenge) return { reason: 'challenge_mismatch', challengeHit: false };
  return { peer: { userId: message.from_user_id, chatId: canonicalDirectChatId(message.from_user_id) }, challengeHit: true };
}

function increment(counter, reason) {
  counter[reason] = (counter[reason] || 0) + 1;
}

export class PairingDiscovery {
  constructor({ authStore, bindingStore, fetchImpl = fetch, output = () => {}, clock = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), challengeFactory = createPairingChallenge,
    ttlMs = PAIRING_TTL_MS, maxPolls = PAIRING_MAX_POLLS }) {
    if (!authStore || typeof authStore.load !== 'function' || typeof authStore.updateCursor !== 'function') throw new Error('AUTH_STORE_REQUIRED');
    if (!bindingStore || typeof bindingStore.create !== 'function') throw new Error('BINDING_STORE_REQUIRED');
    this.authStore = authStore;
    this.bindingStore = bindingStore;
    this.fetch = fetchImpl;
    this.output = output;
    this.clock = clock;
    this.sleep = sleep;
    this.challengeFactory = challengeFactory;
    this.ttlMs = Math.min(Math.max(ttlMs, 1), PAIRING_TTL_MS);
    this.maxPolls = Math.min(Math.max(maxPolls, 1), PAIRING_MAX_POLLS);
  }

  async discover() {
    if (this.bindingStore.exists?.()) throw new Error('PAIRING_BINDING_ALREADY_EXISTS');
    const auth = await this.authStore.load();
    const baseUrl = validateApiBaseUrl(auth.baseUrl);
    const initialCursor = typeof auth.cursor === 'string' ? auth.cursor : '';
    let cursor = initialCursor;
    let commitCursor = null;
    const deadline = this.clock() + this.ttlMs;
    const challenge = this.challengeFactory();
    if (!/^RIVEN-PAIR-v1:[A-Za-z0-9_-]{32}$/.test(challenge)) throw new Error('INVALID_PAIRING_CHALLENGE');
    this.output({ type: 'challenge', challenge, ttlMs: this.ttlMs, maxPolls: this.maxPolls });
    const matches = new Map();
    let confirmationPolls = null;
    let polls = 0;

    while (this.clock() < deadline && polls < this.maxPolls) {
      const request = buildGetUpdatesRequest(cursor);
      let body;
      try {
        body = await protocolInternalsForTest.fetchJson(this.fetch, new URL(request.path, `${baseUrl}/`), {
          method: request.method,
          headers: protocolInternalsForTest.commonHeaders({ token: auth.botToken }),
          body: JSON.stringify(request.body),
        }, Math.min(PAIRING_POLL_TIMEOUT_MS, deadline - this.clock()), 'PAIRING_GETUPDATES');
      } catch (error) {
        if (error?.message !== 'PAIRING_GETUPDATES_TIMEOUT') throw error;
        body = { ret: 0 };
      }
      polls++;
      if (this.clock() >= deadline) throw new Error('PAIRING_TTL_EXPIRED');
      const normalized = normalizeGetUpdatesResponse(body);
      if (normalized.nextCursor) {
        cursor = normalized.nextCursor;
        commitCursor = normalized.nextCursor;
      }
      const rejected = {};
      let challengeTextHits = 0;
      let acceptedMatches = 0;
      for (const message of normalized.messages) {
        const result = classifyPairingMessage(message, challenge, auth.accountId);
        if (result.challengeHit) challengeTextHits++;
        if (!result.peer) increment(rejected, result.reason);
        else {
          acceptedMatches++;
          matches.set(result.peer.userId, result.peer);
        }
      }
      this.output({ type: 'diagnostic', poll: polls, received: normalized.messages.length,
        challengeTextHits, acceptedMatches, rejected });
      if (matches.size > 1) throw new Error('PAIRING_AMBIGUOUS_MATCH');
      if (matches.size === 1) {
        if (confirmationPolls === null) confirmationPolls = 1;
        else if (--confirmationPolls === 0) break;
      }
      if (this.clock() < deadline && polls < this.maxPolls) await this.sleep(1000);
    }

    if (matches.size !== 1) throw new Error('PAIRING_MATCH_NOT_FOUND');
    if (confirmationPolls !== 0) throw new Error('PAIRING_CONFIRMATION_INCOMPLETE');
    if (!commitCursor || commitCursor === initialCursor) throw new Error('PAIRING_CURSOR_NOT_ADVANCED');
    const [peer] = matches.values();
    await this.authStore.updateCursor(commitCursor);
    this.bindingStore.create(peer);
    return { paired: true, polls };
  }
}
