// Importing this entrypoint never starts the course submission workflow.
const { main } = require('./index');
if (require.main === module) main(['--check-session']).catch(e => { console.error(e.message); process.exitCode = 1; });
