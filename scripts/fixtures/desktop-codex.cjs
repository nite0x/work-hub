// Deterministic CLI boundary fixture. Git, SQLite, HTTP and the desktop window
// remain real; this process never calls a model or modifies the user's Codex data.
const fs = require('node:fs');
const readline = require('node:readline');
const fixtureFile = process.argv[2];
const args = process.argv.slice(3);
const fixture = () => JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
const record = value => fs.appendFileSync(fixture().log, JSON.stringify(value) + '\n');
if (args[0] !== 'app-server') {
  record({ cli: args, cwd: process.cwd() });
  console.log('WORK_HUB_MACOS_TEST_CLI · isolated fixture, no model request');
  console.log('cwd: ' + process.cwd());
  process.exit(0);
}
if (args.length > 1) {
  console.error('Live daemon is not provided by this saved-history fixture.');
  process.exit(1);
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  record({ rpc: request.method });
  const data = fixture();
  const params = request.params || {};
  let result;
  switch (request.method) {
    case 'initialize': result = { userAgent: 'Work Hub isolated verification' }; break;
    case 'thread/list': {
      const directories = params.cwd || [];
      result = { data: data.sessions.filter(s => !directories.length || directories.includes(s.cwd)), nextCursor: null };
      break;
    }
    case 'thread/read': result = { thread: data.sessions.find(s => s.id === params.threadId) }; break;
    case 'thread/turns/list': result = { data: [{ id: 'fixture-turn', items: data.items }], nextCursor: null }; break;
    default:
      process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32601, message: 'Unsupported fixture method: ' + request.method } }) + '\n');
      return;
  }
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
});
