import { FIXED_BASE_URL, redirectHostToBaseUrl, validateApiBaseUrl, protocolInternalsForTest } from './transports/real-weixin.mjs';

export const QR_TTL_MS = 5 * 60_000;
export const QR_POLL_TIMEOUT_MS = 35_000;
const STATUSES = new Set(['wait', 'scaned', 'need_verifycode', 'scaned_but_redirect', 'expired', 'verify_code_blocked', 'confirmed', 'binded_redirect']);

function cleanOpaque(value, label, max = 4096) {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`INVALID_${label}`);
  return value;
}

export class QrLoginClient {
  constructor({ authStore, fetchImpl = fetch, promptVerifyCode, output = () => {}, clock = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    if (!authStore || typeof authStore.create !== 'function') throw new Error('AUTH_STORE_REQUIRED');
    if (typeof promptVerifyCode !== 'function') throw new Error('VERIFY_PROMPT_REQUIRED');
    this.authStore = authStore;
    this.fetch = fetchImpl;
    this.promptVerifyCode = promptVerifyCode;
    this.output = output;
    this.clock = clock;
    this.sleep = sleep;
  }

  async login() {
    if (this.authStore.exists?.()) throw new Error('AUTH_ALREADY_EXISTS');
    const qr = await protocolInternalsForTest.fetchJson(this.fetch,
      `${FIXED_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`, {
        method: 'POST',
        headers: protocolInternalsForTest.commonHeaders({ token: '' }),
        body: JSON.stringify({ local_token_list: [] }),
      }, 15_000, 'QR_CREATE');
    const qrcode = cleanOpaque(qr.qrcode, 'QRCODE');
    const qrcodeContent = cleanOpaque(qr.qrcode_img_content, 'QRCODE_CONTENT', 8192);
    this.output({ type: 'qrcode', content: qrcodeContent });
    const deadline = this.clock() + QR_TTL_MS;
    let pollBaseUrl = FIXED_BASE_URL;
    let verifyCode;

    while (this.clock() < deadline) {
      const remainingMs = deadline - this.clock();
      const url = new URL('/ilink/bot/get_qrcode_status', `${pollBaseUrl}/`);
      url.searchParams.set('qrcode', qrcode);
      if (verifyCode) url.searchParams.set('verify_code', verifyCode);
      const status = await protocolInternalsForTest.fetchJson(this.fetch, url, {
        method: 'GET', headers: protocolInternalsForTest.commonHeaders(),
      }, Math.min(QR_POLL_TIMEOUT_MS, remainingMs), 'QR_STATUS');
      if (this.clock() >= deadline) throw new Error('QR_LOGIN_TTL_EXPIRED');
      if (!STATUSES.has(status.status)) throw new Error('UNKNOWN_QR_STATUS');
      this.output({ type: 'status', status: status.status });
      if (status.status === 'wait' || status.status === 'scaned') {
        if (status.status === 'scaned') verifyCode = undefined;
      } else if (status.status === 'need_verifycode') {
        const code = String(await this.promptVerifyCode()).trim();
        if (!/^\d{1,12}$/.test(code)) throw new Error('INVALID_VERIFY_CODE');
        verifyCode = code;
        continue;
      } else if (status.status === 'scaned_but_redirect') {
        pollBaseUrl = redirectHostToBaseUrl(status.redirect_host);
      } else if (status.status === 'expired') {
        throw new Error('QR_EXPIRED_NO_AUTO_REFRESH');
      } else if (status.status === 'verify_code_blocked') {
        throw new Error('VERIFY_CODE_BLOCKED');
      } else if (status.status === 'binded_redirect') {
        return { connected: false, alreadyConnected: true };
      } else if (status.status === 'confirmed') {
        const auth = {
          botToken: cleanOpaque(status.bot_token, 'BOT_TOKEN', 16384),
          accountId: cleanOpaque(status.ilink_bot_id, 'ACCOUNT_ID', 256),
          scannerUserId: cleanOpaque(status.ilink_user_id, 'SCANNER_USER_ID', 256),
          baseUrl: validateApiBaseUrl(status.baseurl),
          cursor: '',
          createdAt: new Date(this.clock()).toISOString(),
        };
        await this.authStore.create(auth);
        return { connected: true };
      }
      await this.sleep(1000);
    }
    throw new Error('QR_LOGIN_TTL_EXPIRED');
  }
}
