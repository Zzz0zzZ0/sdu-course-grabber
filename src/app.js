const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { CATEGORIES, matchCourse, assertOpen } = require('./courses');

function validateConfig(config) {
  if (!Array.isArray(config.course) || !config.course.length) throw new Error('请先在 config.local.js 中填写 course 列表。');
  const seen = new Set();
  for (const t of config.course) {
    if (!Object.hasOwn(CATEGORIES, t.category) || !/^[A-Za-z0-9]+$/.test(t.kch || '') || typeof t.kxh !== 'string' || !t.kxh.trim()) throw new Error('课程必须包含 category、kch、字符串课序号 kxh。');
    const key = t.kch + '/' + t.kxh;
    if (seen.has(key)) throw new Error('课程配置重复：' + key);
    seen.add(key);
  }
  if (!Number.isInteger(config.intervalMs) || config.intervalMs < 5000) throw new Error('intervalMs 必须是至少 5000 的整数。');
}
function acquireLock(file = path.join(__dirname, '..', 'run.local.lock')) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
      return () => fs.unlinkSync(file);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('运行锁内容异常，请检查 run.local.lock。');
      try { process.kill(pid, 0); } catch (err) {
        if (err.code === 'ESRCH') { fs.unlinkSync(file); continue; }
        throw err;
      }
      throw new Error('已有脚本正在运行，请先停止该进程。');
    }
  }
  throw new Error('无法取得运行锁。');
}
async function run(config, client, { mode = 'query', signal, log = console.log, wait = sleep } = {}) {
  validateConfig(config);
  if (!['query', 'watch', 'run'].includes(mode)) throw new Error('未知运行模式。');
  let round = await client.prepare(config.roundId, config.course.map(t => t.category));
  log(`轮次：${round.name}；截止：${new Date(round.end).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`);
  const pending = [...config.course];
  let recover = false;
  do {
    if (signal?.aborted) return;
    if (mode !== 'query') assertOpen(round);
    if (recover) {
      round = await client.prepare(config.roundId, pending.map(t => t.category));
      assertOpen(round);
      recover = false;
    }
    const enrolled = await client.enrolled();
    for (const target of [...pending]) {
      if (signal?.aborted) return;
      if (enrolled.has(target.kch + '/' + target.kxh)) {
        log(`${target.name || target.kch} | ${target.kch}/${target.kxh} | 已选，无需重复提交`);
        pending.splice(pending.indexOf(target), 1); continue;
      }
      try {
        const row = matchCourse(await client.query(target.category, target.kch), target);
        if (signal?.aborted) return;
        const already = enrolled.has(row.jx0404id);
        log(`${row.kcmc} | ${target.kch}/${target.kxh} | 余量 ${row.syrs} | ${already ? '已选' : row.ctsm ? '冲突：' + row.ctsm : '未选'}`);
        if (already) { pending.splice(pending.indexOf(target), 1); continue; }
        if (mode === 'run' && row.syrs > 0) {
          const result = await client.select(target, row.jx0404id);
          log(`${row.kcmc}：${{ selected: '选课成功，已在选课结果中确认', already: '已选，无需重复提交', full: '余量已变化，继续等待' }[result.status]}`);
          if (result.textbookRequired) log('请到官网完成教材选择。');
          if (result.status !== 'full') pending.splice(pending.indexOf(target), 1);
        }
      } catch (e) {
        if (e.code !== 'COURSE_NOT_FOUND' || mode === 'query') throw e;
        if (signal?.aborted) return;
        if ((await client.enrolled()).has(target.kch + '/' + target.kxh)) {
          log(`${new Date().toISOString()} | ${target.kch}/${target.kxh} | 已选，无需重复提交`);
          pending.splice(pending.indexOf(target), 1);
        } else {
          log(`${new Date().toISOString()} | ${e.message} 等待至少 60 秒后重新进入轮次复查；请核对课程配置。`);
          recover = true;
        }
      }
    }
    if (mode === 'query' || !pending.length) return;
    const delay = Math.min(recover ? Math.max(60000, config.intervalMs) : config.intervalMs, round.end - Date.now());
    if (delay <= 0) throw new Error('选课轮次已结束。');
    await wait(delay, undefined, { signal });
  } while (true);
}
module.exports = { run, validateConfig, acquireLock };
