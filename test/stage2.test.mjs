import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProtectedAuthStore } from '../src/auth-store.mjs';
import { QrLoginClient } from '../src/qr-login.mjs';
import { loadRuntimeConfig, RuntimeBindingStore } from '../src/runtime-config.mjs';
import { PairingDiscovery, createPairingChallenge } from '../src/pairing-discovery.mjs';
import { renderTerminalQr } from '../src/terminal-qr.mjs';
import {
  RealWeixinTransport, parseWeixinApiJson, redirectHostToBaseUrl,
  validateApiBaseUrl, getUpdatesSnapshot, protocolInternalsForTest,
} from '../src/transports/real-weixin.mjs';

function response(body, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => typeof body === 'string' ? body : JSON.stringify(body) };
}

function authStore(initial = {}) {
  const state = { botToken: 'secret-token', accountId: 'bot-1', scannerUserId: 'scanner-1', baseUrl: 'https://ilinkai.weixin.qq.com', cursor: '', ...initial };
  const created = [];
  return {
    state, created,
    exists: () => false,
    load: async () => ({ ...state }),
    updateCursor: async (cursor) => { state.cursor = cursor; },
    create: async (auth) => { created.push(structuredClone(auth)); },
  };
}

const peer = { userId: 'user-1', chatId: 'user-1' };

test('DPAPI store abstraction writes only protected bytes and roundtrips with injected protector', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwb-auth-'));
  const filename = join(dir, 'auth.dpapi');
  const mask = (data) => Buffer.from(data).map((byte) => byte ^ 0xa5);
  const store = new ProtectedAuthStore(filename, { protect: async (data) => mask(data), unprotect: async (data) => mask(data) });
  await store.create({ botToken: 'plaintext-secret', accountId: 'bot-1', scannerUserId: 'scanner-1', baseUrl: 'https://ilinkai.weixin.qq.com', cursor: '' });
  assert.equal(readFileSync(filename).includes(Buffer.from('plaintext-secret')), false);
  assert.equal((await store.load()).botToken, 'plaintext-secret');
  await store.updateCursor('cursor-2');
  assert.equal((await store.load()).cursor, 'cursor-2');
  await assert.rejects(() => store.create({}), /INVALID_AUTH_RECORD|AUTH_ALREADY_EXISTS/);
});

test('explicit environment auth key fallback uses authenticated encryption and fails closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwb-auth-key-'));
  const filename = join(dir, 'auth.protected');
  const key = 'ab'.repeat(32);
  const store = new ProtectedAuthStore(filename, null, { RIVEN_WEIXIN_AUTH_KEY: key });
  await store.create({ botToken: 'environment-key-secret', accountId: 'bot-1', scannerUserId: 'scanner-1', baseUrl: 'https://ilinkai.weixin.qq.com', cursor: '' });
  assert.equal(readFileSync(filename).includes(Buffer.from('environment-key-secret')), false);
  assert.equal((await store.load()).botToken, 'environment-key-secret');
  await assert.rejects(() => new ProtectedAuthStore(filename, null, { RIVEN_WEIXIN_AUTH_KEY: 'cd'.repeat(32) }).load());
  assert.throws(() => new ProtectedAuthStore(filename, null, { RIVEN_WEIXIN_AUTH_KEY: 'short' }), /64_HEX/);
});

test('API and redirect URL validation rejects SSRF-shaped values', () => {
  assert.equal(validateApiBaseUrl('https://ilinkai.weixin.qq.com'), 'https://ilinkai.weixin.qq.com');
  assert.equal(redirectHostToBaseUrl('edge.weixin.qq.com'), 'https://edge.weixin.qq.com');
  for (const value of ['http://ilinkai.weixin.qq.com', 'https://127.0.0.1', 'https://evil.example', 'https://x.weixin.qq.com@127.0.0.1']) {
    assert.throws(() => validateApiBaseUrl(value), /INVALID|NOT_ALLOWED/);
  }
  assert.throws(() => redirectHostToBaseUrl('127.0.0.1'), /NOT_ALLOWED/);
  assert.throws(() => redirectHostToBaseUrl('x.weixin.qq.com/path'), /INVALID/);
});

test('wire JSON parser preserves uint64 message identifiers', () => {
  const parsed = parseWeixinApiJson('{"message_id":18446744073709551615,"nested":{"msg_id":9007199254740993}}');
  assert.equal(parsed.message_id, '18446744073709551615');
  assert.equal(parsed.nested.msg_id, '9007199254740993');
});

test('authenticated headers match documented shape without exposing token elsewhere', () => {
  const headers = protocolInternalsForTest.commonHeaders({ token: 'secret' });
  assert.equal(headers.AuthorizationType, 'ilink_bot_token');
  assert.equal(headers.Authorization, 'Bearer secret');
  assert.equal(headers['iLink-App-Id'], 'bot');
  assert.equal(headers['iLink-App-ClientVersion'], String((2 << 16) | (4 << 8) | 10));
  assert.match(Buffer.from(headers['X-WECHAT-UIN'], 'base64').toString(), /^\d+$/);
});

test('getUpdates snapshot distinguishes server messages, server empty, business error and client timeout', async () => {
  let armed=0;
  const messages=await getUpdatesSnapshot({
    baseUrl:'https://ilinkai.weixin.qq.com',token:'secret-token',cursor:'old',timeoutMs:1000,
    onRequestStarted:()=>{armed++;},
    fetchImpl:async()=>response({ret:0,errmsg:'',get_updates_buf:'next',msgs:[{
      message_id:'1',from_user_id:'user-1',to_user_id:'bot-1',message_type:1,message_state:2,
      item_list:[{type:1,text_item:{text:'x'}}]
    }]})
  });
  assert.equal(armed,1);
  assert.equal(messages.outcome,'server_messages');
  assert.equal(messages.httpStatus,200);
  assert.equal(messages.ret,0);
  assert.equal(messages.errcode,null);
  assert.equal(messages.errmsgCategory,'empty');
  assert.equal(messages.cursorPresent,true);
  assert.equal(messages.cursorChanged,true);
  assert.equal(messages.messages.length,1);

  const empty=await getUpdatesSnapshot({
    baseUrl:'https://ilinkai.weixin.qq.com',token:'secret-token',cursor:'old',timeoutMs:1000,
    fetchImpl:async()=>response({ret:0,msgs:[],get_updates_buf:'old'})
  });
  assert.equal(empty.outcome,'server_empty');
  assert.equal(empty.httpStatus,200);
  assert.equal(empty.cursorPresent,true);
  assert.equal(empty.cursorChanged,false);

  const rejected=await getUpdatesSnapshot({
    baseUrl:'https://ilinkai.weixin.qq.com',token:'secret-token',timeoutMs:1000,
    fetchImpl:async()=>response({ret:-14,errmsg:'stale token'})
  });
  assert.equal(rejected.outcome,'error');
  assert.equal(rejected.errorCategory,'business');
  assert.equal(rejected.ret,-14);
  assert.equal(rejected.errmsgCategory,'present');

  const timeout=await getUpdatesSnapshot({
    baseUrl:'https://ilinkai.weixin.qq.com',token:'secret-token',timeoutMs:5,
    fetchImpl:async(_url,options)=>new Promise((_resolve,reject)=>{
      options.signal.addEventListener('abort',()=>{
        const error=new Error('aborted');error.name='AbortError';reject(error);
      },{once:true});
    })
  });
  assert.equal(timeout.outcome,'client_timeout');
  assert.equal(timeout.errorCategory,'timeout');
  assert.equal(timeout.httpStatus,null);
});

test('getUpdates snapshot preserves HTTP status when timeout occurs while reading response body', async()=>{
  const snapshot=await getUpdatesSnapshot({
    baseUrl:'https://ilinkai.weixin.qq.com',token:'secret-token',cursor:'old',timeoutMs:20,
    fetchImpl:async(_url,options)=>({
      ok:true,status:200,
      text:()=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>{
        const error=new Error('aborted');error.name='AbortError';reject(error);
      },{once:true}))
    })
  });
  assert.equal(snapshot.outcome,'client_timeout');
  assert.equal(snapshot.errorCategory,'timeout');
  assert.equal(snapshot.httpStatus,200);
  assert.ok(snapshot.elapsedMs>=0);
});

test('detailed transport poll preserves diagnostic outcome and only commits returned cursor explicitly', async()=>{
  const store=authStore({cursor:'old'});
  let armed=0;
  const transport=new RealWeixinTransport({
    authStore:store,allowedPeer:peer,inboundEnabled:true,
    fetchImpl:async()=>response({ret:0,get_updates_buf:'next',msgs:[{
      message_id:'m-detail',from_user_id:'user-1',to_user_id:'bot-1',
      message_type:1,message_state:2,context_token:'ctx',
      item_list:[{type:1,text_item:{text:'hello'}}]
    }]})
  });
  const detailed=await transport.pollDetailed({timeoutMs:45_000,onRequestStarted:()=>{armed++;}});
  assert.equal(armed,1);
  assert.equal(detailed.outcome,'server_messages');
  assert.equal(detailed.rawReceivedCount,1);
  assert.equal(detailed.messages.length,1);
  assert.equal(store.state.cursor,'old');
  await transport.commitPoll();
  assert.equal(store.state.cursor,'next');
});

test('inbound-disabled transport performs no fetch', async () => {
  let calls = 0;
  const transport = new RealWeixinTransport({ authStore: authStore(), allowedPeer: peer, fetchImpl: async () => { calls++; } });
  assert.deepEqual(await transport.poll(), []);
  assert.equal(calls, 0);
});

test('poll filters unrelated chats before returning and commits cursor only after acknowledgement', async () => {
  const store = authStore({ cursor: 'old' });
  let request;
  const transport = new RealWeixinTransport({ authStore: store, allowedPeer: peer, inboundEnabled: true, fetchImpl: async (url, options) => {
    request = { url: String(url), options };
    return response('{"ret":0,"get_updates_buf":"next","msgs":['
      + '{"message_id":9007199254740993,"from_user_id":"stranger","session_id":"other","item_list":[{"type":1,"text_item":{"text":"private"}}]},'
      + '{"message_id":9007199254740995,"from_user_id":"user-1","session_id":"rotated-session"},'
      + '{"message_id":9007199254740996,"from_user_id":"user-1","to_user_id":"bot-1","message_state":0},'
      + '{"message_id":9007199254740997,"from_user_id":"user-1","group_id":"group"},'
      + '{"message_id":9007199254740998,"from_user_id":"user-1","to_user_id":"other-bot"},'
      + '{"message_id":9007199254740999,"from_user_id":"user-1","message_type":2},'
      + '{"message_id":9007199254741000,"from_user_id":"user-1","message_state":1}]}');
  }});
  const messages = await transport.poll();
  assert.equal(messages.length, 2);
  assert.equal(messages[0].message_id, '9007199254740995');
  assert.equal(messages[1].message_id, '9007199254740996');
  assert.equal(store.state.cursor, 'old');
  assert.equal(JSON.parse(request.options.body).get_updates_buf, 'old');
  assert.equal(request.options.redirect, 'error');
  await transport.commitPoll();
  assert.equal(store.state.cursor, 'next');
});

test('getupdates accepts absent messages and only advances a nonempty cursor', async () => {
  const store = authStore({ cursor: 'old' });
  const queue = [
    response({ ret: 0, get_updates_buf: 'next' }),
    response({ ret: 0, msgs: [] }),
    response({ ret: 0, msgs: null, get_updates_buf: '' }),
  ];
  const transport = new RealWeixinTransport({ authStore: store, allowedPeer: peer, inboundEnabled: true,
    fetchImpl: async () => queue.shift() });
  assert.deepEqual(await transport.poll(), []);
  assert.equal(store.state.cursor, 'old');
  await transport.commitPoll();
  assert.equal(store.state.cursor, 'next');
  assert.deepEqual(await transport.poll(), []);
  await transport.commitPoll();
  assert.equal(store.state.cursor, 'next');
  assert.deepEqual(await transport.poll(), []);
  await transport.commitPoll();
  assert.equal(store.state.cursor, 'next');
});

test('getupdates rejects wrong message and cursor types without losing the old cursor', async () => {
  for (const body of [{ ret: 0, msgs: {} }, { ret: 0, msgs: [], get_updates_buf: 42 }]) {
    const store = authStore({ cursor: 'old' });
    const transport = new RealWeixinTransport({ authStore: store, allowedPeer: peer, inboundEnabled: true,
      fetchImpl: async () => response(body) });
    await assert.rejects(() => transport.poll(), /GETUPDATES_INVALID_(MESSAGES|CURSOR)/);
    assert.equal(store.state.cursor, 'old');
  }
});

test('outbound requires its separate gate and exact peer, preserving client and context', async () => {
  const store = authStore();
  const locked = new RealWeixinTransport({ authStore: store, allowedPeer: peer, fetchImpl: async () => { throw new Error('SHOULD_NOT_FETCH'); } });
  await assert.rejects(() => locked.sendText({ toUserId: 'user-1', chatId: 'user-1' }), /OUTBOUND_CAPABILITY_DISABLED/);
  let sent;
  const enabled = new RealWeixinTransport({ authStore: store, allowedPeer: peer, outboundEnabled: true, fetchImpl: async (url, options) => {
    sent = { url: String(url), options };
    return response('{"ret":0,"message_id":9007199254740993}');
  }});
  await assert.rejects(() => enabled.sendText({ toUserId: 'stranger', chatId: 'user-1' }), /PEER_NOT_ALLOWED/);
  const result = await enabled.sendText({ toUserId: 'user-1', chatId: 'user-1', clientId: 'stable-1', contextToken: 'context-1', text: 'reply' });
  const body = JSON.parse(sent.options.body);
  assert.equal(body.msg.client_id, 'stable-1');
  assert.equal(body.msg.context_token, 'context-1');
  assert.deepEqual(result, { accepted: true, messageId: '9007199254740993' });
});

test('send business rejection is not accepted', async () => {
  const transport = new RealWeixinTransport({ authStore: authStore(), allowedPeer: peer, outboundEnabled: true,
    fetchImpl: async () => response({ ret: -1, errmsg: 'no' }) });
  await assert.rejects(() => transport.sendText({ toUserId: 'user-1', chatId: 'user-1', clientId: 'c', contextToken: 'ctx', text: 'x' }), /SENDMESSAGE_REJECTED_-1/);
});

test('QR login persists only a complete confirmed result and verification stays foreground', async () => {
  const store = authStore();
  const calls = [];
  const queue = [
    { qrcode: 'opaque-qr', qrcode_img_content: 'https://example.invalid/local-display-only' },
    { status: 'need_verifycode' },
    { status: 'confirmed', bot_token: 'new-secret', ilink_bot_id: 'bot-new', ilink_user_id: 'scanner-new', baseurl: 'https://ilinkai.weixin.qq.com' },
  ];
  const client = new QrLoginClient({ authStore: store, fetchImpl: async (url, options) => { calls.push({ url: String(url), options }); return response(queue.shift()); },
    promptVerifyCode: async () => '123456', output: () => {}, sleep: async () => {} });
  assert.deepEqual(await client.login(), { connected: true });
  assert.equal(store.created.length, 1);
  assert.equal(store.created[0].botToken, 'new-secret');
  assert.match(calls[2].url, /verify_code=123456/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { local_token_list: [] });
});

test('failed, expired, redirect-rejected and binded QR outcomes never persist credentials', async () => {
  for (const final of [
    { status: 'expired' },
    { status: 'verify_code_blocked' },
    { status: 'scaned_but_redirect', redirect_host: '127.0.0.1' },
  ]) {
    const store = authStore();
    const queue = [{ qrcode: 'qr', qrcode_img_content: 'local' }, final];
    const client = new QrLoginClient({ authStore: store, fetchImpl: async () => response(queue.shift()), promptVerifyCode: async () => '1', output: () => {}, sleep: async () => {} });
    await assert.rejects(() => client.login());
    assert.equal(store.created.length, 0);
  }
  const store = authStore();
  const queue = [{ qrcode: 'qr', qrcode_img_content: 'local' }, { status: 'binded_redirect' }];
  const client = new QrLoginClient({ authStore: store, fetchImpl: async () => response(queue.shift()), promptVerifyCode: async () => '1', output: () => {}, sleep: async () => {} });
  assert.deepEqual(await client.login(), { connected: false, alreadyConnected: true });
  assert.equal(store.created.length, 0);
});

test('QR polling never starts a request beyond the five-minute TTL', async () => {
  const store = authStore();
  let now = 0;
  let calls = 0;
  const client = new QrLoginClient({
    authStore: store,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return response({ qrcode: 'qr', qrcode_img_content: 'local' });
      now = 5 * 60_000;
      return response({ status: 'wait' });
    },
    promptVerifyCode: async () => '1', output: () => {}, clock: () => now, sleep: async () => {},
  });
  await assert.rejects(() => client.login(), /QR_LOGIN_TTL_EXPIRED/);
  assert.equal(calls, 2);
  assert.equal(store.created.length, 0);
});

test('runtime config requires exact peer, separate booleans, and explicit one-cycle approval', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwb-config-'));
  const filename = join(dir, 'config.json');
  writeFileSync(filename, JSON.stringify({ allowedPeer: peer, inboundEnabled: true, outboundEnabled: false, liveApproval: 'I_APPROVE_ONE_LOCAL_LIVE_CYCLE' }));
  assert.deepEqual(loadRuntimeConfig(filename), { allowedPeer: peer, inboundEnabled: true, outboundEnabled: false });
  writeFileSync(filename, JSON.stringify({ allowedPeer: peer, inboundEnabled: true, outboundEnabled: true, liveApproval: 'wrong' }));
  assert.throws(() => loadRuntimeConfig(filename), /LIVE_APPROVAL_REQUIRED/);
  writeFileSync(filename, JSON.stringify({ allowedPeer: { userId: 'user-1', chatId: 'legacy-session' },
    inboundEnabled: false, outboundEnabled: false, liveApproval: 'I_APPROVE_ONE_LOCAL_LIVE_CYCLE' }));
  assert.throws(() => loadRuntimeConfig(filename), /EXACT_ALLOWED_PEER_REQUIRED/);
});

test('pairing challenge contains 192 bits of random material', () => {
  const challenge = createPairingChallenge((size) => {
    assert.equal(size, 24);
    return Buffer.alloc(size, 0x5a);
  });
  assert.match(challenge, /^RIVEN-PAIR-v1:[A-Za-z0-9_-]{32}$/);
});

test('bounded pairing binds only the unique exact DM challenge and leaves capabilities disabled', async () => {
  const store = authStore({ cursor: 'old' });
  const challenge = `RIVEN-PAIR-v1:${'A'.repeat(32)}`;
  const binding = { saved: null, exists: () => false, create(value) { this.saved = structuredClone(value); } };
  const outputs = [];
  const requests = [];
  const queue = [
    response({ ret: 0, get_updates_buf: 'cursor-1', msgs: [
      { from_user_id: 'stranger', to_user_id: 'bot-1', session_id: 'other', message_type: 1, message_state: 2,
        item_list: [{ type: 1, text_item: { text: 'unrelated private text' } }] },
      { from_user_id: 'user-1', to_user_id: 'bot-1', session_id: 'session-1', message_type: 1, message_state: 2,
        item_list: [{ type: 1, text_item: { text: challenge } }] },
    ] }),
    response({ ret: 0, get_updates_buf: 'cursor-2' }),
  ];
  const discovery = new PairingDiscovery({ authStore: store, bindingStore: binding,
    fetchImpl: async (url, options) => { requests.push(JSON.parse(options.body)); return queue.shift(); },
    output: (event) => outputs.push(event), challengeFactory: () => challenge, sleep: async () => {} });
  assert.deepEqual(await discovery.discover(), { paired: true, polls: 2 });
  assert.deepEqual(binding.saved, peer);
  assert.equal(store.state.cursor, 'cursor-2');
  assert.deepEqual(requests.map((item) => item.get_updates_buf), ['old', 'cursor-1']);
  assert.deepEqual(outputs[0], { type: 'challenge', challenge, ttlMs: 180000, maxPolls: 6 });
  assert.deepEqual(outputs.slice(1), [
    { type: 'diagnostic', poll: 1, received: 2, challengeTextHits: 1, acceptedMatches: 1,
      rejected: { challenge_mismatch: 1 } },
    { type: 'diagnostic', poll: 2, received: 0, challengeTextHits: 0, acceptedMatches: 0, rejected: {} },
  ]);
  assert.equal(JSON.stringify(outputs).includes('unrelated private text'), false);
});

test('pairing rejects competing peers and never stores a binding or advances cursor', async () => {
  const store = authStore({ cursor: 'old' });
  const challenge = `RIVEN-PAIR-v1:${'B'.repeat(32)}`;
  const binding = { saved: null, exists: () => false, create(value) { this.saved = value; } };
  const messages = ['user-1', 'user-2'].map((userId, index) => ({
    from_user_id: userId, to_user_id: 'bot-1', session_id: `session-${index + 1}`,
    message_type: 1, message_state: 2, item_list: [{ type: 1, text_item: { text: challenge } }],
  }));
  const discovery = new PairingDiscovery({ authStore: store, bindingStore: binding,
    fetchImpl: async () => response({ ret: 0, get_updates_buf: 'next', msgs: messages }),
    output: () => {}, challengeFactory: () => challenge, sleep: async () => {} });
  await assert.rejects(() => discovery.discover(), /PAIRING_AMBIGUOUS_MATCH/);
  assert.equal(binding.saved, null);
  assert.equal(store.state.cursor, 'old');
});

test('pairing ignores wrong target, group, state, type, and partial challenge', async () => {
  const store = authStore({ cursor: 'old' });
  const challenge = `RIVEN-PAIR-v1:${'C'.repeat(32)}`;
  const base = { from_user_id: 'user-1', to_user_id: 'bot-1', session_id: 'session-1', message_type: 1, message_state: 2,
    item_list: [{ type: 1, text_item: { text: challenge } }] };
  const msgs = [
    { ...base, to_user_id: 'other-bot' }, { ...base, group_id: 'group' }, { ...base, message_state: 1 },
    { ...base, message_type: 2 }, { ...base, message_state: 9 },
    { ...base, item_list: [{ type: 1, text_item: { text: `${challenge}x` } }] },
    { ...base, item_list: [{ type: 1, text_item: { text: ` ${challenge}` } }] },
    { ...base, item_list: [{ type: 1, text_item: { text: `${challenge} ` } }] },
  ];
  const outputs = [];
  const binding = { exists: () => false, create: () => { throw new Error('SHOULD_NOT_BIND'); } };
  const discovery = new PairingDiscovery({ authStore: store, bindingStore: binding,
    fetchImpl: async () => response({ ret: 0, get_updates_buf: 'next', msgs }), output: (event) => outputs.push(event),
    challengeFactory: () => challenge, sleep: async () => {}, maxPolls: 1 });
  await assert.rejects(() => discovery.discover(), /PAIRING_MATCH_NOT_FOUND/);
  assert.equal(store.state.cursor, 'old');
  assert.deepEqual(outputs[1], {
    type: 'diagnostic', poll: 1, received: 8, challengeTextHits: 5, acceptedMatches: 0,
    rejected: { wrong_target: 1, group_message: 1, generating: 1, bot_outbound: 1,
      unsupported_message_state: 1, challenge_mismatch: 3 },
  });
  assert.equal(JSON.stringify(outputs[1]).includes(challenge), false);
});

test('pairing accepts missing target/session/state and NEW with canonical sender chat id', async () => {
  for (const [index, optionalFields] of [
    { session_id: undefined, to_user_id: undefined, message_type: undefined, message_state: undefined },
    { session_id: 'changing-session-value', to_user_id: 'bot-1', message_type: 1, message_state: 0 },
  ].entries()) {
    const store = authStore({ cursor: 'old' });
    const challenge = `RIVEN-PAIR-v1:${String(index).repeat(32)}`;
    const binding = { saved: null, exists: () => false, create(value) { this.saved = value; } };
    const outputs = [];
    const queue = [
      response({ ret: 0, get_updates_buf: 'cursor-1', msgs: [{
        from_user_id: 'user-1', message_type: 1, context_token: 'must-not-appear', ...optionalFields,
        item_list: [{ type: 1, msg_id: '18446744073709551615', text_item: { text: challenge } }],
      }] }),
      response({ ret: 0, get_updates_buf: 'cursor-2' }),
    ];
    const discovery = new PairingDiscovery({ authStore: store, bindingStore: binding,
      fetchImpl: async () => queue.shift(), output: (event) => outputs.push(event),
      challengeFactory: () => challenge, sleep: async () => {} });
    assert.deepEqual(await discovery.discover(), { paired: true, polls: 2 });
    assert.deepEqual(binding.saved, peer);
    const diagnostics = outputs.filter((event) => event.type === 'diagnostic');
    assert.equal(diagnostics[0].challengeTextHits, 1);
    assert.equal(diagnostics[0].acceptedMatches, 1);
    const serialized = JSON.stringify(diagnostics);
    assert.equal(serialized.includes('must-not-appear'), false);
    assert.equal(serialized.includes('18446744073709551615'), false);
    assert.equal(serialized.includes('changing-session-value'), false);
    assert.equal(serialized.includes(challenge), false);
  }
});

test('pairing treats a bounded long-poll timeout as an empty response and continues', async () => {
  const store = authStore({ cursor: 'old' });
  const challenge = `RIVEN-PAIR-v1:${'D'.repeat(32)}`;
  const match = { from_user_id: 'user-1', to_user_id: 'bot-1', session_id: 'session-1', message_type: 1, message_state: 2,
    item_list: [{ type: 1, text_item: { text: challenge } }] };
  let call = 0;
  const binding = { saved: null, exists: () => false, create(value) { this.saved = value; } };
  const discovery = new PairingDiscovery({ authStore: store, bindingStore: binding,
    fetchImpl: async () => {
      call++;
      if (call === 1) { const error = new Error('abort'); error.name = 'AbortError'; throw error; }
      if (call === 2) return response({ ret: 0, msgs: [match], get_updates_buf: 'cursor-1' });
      return response({ ret: 0, get_updates_buf: 'cursor-2' });
    }, output: () => {}, challengeFactory: () => challenge, sleep: async () => {} });
  assert.deepEqual(await discovery.discover(), { paired: true, polls: 3 });
  assert.deepEqual(binding.saved, peer);
  assert.equal(store.state.cursor, 'cursor-2');
});

test('runtime binding store is create-once and forces both switches off', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwb-binding-'));
  const filename = join(dir, 'runtime.json');
  const binding = new RuntimeBindingStore(filename);
  const saved = binding.create(peer);
  assert.equal(saved.inboundEnabled, false);
  assert.equal(saved.outboundEnabled, false);
  assert.throws(() => loadRuntimeConfig(filename), /LIVE_APPROVAL_REQUIRED/);
  assert.throws(() => binding.create({ userId: 'user-2', chatId: 'user-2' }), /ALREADY_EXISTS/);
  const disk = JSON.parse(readFileSync(filename, 'utf8'));
  assert.deepEqual(disk.allowedPeer, peer);
  assert.equal(disk.liveApproval, 'REPLACE_ONLY_AFTER_MANUAL_APPROVAL');
});

test('terminal QR renderer returns a directly displayable block without logging it', () => {
  let input;
  const rendered = renderTerminalQr('https://local.invalid/qr', {
    generate(value, options, callback) { input = { value, options }; callback('QR-BLOCK'); },
  });
  assert.deepEqual(input, { value: 'https://local.invalid/qr', options: { small: true } });
  assert.equal(rendered, 'QR-BLOCK');
  assert.ok(renderTerminalQr('https://local.invalid/qr').length > 20);
});
