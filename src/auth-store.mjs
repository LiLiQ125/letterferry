import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const REQUIRED = ['botToken', 'accountId', 'scannerUserId', 'baseUrl'];
const DPAPI_SCRIPT = String.raw`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $mode=$env:RIVEN_WEIXIN_DPAPI_MODE; $inputText=[Console]::In.ReadToEnd(); if($mode -eq 'protect'){ $plain=[Convert]::FromBase64String($inputText); $sealed=[Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($sealed)) } elseif($mode -eq 'unprotect'){ $sealed=[Convert]::FromBase64String($inputText); $plain=[Security.Cryptography.ProtectedData]::Unprotect($sealed,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($plain)) } else { throw 'invalid mode' }`;

function runDpapi(mode, input) {
  if (process.platform !== 'win32') return Promise.reject(new Error('DPAPI_WINDOWS_REQUIRED'));
  return new Promise((resolvePromise, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, RIVEN_WEIXIN_DPAPI_MODE: mode },
    });
    const stdout = [];
    let stderrBytes = 0;
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; });
    child.on('error', () => reject(new Error('DPAPI_PROCESS_FAILED')));
    child.on('close', (code) => {
      if (code !== 0 || stderrBytes || Buffer.concat(stdout).length > 4 * 1024 * 1024) return reject(new Error('DPAPI_OPERATION_FAILED'));
      resolvePromise(Buffer.from(Buffer.concat(stdout).toString('utf8').trim(), 'base64'));
    });
    child.stdin.end(Buffer.from(input).toString('base64'));
  });
}

function envKeyProtector(rawKey) {
  if (!/^[a-f0-9]{64}$/i.test(rawKey || '')) throw new Error('RIVEN_WEIXIN_AUTH_KEY_REQUIRED_64_HEX');
  const key = Buffer.from(rawKey, 'hex');
  return {
    protect: async (plain) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
      return Buffer.concat([Buffer.from('RWBA1'), iv, cipher.getAuthTag(), ciphertext]);
    },
    unprotect: async (sealed) => {
      if (sealed.length < 34 || sealed.subarray(0, 5).toString() !== 'RWBA1') throw new Error('INVALID_AUTH_FILE');
      const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(5, 17));
      decipher.setAuthTag(sealed.subarray(17, 33));
      return Buffer.concat([decipher.update(sealed.subarray(33)), decipher.final()]);
    },
  };
}

function validateAuth(auth) {
  if (!auth || typeof auth !== 'object' || REQUIRED.some((key) => typeof auth[key] !== 'string' || !auth[key])) throw new Error('INVALID_AUTH_RECORD');
  if (typeof auth.cursor !== 'string') throw new Error('INVALID_AUTH_CURSOR');
  return auth;
}

export class ProtectedAuthStore {
  constructor(filename = resolve('data/weixin-auth.protected'), protector = null, env = process.env) {
    this.filename = filename;
    const selected = protector || (env.RIVEN_WEIXIN_AUTH_KEY
      ? envKeyProtector(env.RIVEN_WEIXIN_AUTH_KEY)
      : { protect: (data) => runDpapi('protect', data), unprotect: (data) => runDpapi('unprotect', data) });
    this.protect = selected.protect;
    this.unprotect = selected.unprotect;
  }

  exists() {
    try { return statSync(this.filename).isFile(); } catch { return false; }
  }

  async create(auth) {
    validateAuth(auth);
    if (this.exists()) throw new Error('AUTH_ALREADY_EXISTS');
    const sealed = await this.protect(Buffer.from(JSON.stringify(auth), 'utf8'));
    if (!Buffer.isBuffer(sealed) || !sealed.length) throw new Error('AUTH_PROTECTION_FAILED');
    mkdirSync(dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    writeFileSync(temporary, sealed, { mode: 0o600, flag: 'wx' });
    try { linkSync(temporary, this.filename); }
    catch (error) { throw new Error(`AUTH_COMMIT_FAILED:${error.code || 'UNKNOWN'}`); }
    try { unlinkSync(temporary); } catch {}
    try { chmodSync(this.filename, 0o600); } catch {}
  }

  async load() {
    if (!this.exists()) throw new Error('AUTH_NOT_FOUND');
    const sealed = readFileSync(this.filename);
    if (!sealed.length || sealed.length > 4 * 1024 * 1024) throw new Error('INVALID_AUTH_FILE');
    const plain = await this.unprotect(sealed);
    let parsed;
    try { parsed = JSON.parse(Buffer.from(plain).toString('utf8')); } catch { throw new Error('INVALID_AUTH_RECORD'); }
    return validateAuth(parsed);
  }

  async updateCursor(cursor) {
    if (typeof cursor !== 'string' || !cursor) throw new Error('INVALID_AUTH_CURSOR');
    const auth = await this.load();
    const sealed = await this.protect(Buffer.from(JSON.stringify({ ...auth, cursor }), 'utf8'));
    if (!Buffer.isBuffer(sealed) || !sealed.length) throw new Error('AUTH_PROTECTION_FAILED');
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    writeFileSync(temporary, sealed, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, this.filename);
    try { chmodSync(this.filename, 0o600); } catch {}
  }
}
