import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { ExistingBridgeClient } from '../src/bridge-client.mjs';

const HEALTH_URL = 'http://127.0.0.1:8799/health';
const WAIT_MS = 210_000;
const INTERVAL_MS = 2_000;
const EXPECTED_REPLY = 'RIVEN_WEB_SMOKE_OK';
const FIXED_PROMPT = 'This is an explicitly user-authorized, one-time LOCAL browser bridge check (not a Weixin message). Reply with exactly RIVEN_WEB_SMOKE_OK and nothing else.';
export const MULTILINE_PROMPT = '[WeChat authorized text | adapter_event=00000000-0000-4000-8000-000000000000]\\nThis is a LOCAL SYNTHETIC browser-only test, NOT a Weixin message. Reply with exactly RIVEN_WEB_SMOKE_OK and nothing else.'.replace('\\n','\n');

export function checkWebSmokeReadiness(health) {
  if (!health || health.ok !== true) return 'WEB_HOST_UNAVAILABLE';
  if (health.host !== 'HOST_READY') return 'WEB_HOST_NOT_ARMED';
  if (health.weixinDeliveryVerified === true) return 'UNEXPECTED_DELIVERY_MODE';
  const counts = health.queue || {};
  if (Object.entries(counts).some(([status,count]) => !['SUCCEEDED','REVIEWED_NO_REPLAY'].includes(status) && Number(count) > 0)) return 'UNRESOLVED_WEB_EVENTS';
  return 'READY';
}
export function judgeWebSmokeReply(status, reply) {
  if (status === 'TIMED_OUT_UNKNOWN') return 'DELIVERY_UNKNOWN';
  if (status !== 'SUCCEEDED') return 'PENDING';
  return reply?.trim() === EXPECTED_REPLY ? 'PASS' : 'REPLY_MISMATCH';
}

async function health() {
  const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(4_000) });
  if (!response.ok) throw Error('HEALTH_HTTP_ERROR');
  return response.json();
}
function keyFromFile() {
  const path = resolve('data/web-host.key');
  let key;
  try { key = readFileSync(path, 'utf8').trim(); }
  catch { throw Error('WEB_HOST_KEY_NOT_FOUND'); }
  if (!/^[a-f0-9]{64}$/.test(key)) throw Error('WEB_HOST_KEY_INVALID');
  return key;
}
const delay = ms => new Promise(r => setTimeout(r,ms));

export async function runLiveWebSmoke({ask,now=()=>Date.now(),report=console.log,mode='single'}={}) {
  if(!['single','multiline'].includes(mode))throw Error('INVALID_SMOKE_MODE');
  const prompt=mode==='multiline'?MULTILINE_PROMPT:FIXED_PROMPT;
  const bridge = new ExistingBridgeClient({origin:'http://127.0.0.1:8799/bridge-'+keyFromFile()});
  let state;
  try { state = await health(); } catch {throw Error('WEB_HOST_OFFLINE');}
  const readiness=checkWebSmokeReadiness(state);
  if(readiness!=='READY') throw Error(readiness);
  report('Local Web Host and one explicitly armed ChatGPT tab are connected.');
  report('A single harmless test message will be sent into the selected ChatGPT conversation.');
  report('Real Weixin will NOT be accessed. Never use this on a private chat without checking the bound tab.');
  report('Test mode: '+mode+' (one message only).');
  report('Test prompt: '+prompt);
  const answer = await ask('To send this ONE browser message, type SEND TEST (anything else cancels): ');
  if (answer?.trim()!=='SEND TEST') { report('CANCELLED_NOT_SENT'); return 'CANCELLED'; }
  const before = checkWebSmokeReadiness(await health());
  if(before!=='READY') throw Error(before);
  const queued = await bridge.enqueue({text:prompt,idempotencyKey:'weixin:'+randomUUID()});
  report('TEST_ENQUEUED id='+queued.eventId+' (no automatic retries)');
  const deadline=now()+WAIT_MS;
  let last='';
  while(now()<deadline) {
    const event=await bridge.getEvent(queued.eventId);
    if(event.status!==last) {report('STATUS '+event.status);last=event.status;}
    const result=judgeWebSmokeReply(event.status,event.replyText);
    if(result==='PASS') {report('PASS: exact ChatGPT browser reply received.');return 'PASS';}
    if(result==='REPLY_MISMATCH') {
      report('REPLY_MISMATCH: browser returned an unexpected reply. No Weixin send.');
      report('Returned reply (up to 2000 chars): '+event.replyText);
      return 'REPLY_MISMATCH';
    }
    if(result==='DELIVERY_UNKNOWN'){
      const d=event.diagnostic;
      report('DELIVERY_UNKNOWN: stop and manually inspect the bound tab. Do NOT retry.');
      report('SAFE_DIAGNOSTIC stage='+(d?.stage||'UNKNOWN_STAGE')+' code='+(d?.code||'LEGACY_UNKNOWN'));
      return result;
    }
    await delay(INTERVAL_MS);
  }
  report('WAIT_TIMEOUT_UNKNOWN: the message could still be running. Do NOT retry automatically.');
  return 'WAIT_TIMEOUT_UNKNOWN';
}
if(process.argv[1] && resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url))) {
  const rl=readline.createInterface({input,output});
  try{
    const result=await runLiveWebSmoke({ask:prompt=>rl.question(prompt),mode:process.argv.includes('--multiline')?'multiline':'single'});
    process.exitCode=result==='PASS'||result==='CANCELLED'?0:1;
  }catch(err){console.error('SMOKE_NOT_COMPLETED '+(err?.message||'UNKNOWN'));process.exitCode=1;}
  finally{rl.close();}
}
