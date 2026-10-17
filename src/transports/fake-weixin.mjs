export class FakeWeixinTransport {
  constructor(updates = []) {
    this.updates = [...updates];
    this.sent = [];
    this.failNextSend = false;
  }
  async poll() { return this.updates.splice(0); }
  async sendText(message) {
    if (this.failNextSend) { this.failNextSend = false; throw new Error('FAKE_AMBIGUOUS_SEND'); }
    this.sent.push(structuredClone(message));
    return { accepted: true };
  }
}
