// Runs before `npm run test:govern`: checks the one thing every test needs — a
// reachable, disposable Postgres — and fails with ONE clear line instead of
// letting every test file fail with a wall of stack traces.
import pg from "pg";

const url = process.env.GOVERN_TEST_DATABASE_URL;
const example = "postgres://spendveto:spendveto_dev@127.0.0.1:5434/spendveto_test";

function fail(msg) {
  console.error(`\n  ✖ test:govern cannot start — ${msg}\n`);
  process.exit(1);
}

if (!url) {
  fail(`GOVERN_TEST_DATABASE_URL is not set.\n\n    PowerShell:  $env:GOVERN_TEST_DATABASE_URL = '${example}'\n    bash:        export GOVERN_TEST_DATABASE_URL=${example}\n`);
}
let name;
try {
  name = new URL(url).pathname.slice(1);
} catch {
  fail(`GOVERN_TEST_DATABASE_URL is not a valid URL: ${url}`);
}
if (!/test/i.test(name)) {
  fail(`database "${name}" does not look disposable — the suite drops and recreates its tables, so the name must contain "test".`);
}
const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 4000 });
try {
  await client.connect();
  await client.query("SELECT 1");
} catch (err) {
  fail(`cannot reach the test database (${err.code || err.message}).\n    Is the container running?  docker start spendveto-pg`);
} finally {
  await client.end().catch(() => {});
}
