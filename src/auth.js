const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const ORIGIN = 'https://bkzhjx.wh.sdu.edu.cn';
const SESSION_FILE = path.join(__dirname, '..', 'session.local.json');

function validateSession(session) {
  if (!session || typeof session.cookie !== 'string' ||
      !/(?:^|;\s*)bzb_jsxsd=[^;\s]+/.test(session.cookie) || /[\r\n]/.test(session.cookie) ||
      typeof session.userAgent !== 'string' || /[\r\n]/.test(session.userAgent)) {
    throw new Error('缺少有效的本机会话。请在浏览器登录并进入选课轮次，再导入请求头。');
  }
}
function parseSessionHeaders(text) {
  const headers = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(:?[\w-]+):\s*(.*)$/);
    if (m) headers[m[1].toLowerCase()] = m[2];
  }
  let referer;
  try { referer = new URL(headers.referer); } catch { /* validated below */ }
  if ((headers[':authority'] || headers.host) !== new URL(ORIGIN).host ||
      referer?.origin !== ORIGIN || !referer.pathname.startsWith('/jsxsd/')) {
    throw new Error('请复制已登录教学平台中课程查询请求的 Copy request headers。');
  }
  const session = { cookie: headers.cookie, userAgent: headers['user-agent'] || '', importedAt: new Date().toISOString() };
  validateSession(session);
  return session;
}
function saveSession(session, file = SESSION_FILE) {
  validateSession(session);
  fs.writeFileSync(file, JSON.stringify(session, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
function loadSession(file = SESSION_FILE) {
  if (!fs.existsSync(file)) throw new Error('尚未导入会话：pbpaste | node index.js --import-session');
  const session = JSON.parse(fs.readFileSync(file, 'utf8'));
  validateSession(session);
  return session;
}
// Cookies stay on the fixed official HTTPS origin; redirects are never followed.
function createRequest(session, { fetchImpl = globalThis.fetch, signal, wait = sleep } = {}) {
  validateSession(session);
  let requested = false;
  const cookies = new Map(session.cookie.split(/;\s*/).map(part => {
    const i = part.indexOf('=');
    return [part.slice(0, i), part.slice(i + 1)];
  }));
  return async function request(route, { method = 'GET', body, referer = '/jsxsd/xsxkkc/getXxxk', beforeSend } = {}) {
    signal?.throwIfAborted();
    const url = new URL(route, ORIGIN), ref = new URL(referer, ORIGIN);
    if (url.origin !== ORIGIN || !url.pathname.startsWith('/jsxsd/') || ref.origin !== ORIGIN) {
      throw new Error('请求地址必须是官方教学平台。');
    }
    // All callers are serial; space requests inside a polling round as well.
    if (requested) await wait(5000, undefined, { signal });
    signal?.throwIfAborted();
    beforeSend?.();
    requested = true;
    let response, text;
    try {
      response = await fetchImpl(url, {
        method, body, redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
        headers: {
          Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
          'User-Agent': session.userAgent, Referer: ref.href, 'X-Requested-With': 'XMLHttpRequest',
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {})
        }
      });
      const bytes = await response.arrayBuffer();
      text = new TextDecoder().decode(bytes);
      // The platform's forced-logout script can be GBK despite its UTF-8 header.
      if (text.includes('\uFFFD') && /<script/i.test(text)) text = new TextDecoder('gb18030').decode(bytes);
    } catch {
      signal?.throwIfAborted();
      throw new Error('网络请求失败或超时；若发生在提交时，请先到官网核对结果。');
    }
    for (const cookie of response.headers.getSetCookie?.() || []) {
      const pair = cookie.split(';')[0], i = pair.indexOf('=');
      if (i > 0) cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    if (/频繁/.test(text) && /注销|登录|登陆/.test(text)) {
      throw new Error('平台提示访问频繁并注销了会话，已停止。请稍后在浏览器重新进入平台，再导入会话。');
    }
    if (response.status >= 300 && response.status < 400 || [401, 403].includes(response.status) ||
        /统一身份认证|\/cas\/(?:login|logout)|登录超时|请重新登录|请先登录系统/.test(text) || /"flag1"\s*:\s*2(?:\s*[,}])/.test(text)) {
      throw new Error('登录会话已失效，请在浏览器重新进入平台和轮次，再导入会话；必要时登录。');
    }
    if (!response.ok) throw new Error(`教学平台返回 HTTP ${response.status}，已停止。`);
    return text;
  };
}
module.exports = { ORIGIN, SESSION_FILE, parseSessionHeaders, saveSession, loadSession, createRequest };
