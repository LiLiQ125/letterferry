function safeLoopbackOrigin(value) {
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) throw new Error('BRIDGE_MUST_BE_LOOPBACK');
  if (!/^\/bridge-[a-f0-9]{64}$/i.test(url.pathname.replace(/\/$/, ''))) throw new Error('BRIDGE_CAPABILITY_PATH_REQUIRED');
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

export class ExistingBridgeClient {
  constructor({ origin, fetchImpl = fetch }) {
    this.base = safeLoopbackOrigin(origin);
    this.fetch = fetchImpl;
  }
  async enqueue({ text, idempotencyKey }) {
    const response = await this.fetch(new URL(`${this.base.pathname}/api/send`, this.base), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, idempotencyKey })
    });
    if (!response.ok) throw new Error(`BRIDGE_HTTP_${response.status}`);
    const body = await response.json();
    if (!body?.eventId || body.status !== 'QUEUED') throw new Error('BRIDGE_INVALID_ENQUEUE_RESPONSE');
    return { eventId: body.eventId };
  }
  async getEvent(eventId) {
    const response = await this.fetch(new URL(`${this.base.pathname}/api/event/${encodeURIComponent(eventId)}`, this.base), { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`BRIDGE_HTTP_${response.status}`);
    const body = await response.json();
    return { status: body.status, replyText: body.replyText ?? null, ...(body.diagnostic ? {diagnostic:body.diagnostic} : {}) };
  }
}
