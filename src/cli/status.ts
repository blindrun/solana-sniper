import { loadConfig } from '../config.js';
import { configureLogger } from '../logger.js';
import { StateManager, round, type ClosedTrade } from '../state/state_manager.js';
import { Wallet } from '../wallet/wallet.js';
import { JupiterClient } from '../trading/jupiter.js';
import { PositionManager, type MarkResult } from '../trading/position_manager.js';

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function padL(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : ' '.repeat(n - s.length) + s;
}

function money(n: number): string {
  const sign = n < 0 ? '-' : '+';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function summarize(trades: ClosedTrade[]): string {
  if (trades.length === 0) return 'no closed trades yet';
  const wins = trades.filter((t) => t.pnlUsdc > 0);
  const losses = trades.filter((t) => t.pnlUsdc <= 0);
  const total = trades.reduce((a, t) => a + t.pnlUsdc, 0);
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.pnlUsdc, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + t.pnlUsdc, 0) / losses.length : 0;
  const avgHold = trades.reduce((a, t) => a + t.holdMinutes, 0) / trades.length;
  return [
    `${trades.length} trades  |  ${wins.length}W / ${losses.length}L  |  win rate ${(
      (wins.length / trades.length) *
      100
    ).toFixed(1)}%`,
    `net ${money(total)}  |  avg win ${money(avgWin)}  |  avg loss ${money(avgLoss)}  |  avg hold ${avgHold.toFixed(
      1,
    )}m`,
  ].join('\n  ');
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  // Status is a read-only report; keep it out of the bot's own log file.
  configureLogger('ERROR', cfg.logDir);

  const state = new StateManager(cfg.dataDir);
  state.load();

  const wallet = Wallet.load(cfg);
  const jupiter = new JupiterClient(cfg, wallet.connection);
  const positions = new PositionManager(cfg, state, jupiter, wallet, wallet.keypair);

  const lines: string[] = [];
  lines.push('');
  lines.push(`Solana Sniper — ${cfg.dryRun ? 'DRY RUN' : 'LIVE'}`);
  lines.push(`Wallet: ${wallet.publicKey.toBase58()}${wallet.ephemeral ? ' (ephemeral)' : ''}`);

  try {
    const [usdc, sol] = await Promise.all([wallet.usdcBalance(), wallet.solBalance()]);
    lines.push(`Balance: ${usdc.toFixed(2)} USDC  |  ${sol.toFixed(4)} SOL`);
  } catch (err) {
    lines.push(`Balance: unavailable (${err instanceof Error ? err.message : String(err)})`);
  }

  const daily = state.getDaily();
  lines.push('');
  lines.push(
    `Today (${daily.date}): ${daily.buys} buys, ${daily.sells} sells, ` +
      `spent $${daily.spentUsdc.toFixed(2)} / $${cfg.maxDailySpendUsdc.toFixed(2)} cap, ` +
      `realized ${money(daily.realizedPnlUsdc)} (halt at -$${cfg.maxDailyLossUsdc.toFixed(2)})`,
  );

  // --- open positions, marked to market --------------------------------
  const open = state.getPositions();
  lines.push('');
  lines.push(`Open positions: ${open.length} / ${cfg.maxPositions}`);

  if (open.length > 0) {
    lines.push('');
    lines.push(
      '  ' +
        pad('SYMBOL', 10) +
        pad('MINT', 14) +
        padL('ENTRY$', 9) +
        padL('NOW$', 9) +
        padL('P&L', 10) +
        padL('P&L%', 9) +
        padL('HELD', 8) +
        '  FLAGS',
    );

    let openValue = 0;
    let openCost = 0;

    for (const p of open) {
      const markRes: MarkResult = await positions
        .markToMarket(p)
        .catch((err) => ({
          ok: false as const,
          kind: 'fault' as const,
          error: err instanceof Error ? err.message : String(err),
          status: null,
        }));
      const mark = markRes.ok ? markRes : null;
      const value = mark?.valueUsdc ?? 0;
      const pnl = mark ? value - p.costBasisRemainingUsdc : 0;
      const pnlPct = mark && p.costBasisRemainingUsdc > 0 ? (pnl / p.costBasisRemainingUsdc) * 100 : 0;
      const heldMin = (Date.now() - p.entryTs) / 60_000;

      openValue += value;
      openCost += p.costBasisRemainingUsdc;

      const flags: string[] = [];
      if (p.trailingActive) flags.push('trailing');
      if (p.partialSold) flags.push('partial-sold');
      if (p.sellFailures > 0) flags.push(`sell-failures=${p.sellFailures}`);
      if (!mark) flags.push('NO-ROUTE');

      lines.push(
        '  ' +
          pad(p.symbol, 10) +
          pad(p.mint.slice(0, 12), 14) +
          padL(p.costBasisRemainingUsdc.toFixed(2), 9) +
          padL(mark ? value.toFixed(2) : '—', 9) +
          padL(mark ? money(pnl) : '—', 10) +
          padL(mark ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%` : '—', 9) +
          padL(`${heldMin.toFixed(0)}m`, 8) +
          '  ' +
          flags.join(' '),
      );
    }

    lines.push('');
    lines.push(
      `  Unrealized: ${money(openValue - openCost)} on $${openCost.toFixed(2)} at risk`,
    );
  }

  // --- closed trades ----------------------------------------------------
  const closed = state.getClosed();
  lines.push('');
  lines.push('All-time:');
  lines.push('  ' + summarize(closed));

  const todayStr = new Date().toISOString().slice(0, 10);
  const todayTrades = closed.filter((t) => new Date(t.exitTs).toISOString().slice(0, 10) === todayStr);
  lines.push('');
  lines.push('Today:');
  lines.push('  ' + summarize(todayTrades));

  const last10 = closed.slice(-10).reverse();
  if (last10.length > 0) {
    lines.push('');
    lines.push('Last 10 closed trades:');
    lines.push(
      '  ' +
        pad('SYMBOL', 10) +
        pad('REASON', 15) +
        padL('P&L', 10) +
        padL('P&L%', 9) +
        padL('HELD', 8) +
        padL('SCORE', 7) +
        '  CLOSED',
    );
    for (const t of last10) {
      lines.push(
        '  ' +
          pad(t.symbol, 10) +
          pad(t.reason, 15) +
          padL(money(t.pnlUsdc), 10) +
          padL(`${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%`, 9) +
          padL(`${round(t.holdMinutes, 0)}m`, 8) +
          padL(String(t.score), 7) +
          '  ' +
          new Date(t.exitTs).toISOString().replace('T', ' ').slice(0, 19) +
          (t.dryRun ? '  (dry)' : ''),
      );
    }
  }

  lines.push('');
  process.stdout.write(lines.join('\n') + '\n');
}

main().catch((err) => {
  process.stderr.write(`status failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
