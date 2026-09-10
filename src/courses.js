const CATEGORIES = {
  xxxk: { label: '限选', page: 'getXxxk', query: 'xsxkXxxk', submit: 'xxxkOper',
    columns: ['kch', 'kcmc', 'kxhnew', 'dwmc', 'jkfs', 'xmmc', 'fzmc', 'ktmc', 'xf', 'skls', 'sksj', 'skdd', 'xqmc', 'syrs', 'ctsm', 'czOper'] },
  ggxxk: { label: '任选', page: 'getGgxxk', query: 'xsxkGgxxkxk', submit: 'ggxxkxkOper',
    columns: ['kch', 'kcmc', 'kxhnew', 'dwmc', 'jkfs', 'xmmc', 'xf', 'skls', 'sksj', 'skdd', 'xqmc', 'xkrs', 'syrs', 'ctsm', 'szkcflmc', 'czOper'] }
};
const BASE = '/jsxsd/xsxkkc/';
const clean = value => String(value ?? '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
function json(text) {
  try { return JSON.parse(text); } catch { throw new Error('平台响应不是有效 JSON，可能需要重新登录。'); }
}
function category(name) {
  if (!Object.hasOwn(CATEGORIES, name)) throw new Error('目前已适配限选 xxxk 和任选 ggxxk。');
  return CATEGORIES[name];
}
function parseRules(html) {
  const captcha = html.match(/<input\b[^>]*id=["']sfyzmxk["'][^>]*value=["']([^"']*)/i)?.[1];
  const lottery = html.match(/var\s+qycqxk\s*=\s*["']([^"']*)/)?.[1];
  const campus = html.match(/if\(\s*['"]([^'"]+)['"]\s*!=\s*xqid\s*\)/)?.[1];
  if (captcha === undefined || lottery === undefined || !campus) throw new Error('无法识别当前选课规则，已停止。');
  return { captcha: captcha !== '0', lottery: lottery !== '0', campus };
}
function parseRound(html) {
  const range = html.match(/选课时间：\s*(\d{4}-\d\d-\d\d \d\d:\d\d)\s*~\s*(\d{4}-\d\d-\d\d \d\d:\d\d)/);
  const daily = html.match(/每天开始时间段：\s*(\d\d:\d\d)\s*~\s*(\d\d:\d\d)/);
  const name = clean(html.match(/选课名称：([^<]+)/)?.[1]);
  if (!range || !daily || !name) throw new Error('无法确认选课轮次和开放时间，请先在浏览器进入当前轮次。');
  const round = { name, start: Date.parse(range[1].replace(' ', 'T') + ':00+08:00'),
    end: Date.parse(range[2].replace(' ', 'T') + ':00+08:00'), dailyStart: daily[1], dailyEnd: daily[2] };
  if (!Number.isFinite(round.start) || !Number.isFinite(round.end) || round.end <= round.start) throw new Error('选课时间格式异常。');
  return round;
}
function assertOpen(round, now = Date.now()) {
  const local = new Date(now + 8 * 3600000).toISOString().slice(11, 16);
  const dailyOpen = round.dailyStart <= round.dailyEnd ? local >= round.dailyStart && local <= round.dailyEnd : local >= round.dailyStart || local <= round.dailyEnd;
  if (now < round.start || now >= round.end || !dailyOpen) throw new Error('当前不在该轮次的开放时间内，已停止。');
}
function parsePage(text) {
  const data = json(text), total = Number(data.iTotalDisplayRecords);
  if (!Array.isArray(data.aaData) || !Number.isInteger(total) || total < 0 || data.iTotalDisplayRecords == null) throw new Error('课程数据结构发生变化，已停止。');
  return { rows: data.aaData, total };
}
function matchCourse(rows, target) {
  const found = rows.filter(r => clean(r.kch) === target.kch && clean(r.kxhnew) === target.kxh);
  if (!found.length) {
    const error = new Error(`${target.kch}/${target.kxh} 暂未找到目标教学班（本次返回 ${rows.length} 条课程）。`);
    error.code = 'COURSE_NOT_FOUND';
    throw error;
  }
  if (found.length !== 1) throw new Error(`${target.kch}/${target.kxh} 匹配到 ${found.length} 个教学班，请核对课程配置。`);
  const r = found[0];
  if (!r.jx0404id || !r.jx02id || !r.xqid || !/^\d+$/.test(clean(r.syrs))) throw new Error('教学班标识或余量字段不完整。');
  if (target.name && clean(r.kcmc) !== target.name) throw new Error('课程名称与配置不符，已停止。');
  return { ...r, kcmc: clean(r.kcmc), syrs: Number(r.syrs), ctsm: clean(r.ctsm) };
}
function createClient(request) {
  let round;
  async function prepare(roundId, categories) {
    if (!/^[A-Za-z0-9]+$/.test(roundId || '')) throw new Error('请在 config.local.js 填写当前选课轮次 roundId。');
    const rounds = await request('/jsxsd/xsxk/xklc_list?Ves632DSdyV=NEW_XSD_PYGL');
    const ids = [...rounds.matchAll(/jrxk\(['"]1['"],['"]([A-Za-z0-9]+)['"]/g)].map(m => m[1]);
    if (!ids.includes(roundId)) throw new Error('配置的选课轮次不在当前账号可用列表中。');
    const notice = json(await request('/jsxsd/xsxk/mzlist.do', { method: 'POST' }));
    if (notice.istc) throw new Error('平台要求阅读确认选课说明，请先在浏览器完成，再重新导入会话。');
    if (typeof notice.success !== 'boolean') throw new Error('无法确认选课说明状态，已停止。');
    const main = await request('/jsxsd/xsxk/newXsxkzx?jx0502zbid=' + roundId);
    if (!main.includes('selectBottom')) throw new Error('未能进入选课轮次，请重新登录。');
    round = parseRound(await request('/jsxsd/xsxk/selectNum?jx0502zbid=' + roundId));
    for (const name of new Set(categories)) await refreshRules(name);
    return round;
  }
  async function refreshRules(name) {
    const c = category(name), html = await request(BASE + c.page);
    if (!html.includes(BASE + c.query)) throw new Error('课程页面与预期接口不符。');
    return parseRules(html);
  }
  async function query(name, search = '') {
    const c = category(name);
    const params = new URLSearchParams({ kcxx: encodeURIComponent(search), skls: '', skfs: '', xqid: '' });
    if (name === 'ggxxk') Object.entries({ skxq: '', skjc: '', sfym: 'false', sfct: 'false', szjylb: '', sfxx: 'false' }).forEach(([k, v]) => params.set(k, v));
    const rows = [], seen = new Set();
    for (let offset = 0; offset < 10000; offset += 10) {
      const body = new URLSearchParams({ sEcho: String(offset / 10 + 1), iColumns: String(c.columns.length), sColumns: '', iDisplayStart: String(offset), iDisplayLength: '10' });
      c.columns.forEach((key, i) => body.set('mDataProp_' + i, key));
      const data = parsePage(await request(BASE + c.query + '?' + params, { method: 'POST', body, referer: BASE + c.page }));
      for (const row of data.rows) {
        if (seen.has(row.jx0404id)) throw new Error('课程分页出现重复教学班，请稍后重试。');
        seen.add(row.jx0404id); rows.push(row);
      }
      if (offset + data.rows.length >= data.total) return rows;
      if (!data.rows.length) throw new Error('课程分页提前结束，无法确认完整结果。');
    }
    throw new Error('查询结果超过分页上限，请缩小查询范围。');
  }
  async function enrolled() {
    const html = await request('/jsxsd/xsxkjg/comeXkjglb?isktx=true');
    if (!html.includes('课程编号') || !html.includes('选课状态')) throw new Error('无法核对已选课程，请到官网检查。');
    const selected = new Set();
    for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => clean(m[1]));
      if (!cells.length) continue;
      const id = row[1].match(/id=["']div_([A-Za-z0-9]+)["']/)?.[1];
      if (!id || !/^[A-Za-z0-9]+$/.test(cells[0]) || !cells[3]) throw new Error('已选课程表结构发生变化，请到官网核对。');
      selected.add(id); selected.add(cells[0] + '/' + cells[3]);
    }
    return selected;
  }
  async function select(target, expectedId) {
    if (!round) throw new Error('尚未确认当前选课轮次。');
    assertOpen(round);
    const rule = await refreshRules(target.category);
    if (rule.captcha || rule.lottery) throw new Error('当前课程需要验证码或抽签／积分操作，请在官网完成。');
    if ((await enrolled()).has(target.kch + '/' + target.kxh)) return { status: 'already' };
    const row = matchCourse(await query(target.category, target.kch), target);
    if (row.jx0404id !== expectedId) throw new Error('教学班发生变化，请重新查询确认。');
    if ((await enrolled()).has(row.jx0404id)) return { status: 'already', row };
    if (row.xqid !== rule.campus) throw new Error('教学班校区与当前账号校区不同，请到官网确认。');
    if (row.ctsm) throw new Error(`${row.kcmc} 存在时间冲突：${row.ctsm}`);
    if (row.syrs <= 0) return { status: 'full', row };
    if (row.cfbs != null && String(row.cfbs) !== '' && String(row.cfbs) !== 'null') throw new Error('该课程包含分组／拆分班级，请到官网完成选择。');
    assertOpen(round);
    const c = category(target.category);
    // The official jQuery call omits type, so this write endpoint uses GET.
    const params = new URLSearchParams({ kcid: String(row.jx02id), cfbs: String(row.cfbs), jx0404id: String(row.jx0404id), xkzy: '', trjf: '' });
    let result;
    try { result = json(await request(BASE + c.submit + '?' + params, { referer: BASE + c.page, beforeSend: () => assertOpen(round) })); }
    catch (e) { throw new Error(`提交结果不确定，已停止且不自动重试。请到官网核对：${e.message}`); }
    if (result.success !== true) throw new Error('选课未成功，已停止：' + clean(result.message || '无法识别提交结果'));
    if (String(result.message).includes('还有')) throw new Error('选课尚需完成关联班级选择，请立即到官网处理。');
    if (!(await enrolled()).has(row.jx0404id)) throw new Error('平台报告成功，但已选列表尚未确认；已停止，请到官网核对。');
    return { status: 'selected', row, textbookRequired: Boolean(result.sfydjc) };
  }
  return { prepare, query, enrolled, select };
}
module.exports = { CATEGORIES, clean, parseRules, parseRound, assertOpen, parsePage, matchCourse, createClient };
