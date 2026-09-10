const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { ORIGIN, parseSessionHeaders, saveSession, createRequest } = require('../src/auth');
const { createClient, parsePage, parseRound, assertOpen, matchCourse, parseRules } = require('../src/courses');
const { run, validateConfig, acquireLock } = require('../src/app');

const target = { category: 'xxxk', kch: 'TEST100', kxh: '100', name: '测试课程' };
const course = { kch: 'TEST100', kcmc: '测试课程', kxhnew: '100', jx0404id: 'CLASS1', jx02id: 'TEST100', cfbs: null, syrs: '1', xqid: '07', ctsm: '' };
const config = { roundId: 'ROUND1', intervalMs: 10000, course: [target] };
const roundHtml = '<span>选课名称：测试轮次</span><span>选课时间：2000-01-01 00:00 ~ 2099-01-01 00:00</span><span>每天开始时间段：00:00~23:59</span>';
const rulesHtml = '<input id="sfyzmxk" value="0"><script>var qycqxk = "0"; if(\'07\' != xqid) {} </script>/jsxsd/xsxkkc/xsxkXxxk';
const response = rows => JSON.stringify({ aaData: rows, iTotalRecords: rows.length, iTotalDisplayRecords: rows.length, sEcho: '1' });
const selectedHtml = selected => '<th>课程编号</th><th>选课状态</th>' + (selected ? '<tr><td>TEST100</td><td>测试课程</td><td></td><td>100</td><td><div id="div_CLASS1"></div></td></tr>' : '');
function fakePlatform({ row = course, rules = rulesHtml, selected = false, submit = { success: true, message: '选课成功' }, confirm = true, queryRows } = {}) {
  const calls = [];
  const request = async (route, options = {}) => {
    calls.push({ route, options });
    if (route.includes('/xklc_list')) return 'onclick="jrxk(\'1\',\'ROUND1\',\'0\')"';
    if (route.includes('/mzlist.do')) return '{"success":true,"istc":false}';
    if (route.includes('/newXsxkzx')) return '<iframe id="selectBottom">';
    if (route.includes('/selectNum')) return roundHtml;
    if (route.endsWith('/getXxxk')) return rules;
    if (route.includes('/xsxkXxxk?')) return response(queryRows ? queryRows() : [row]);
    if (route.includes('/comeXkjglb')) return selectedHtml(selected);
    if (route.includes('/xxxkOper?')) {
      if (submit instanceof Error) throw submit;
      selected = confirm && submit.success === true;
      return JSON.stringify(submit);
    }
    throw new Error('Unexpected route: ' + route);
  };
  return { client: createClient(request), calls };
}
const writes = p => p.calls.filter(c => c.route.includes('/xxxkOper?'));

test('only official captured headers are imported; session permissions are private', () => {
  const h = `Host: bkzhjx.wh.sdu.edu.cn\nReferer: ${ORIGIN}/jsxsd/xsxkkc/getXxxk\nCookie: bzb_jsxsd=TEST; SERVERID=TEST\nUser-Agent: TestBrowser`;
  const session = parseSessionHeaders(h);
  assert.equal(session.cookie, 'bzb_jsxsd=TEST; SERVERID=TEST');
  assert.throws(() => parseSessionHeaders(h.replace('Host: bkzhjx.wh.sdu.edu.cn', 'Host: other.example')), /请求头|headers/);
  assert.throws(() => parseSessionHeaders(h.replace('bzb_jsxsd', 'irrelevant')), /会话/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdu-session-test-'));
  try { const f = path.join(dir, 'session.json'); saveSession(session, f); assert.equal(fs.statSync(f).mode & 0o777, 0o600); }
  finally { fs.rmSync(dir, { recursive: true }); }
});

test('transport never forwards cookies across origins or redirects; expiry JSON is recognized', async () => {
  let count = 0;
  const request = createRequest({ cookie: 'bzb_jsxsd=TEST', userAgent: 'test' }, { fetchImpl: async (url, options) => {
    count++; assert.equal(url.origin, ORIGIN); assert.equal(options.redirect, 'manual');
    return new Response('{"flag1":2,"msgContent":"expired"}');
  } });
  await assert.rejects(request('https://other.example/jsxsd/'), /官方/);
  assert.equal(count, 0);
  await assert.rejects(request('/jsxsd/xsxk/xklc_list'), /失效/);
  const redirect = createRequest({ cookie: 'bzb_jsxsd=TEST', userAgent: '' }, { fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://other.example/' } }) });
  await assert.rejects(redirect('/jsxsd/'), /失效/);
});

test('cancelled transport does not dispatch and network errors do not reveal credentials', async () => {
  const controller = new AbortController(); controller.abort();
  const request = createRequest({ cookie: 'bzb_jsxsd=SECRET', userAgent: '' }, { signal: controller.signal, fetchImpl: () => assert.fail('must not dispatch') });
  await assert.rejects(request('/jsxsd/'), { name: 'AbortError' });
  const broken = createRequest({ cookie: 'bzb_jsxsd=SECRET', userAgent: '' }, { fetchImpl: () => { throw new Error('SECRET'); } });
  await assert.rejects(broken('/jsxsd/'), e => !e.message.includes('SECRET'));
});

test('new schema, exact course section and required capacity are checked', () => {
  assert.equal(parsePage(response([course])).total, 1);
  assert.equal(matchCourse([course], target).syrs, 1);
  assert.throws(() => parsePage('{"object":{"resultList":[]}}'), /结构/);
  assert.throws(() => matchCourse([course, course], target), /2 个/);
  assert.throws(() => matchCourse([{ ...course, kxhnew: '101' }], target), { code: 'COURSE_NOT_FOUND' });
  assert.throws(() => matchCourse([{ ...course, syrs: null }], target), /余量/);
  assert.deepEqual(parseRules(rulesHtml), { captcha: false, lottery: false, campus: '07' });
});

test('pagination uses offsets and preserves the double-encoded search term', async () => {
  const offsets = [];
  const client = createClient(async (route, { body, method }) => {
    assert.equal(method, 'POST');
    assert.equal(new URL(route, ORIGIN).searchParams.get('kcxx'), encodeURIComponent('测试'));
    const offset = Number(body.get('iDisplayStart')); offsets.push(offset);
    return JSON.stringify({ aaData: Array.from({ length: offset ? 1 : 10 }, (_, i) => ({ ...course, jx0404id: 'ID' + (offset + i) })), iTotalDisplayRecords: 11 });
  });
  assert.equal((await client.query('xxxk', '测试')).length, 11);
  assert.deepEqual(offsets, [0, 10]);
  await assert.rejects(createClient(async () => JSON.stringify({ aaData: [course], iTotalDisplayRecords: 20 })).query('xxxk'), /重复/);
});

test('default query mode never submits, even when seats exist', async () => {
  const p = fakePlatform(); await run(config, p.client, { log() {} });
  assert.equal(writes(p).length, 0);
});

test('submission matches official GET parameters and confirms enrollment', async () => {
  const p = fakePlatform(); await p.client.prepare('ROUND1', ['xxxk']);
  const result = await p.client.select(target, 'CLASS1');
  assert.equal(result.status, 'selected'); assert.equal(writes(p).length, 1);
  const call = writes(p)[0], url = new URL(call.route, ORIGIN);
  assert.equal(call.options.method || 'GET', 'GET');
  assert.equal(url.searchParams.get('jx0404id'), 'CLASS1');
  assert.equal(url.searchParams.get('kcid'), 'TEST100');
  assert.equal(url.searchParams.get('cfbs'), 'null');
  assert.equal(url.searchParams.get('xkzy'), '');
});

test('already enrolled or newly full courses are not submitted', async () => {
  for (const options of [{ selected: true }, { row: { ...course, syrs: '0' } }]) {
    const p = fakePlatform(options); await p.client.prepare('ROUND1', ['xxxk']);
    assert.ok(['already', 'full'].includes((await p.client.select(target, 'CLASS1')).status));
    assert.equal(writes(p).length, 0);
  }
});

test('captcha, lottery, changed class, campus, conflict and split classes stop before writing', async () => {
  for (const options of [
    { rules: rulesHtml.replace('value="0"', 'value="1"') },
    { rules: rulesHtml.replace('qycqxk = "0"', 'qycqxk = "1"') },
    { row: { ...course, jx0404id: 'CHANGED' } },
    { row: { ...course, xqid: '01' } },
    { row: { ...course, ctsm: '时间冲突' } },
    { row: { ...course, cfbs: 'split' } }
  ]) {
    const p = fakePlatform(options); await p.client.prepare('ROUND1', ['xxxk']);
    await assert.rejects(p.client.select(target, 'CLASS1')); assert.equal(writes(p).length, 0);
  }
});

test('uncertain, rejected, partial and unconfirmed submissions are not retried', async () => {
  for (const options of [
    { submit: new Error('timeout') }, { submit: { success: false, message: '课容量已满' } },
    { submit: { success: true, message: '还有关联班级' } }, { confirm: false }
  ]) {
    const p = fakePlatform(options); await p.client.prepare('ROUND1', ['xxxk']);
    await assert.rejects(p.client.select(target, 'CLASS1')); assert.equal(writes(p).length, 1);
  }
});

test('watch mode uses the configured interval and never submits', async () => {
  const p = fakePlatform(), controller = new AbortController();
  await run(config, p.client, { mode: 'watch', signal: controller.signal, log() {}, wait: async ms => { assert.equal(ms, 10000); controller.abort(); } });
  assert.equal(writes(p).length, 0);
});

test('cancellation after a query stops before select and multiple targets are retained', async () => {
  const controller = new AbortController();
  const client = { prepare: async () => parseRound(roundHtml), enrolled: async () => new Set(), query: async () => { controller.abort(); return [course]; }, select: () => assert.fail('must not select') };
  await run(config, client, { mode: 'run', signal: controller.signal, log() {} });
  assert.equal(config.course.length, 1);
});

test('batch end time is exclusive and invalid settings are rejected', () => {
  const round = parseRound(roundHtml); assert.throws(() => assertOpen(round, round.end), /开放时间/);
  assert.throws(() => validateConfig({ ...config, intervalMs: 100 }), /5000/);
  assert.throws(() => validateConfig({ ...config, course: [target, target] }), /重复/);
});

test('login entry always dispatches check-session with configured courses; imports are inert', () => {
  const calls = [], m = { exports: {} };
  const requireStub = () => ({ main: async args => { calls.push(args); } }); requireStub.main = m;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'test-login.js'), 'utf8'), { require: requireStub, module: m, console, process });
  assert.equal(JSON.stringify(calls), '[["--check-session"]]');
  const previous = globalThis.fetch; globalThis.fetch = () => assert.fail('import performed a network request');
  try { require('../index'); require('../test-login'); } finally { globalThis.fetch = previous; }
});

test('a second process instance is blocked and lock is released', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdu-lock-test-')), file = path.join(dir, 'lock');
  try { const release = acquireLock(file); assert.throws(() => acquireLock(file), /已有脚本/); release(); assert.equal(fs.existsSync(file), false); }
  finally { fs.rmSync(dir, { recursive: true }); }
});

test('transport spaces every request and reports the platform forced logout without retrying', async () => {
  const events = [];
  const request = createRequest({ cookie: 'bzb_jsxsd=TEST', userAgent: '' }, {
    wait: async ms => events.push(['wait', ms]),
    fetchImpl: async () => {
      events.push(['request']);
      return events.filter(x => x[0] === 'request').length === 1 ? new Response('{}') :
        new Response(Buffer.from('3c7363726970743e616c6572742827b7c3cecacfb5cdb3b9fdd3dac6b5b7b1a3acd2d1b1bbd7a2cffab5c7c2bc27293b746f702e6c6f636174696f6e2e687265663d2768747470733a2f2f706173732e7364752e6564752e636e2f6361732f6c6f676f7574273c2f7363726970743e', 'hex'));
    }
  });
  await request('/jsxsd/xsxkkc/xsxkXxxk');
  await assert.rejects(request('/jsxsd/xsxkkc/xsxkXxxk'), /访问频繁/);
  assert.deepEqual(events, [['request'], ['wait', 5000], ['request']]);
});


test('deadline is checked after request spacing, before dispatch', async () => {
  let expired = false, calls = 0;
  const request = createRequest({ cookie: 'bzb_jsxsd=TEST', userAgent: '' }, {
    wait: async () => { expired = true; },
    fetchImpl: async () => { calls++; return new Response('{}'); }
  });
  await request('/jsxsd/xsxkkc/xsxkXxxk');
  await assert.rejects(request('/jsxsd/xsxkkc/xxxkOper', { beforeSend: () => {
    if (expired) throw new Error('轮次已结束');
  } }), /轮次已结束/);
  assert.equal(calls, 1);
});


test('missing courses back off, re-enter the round and recover without duplicate submission', async () => {
  for (const missingQuery of [1, 2]) {
    let queries = 0;
    const p = fakePlatform({ queryRows: () => ++queries === missingQuery ? [] : [course] });
    const delays = [], logs = [];
    await run(config, p.client, { mode: 'run', log: s => logs.push(s), wait: async ms => delays.push(ms) });
    assert.deepEqual(delays, [60000]);
    assert.equal(p.calls.filter(c => c.route.includes('/newXsxkzx')).length, 2);
    assert.equal(writes(p).length, 1);
    assert.ok(logs.some(s => s.includes('本次返回 0 条课程')));
  }
});

test('missing course already enrolled elsewhere completes without retry or submission', async () => {
  const p = fakePlatform({ queryRows: () => [] });
  let reads = 0;
  p.client.enrolled = async () => ++reads === 1 ? new Set() : new Set(['TEST100/100']);
  await run(config, p.client, { mode: 'run', log() {}, wait: () => assert.fail('must not retry') });
  assert.equal(reads, 2);
  assert.equal(writes(p).length, 0);
});

test('single query, ambiguous match and uncertain submission remain fatal without retry', async () => {
  for (const [mode, options, expected] of [
    ['query', { queryRows: () => [] }, /暂未找到/],
    ['run', { queryRows: () => [course, { ...course, jx0404id: 'CLASS2' }] }, /2 个/],
    ['run', { submit: new Error('timeout') }, /提交结果不确定/]
  ]) {
    const p = fakePlatform(options);
    await assert.rejects(run(config, p.client, { mode, log() {}, wait: () => assert.fail('must not retry') }), expected);
    assert.equal(writes(p).length, options.submit ? 1 : 0);
  }
});

test('missing course recovery honors cancellation and preserves watch-only behavior', async () => {
  const controller = new AbortController(), p = fakePlatform({ queryRows: () => [] });
  await run(config, p.client, { mode: 'watch', signal: controller.signal, log() {}, wait: async ms => {
    assert.equal(ms, 60000); controller.abort();
  } });
  assert.equal(writes(p).length, 0);
  assert.equal(p.calls.filter(c => c.route.includes('/newXsxkzx')).length, 1);
});

test('repeated missing results keep monitoring; recovery stops at the round deadline', async () => {
  const realNow = Date.now;
  let now = realNow(), queries = 0, prepares = 0;
  const round = { ...parseRound(roundHtml), end: now + 90000 };
  Date.now = () => now;
  try {
    const client = { prepare: async () => { prepares++; return round; }, enrolled: async () => new Set(),
      query: async () => { queries++; return []; }, select: () => assert.fail('must not submit') };
    const delays = [];
    await assert.rejects(run(config, client, { mode: 'run', log() {}, wait: async ms => { delays.push(ms); now += ms; } }), /开放时间/);
    assert.deepEqual(delays, [60000, 30000]);
    assert.equal(queries, 2); assert.equal(prepares, 2);
  } finally { Date.now = realNow; }
});
