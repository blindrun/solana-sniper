/**
 * The 2026-08-15 dry run died because mark-to-market alone wanted more Jupiter
 * requests per minute than the whole budget allowed, and nothing said so until
 * three positions were stuck an hour later. These checks pin that guard down.
 *
 * Plain node, no framework: node tests/config_budget_guard.mjs
 */
import assert from 'node:assert/strict';

const BASE = {
  SOLANA_RPC_URL: 'https://example.invalid/?api-key=test',
  JUPITER_BASE_URL: 'https://lite-api.jup.ag/swap/v1',
  DRY_RUN: 'true',
  LOG_LEVEL: 'ERROR',
};

let passed = 0;
let failed = 0;

async function loadWith(overrides) {
  for (const k of Object.keys(process.env)) {
    if (/^(SOLANA_|JUPITER_|DRY_RUN|LOG_LEVEL|MAX_|PRICE_|POSITION_)/.test(k)) {
      delete process.env[k];
    }
  }
  Object.assign(process.env, BASE, overrides);
  // Bust the module cache so each case re-reads the environment.
  const mod = await import(`../dist/config.js?t=${Math.random()}`);
  return mod.loadConfig();
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    failed++;
  }
}

console.log('\nJupiter request-budget guard\n');

await check('rejects the exact config that failed on 2026-08-15', async () => {
  await assert.rejects(
    async () =>
      loadWith({
        MAX_POSITIONS: '5',
        PRICE_POLL_INTERVAL_MS: '3000',
        JUPITER_MAX_REQ_PER_MIN: '30',
      }),
    /more than half|JUPITER_MAX_REQ_PER_MIN/,
    'MAX_POSITIONS=5 at a 3s poll needs 100 req/min and must not start',
  );
});

await check('accepts the corrected defaults', async () => {
  const cfg = await loadWith({
    MAX_POSITIONS: '5',
    PRICE_POLL_INTERVAL_MS: '20000',
    JUPITER_MAX_REQ_PER_MIN: '30',
  });
  assert.equal(cfg.pricePollIntervalMs, 20000);
  assert.equal(cfg.jupiterMaxReqPerMin, 30);
});

await check('a raised budget re-permits tight polling (the API-key case)', async () => {
  const cfg = await loadWith({
    MAX_POSITIONS: '5',
    PRICE_POLL_INTERVAL_MS: '3000',
    JUPITER_MAX_REQ_PER_MIN: '600',
  });
  assert.equal(cfg.jupiterMaxReqPerMin, 600);
});

await check('more positions at a fixed budget is caught', async () => {
  await assert.rejects(
    async () =>
      loadWith({
        MAX_POSITIONS: '20',
        PRICE_POLL_INTERVAL_MS: '20000',
        JUPITER_MAX_REQ_PER_MIN: '30',
      }),
    /JUPITER_MAX_REQ_PER_MIN/,
  );
});

await check('an inline comment in a value is still rejected, not coerced', async () => {
  // systemd EnvironmentFile leaves these attached; the parser must not shrug.
  await assert.rejects(
    async () => loadWith({ DRY_RUN: 'true   # simulate everything' }),
    /is not a boolean/,
    'DRY_RUN must throw rather than silently reading as false',
  );
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
