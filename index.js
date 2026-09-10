const fs = require('node:fs');
const path = require('node:path');
const { parseSessionHeaders, saveSession, loadSession, createRequest } = require('./src/auth');
const { createClient } = require('./src/courses');
const { run, acquireLock } = require('./src/app');

async function main(args = process.argv.slice(2)) {
  const command = args[0] || '--query';
  if (args.length > 1 || !['--help', '--import-session', '--check-session', '--query', '--watch', '--run'].includes(command)) throw new Error('参数错误。使用 node index.js --help 查看用法。');
  if (command === '--help') {
    console.log('默认只查询，不提交选课。\n  node index.js                  查询目标课程\n  node index.js --watch          持续查询，不提交\n  node index.js --run            有余量时自动提交配置的课程\n  node test-login.js             仅检查会话与选课轮次\n  pbpaste | node index.js --import-session  导入浏览器 Copy request headers\nCtrl+C 停止。课程、轮次、间隔配置在 config.local.js。');
    return;
  }
  if (command === '--import-session') {
    saveSession(parseSessionHeaders(fs.readFileSync(0, 'utf8')));
    console.log('会话已保存至 session.local.json（仅当前用户可读，已排除 Git）。'); return;
  }
  const configFile = path.join(__dirname, 'config.local.js');
  if (!fs.existsSync(configFile)) throw new Error('请先复制 config.local.example.js 为 config.local.js 并配置课程。');
  const config = require(configFile), controller = new AbortController();
  const client = createClient(createRequest(loadSession(), { signal: controller.signal }));
  const release = acquireLock();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (command === '--check-session') {
      const round = await client.prepare(config.roundId, ['xxxk']);
      console.log(`登录会话有效：${round.name}。未执行选课提交。`);
    } else await run(config, client, { mode: command.slice(2), signal: controller.signal });
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
    console.log('已停止。');
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); release();
  }
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { main };
