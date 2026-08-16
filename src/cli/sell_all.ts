import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { configureLogger, closeLogger, logger } from '../logger.js';
import { StateManager, round } from '../state/state_manager.js';
import { Wallet } from '../wallet/wallet.js';
import { JupiterClient } from '../trading/jupiter.js';
import { PositionManager } from '../trading/position_manager.js';

/**
 * The running bot holds the same state file. If both processes sell at once the
 * second one sells tokens that are already gone and writes a bogus P&L, so this
 * refuses to run while the bot is alive unless explicitly forced.
 */
function botIsRunning(dataDir: string): number | null {
  const pidFile = path.join(dataDir, 'bot.pid');
  if (!fs.existsSync(pidFile)) return null;
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  if (!Number.isFinite(pid)) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  configureLogger(cfg.logLevel, cfg.logDir);

  const force = process.argv.includes('--force');
  const pid = botIsRunning(cfg.dataDir);
  if (pid !== null && !force) {
    process.stderr.write(
      `\nThe bot is still running (pid ${pid}).\n` +
        'Selling from a second process while it polls the same positions will corrupt the P&L.\n\n' +
        'Stop it first:\n' +
        '  sudo systemctl stop solana-sniper\n\n' +
        'Or, if you know the bot is wedged and you accept the risk:\n' +
        '  npm run sell-all -- --force\n\n',
    );
    process.exit(1);
  }

  const state = new StateManager(cfg.dataDir);
  state.load();

  const open = state.getPositions();
  if (open.length === 0) {
    process.stdout.write('\nNo open positions. Nothing to sell.\n\n');
    closeLogger();
    return;
  }

  const wallet = Wallet.load(cfg);
  const jupiter = new JupiterClient(cfg, wallet.connection);
  const positions = new PositionManager(cfg, state, jupiter, wallet, wallet.keypair);

  process.stdout.write(
    `\nSelling ${open.length} open position(s) at market${cfg.dryRun ? ' (DRY RUN — nothing will be submitted)' : ''}:\n`,
  );
  for (const p of open) {
    process.stdout.write(`  ${p.symbol}  ${p.mint}  cost basis $${p.costBasisRemainingUsdc.toFixed(2)}\n`);
  }
  process.stdout.write('\n');

  logger.warn('SELL_ALL_REQUESTED', { positions: open.length, dry_run: cfg.dryRun, force });

  const result = await positions.sellAll('SELL_ALL');

  const daily = state.getDaily();
  process.stdout.write(
    `\nDone. Sold ${result.sold}, failed ${result.failed}.\n` +
      `Realized today: $${round(daily.realizedPnlUsdc, 2).toFixed(2)}\n\n`,
  );

  if (result.failed > 0) {
    process.stderr.write(
      `${result.failed} position(s) could not be sold. Check the SELL_ALERT entries for\n` +
        "`likely_cause`: 'pool_unroutable' is a dead market, 'client_throttled_or_upstream_down'\n" +
        'is our own rate limiting and will clear — do not read it as a rug.\n' +
        'They are still in state.json and still held.\n\n',
    );
    closeLogger();
    process.exit(2);
  }

  closeLogger();
}

main().catch((err) => {
  process.stderr.write(`sell-all failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
