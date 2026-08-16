# Solana Second-Wave Micro-Cap Sniper

A TypeScript/Node.js bot that watches newly listed Solana tokens, scores them
against a safety and momentum filter, buys small fixed USDC positions in the ones
that pass, and exits automatically on a profit target, stop loss, trailing stop or
time limit.

It deliberately does **not** compete on speed. Professional snipers own the first
10-30 seconds and you will not beat them from a Proxmox container. This bot waits
out that window (`MIN_AGE_SECONDS`, default 45) and only enters tokens that are
still alive and still attracting buyers afterwards.

---

## Results from actually running it

This bot ran in dry run against live Solana markets for about seven hours.
It was retired the next day.

Here is what 42 trades looked like.

Win rate was 14.3%. Six wins, thirty six losses.
Break even needed 32%.
Net was -$326.98 on $25 positions.
Average winner +$29.85. Average loser -$14.06.

Every entry age band lost money.

| age at buy | trades | wins | net |
|---|---|---|---|
| 45-120s | 21 | 4 | -$136.45 |
| 121-300s | 8 | 1 | -$74.70 |
| 301-600s | 4 | 0 | -$55.60 |
| 600-1800s | 9 | 1 | -$60.23 |

BE WARNED: dry run is the best case, not the average. It prices both legs
against real Jupiter quotes. It cannot model a failed submission, MEV, or your
real fill when you are selling into a pool that is already collapsing. Live
will be worse than the numbers above.

Three reasons tuning did not fix it.

The safety score does not predict direction. It screens for rug mechanics and
it does that job correctly. Six of the first seven losers scored 100 out of 100.

Winners were not big enough. At a 14.3% win rate you need an average winner
near +600%. These peaked at 2x to 3x.

Losers cannot be capped. Stops were set at -40% and filled at -53% on average.
Worst fill was -86.8%. These tokens gap. They do not trend down through your
stop, they jump past it.

Taking the stop loss out makes it worse, not better. Expected value drops from
about -0.28 per dollar to -0.57.

The code works. The strategy does not. I am publishing it because the negative
result is the useful part.

---

## Read this before anything else

**Most tokens this bot buys will lose money.** That is not a defect in the
strategy, it is the strategy. It is a right-tail bet: a small number of large
winners have to pay for a large number of losers.

Three things you should know before you fund a wallet, all of which came out of
actually building and running this rather than from theory:

1. **The shipped trailing stop caps your winners.** With
   `TRAILING_ACTIVATE_PCT=50` and `TRAILING_STOP_PCT=25`, a position up 50% is
   sold the moment it retraces 25% from its peak. Micro-caps retrace 25%
   constantly on the way up. So nearly every winner is cut between +15% and
   +60% and the `TAKE_PROFIT_PCT=150` target almost never fires. That caps the
   right tail, which is the exact thing this strategy depends on.

   Set `TRAILING_ACTIVATE_PCT=150`. The trail then protects the remainder after
   take profit instead of capping the run.

   This was measured, not theorised. After the change, 5 of 6 wins were
   trailing stop exits between +118% and +145%. Under the old value they would
   have been cut far earlier.

   BE WARNED: fixing this does not make the bot profitable. It was fixed before
   the 42 trade run above, and that run still lost -$326.98. Do not read this
   item as "correct the trail and it works".

2. **Passing every safety check does not mean you can sell.** While testing this
   build, a token cleared every filter in the spec — mint authority revoked,
   freeze authority revoked, RugCheck "low risk", $9k liquidity — and an
   immediate buy-then-sell round trip returned $4.67 on $25. It was a Token-2022
   mint with a `transferFeeConfig` extension. The bot now rejects transfer-fee
   mints outright and quotes the exit before committing to any entry. Neither
   check was in the original design, and without them this failure repeats.

3. **`DRY_RUN=true` is the default and you should leave it there for 24-48
   hours.** Dry run prices everything against real Jupiter quotes and logs every
   decision it would have made. It costs nothing and it is the only honest way to
   see what this configuration actually does.

This is not financial advice and it is not a tested profitable system. Fund it
only with money you are fully prepared to lose in its entirety.

---

## How it works

```
   DexScreener token-profiles + boosts  (REST, every DISCOVERY_INTERVAL_MS)
                    |
                    v
            candidate queue  ── too young? re-queued until MIN_AGE_SECONDS
                    |
                    v
   scorer.ts   ┌── hard disqualifies (any one of these = never buy) ──┐
               │  mint authority not revoked                          │
               │  freeze authority not revoked                        │
               │  Token-2022 transfer fee > MAX_TRANSFER_FEE_BPS      │
               │  RugCheck risk high / very_high (or unreachable)     │
               │  liquidity < MIN_LIQUIDITY_USD                       │
               │  transactions < MIN_TRANSACTIONS                     │
               │  age outside [MIN_AGE_SECONDS, MAX_AGE_SECONDS]      │
               │  top 10 non-LP holders > MAX_TOP10_HOLDER_PCT        │
               └──────────────────────────────────────────────────────┘
                    |  survivors scored 0-100
                    v
            score >= MIN_SAFETY_SCORE ?
                    |
                    v
   position_manager ── round-trip check: quote the SELL before buying
                    |     (reject if instant loss > MAX_ROUND_TRIP_LOSS_PCT)
                    v
              Jupiter swap: USDC -> token
                    |
                    v
   price loop (every PRICE_POLL_INTERVAL_MS) marks each position to market
   using a real sell quote for the exact size held, then checks, in order:
       stop loss  ->  trailing stop  ->  take profit  ->  max hold
```

The mark-to-market deliberately uses a Jupiter sell quote rather than
DexScreener's `priceUsd`. A mid price ignores what happens when you push your
actual position size into a thin pool, which is precisely the number that
determines your P&L.

---

## Scoring

Survivors of the hard disqualifies are scored, capped at 100:

| Factor | Points |
|---|---|
| Liquidity $5k-$10k / $10k-$50k / $50k+ | +10 / +20 / +30 |
| RugCheck risk low / medium | +25 / +10 |
| Mint authority revoked | +20 |
| Freeze authority revoked | +10 |
| Buy/sell ratio > 1.5 | +15 |
| 5m price change > 5% | +10 |
| Twitter or Telegram present | +5 |
| Website present | +5 |
| Holder count > 100 | +10 |
| 5m volume > $10k | +15 |

Mint and freeze revocation are both a hard gate *and* worth points, so every
token that gets scored at all starts at 30. `MIN_SAFETY_SCORE=60` therefore means
"30 points from the other eight factors", which is a lower bar than it looks.
Bear that in mind when tuning: 70 is a more meaningful threshold than 60.

---

## Setup

### 1. Create the Proxmox LXC

On the Proxmox host:

Replace every `<PLACEHOLDER>` with your own values.

| Placeholder | What it is |
|---|---|
| `<PVE_HOST>` | Your Proxmox host address |
| `<VMID>` | Any unused container ID |
| `<STORAGE>` | A Proxmox storage pool that exists on your host |
| `<BRIDGE>` | Your Proxmox bridge, usually `vmbr0` |
| `<VLAN_TAG>` | VLAN tag, or drop `tag=` entirely if you do not use VLANs |
| `<GATEWAY>` | Gateway for that subnet |
| `<CONTAINER_IP>` | The address you want this container to have |
| `<DNS_SERVER>` | Your DNS resolver |

```bash
PUB=$(cat ~/.ssh/id_ed25519.pub)
ssh root@<PVE_HOST> "cat > /tmp/k.pub <<EOF
$PUB
EOF
pct create <VMID> local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst \
  --hostname solana-sniper --cores 1 --memory 1024 --swap 512 \
  --rootfs <STORAGE>:4 \
  --net0 name=eth0,bridge=<BRIDGE>,tag=<VLAN_TAG>,gw=<GATEWAY>,ip=<CONTAINER_IP>/24,type=veth \
  --nameserver <DNS_SERVER> \
  --ostype ubuntu --unprivileged 1 --onboot 1 \
  --features nesting=1,keyctl=1 \
  --ssh-public-keys /tmp/k.pub
rm -f /tmp/k.pub; pct start <VMID>"
```

Put this on an isolated VLAN if you can. It holds a wallet key.

1 GB RAM and 4 GB disk is enough; the bot is almost entirely network-bound.
Ubuntu 22.04 and 24.04 are both supported by `deploy.sh`.

Three flags matter. `--features nesting=1,keyctl=1` — without nesting the Checkmk
agent controller crash-loops and the host looks monitored while reporting
nothing. `--onboot 1` — otherwise the bot silently stays down after a
maintenance window, which for a bot holding open positions means no stop losses
are running. `--ssh-public-keys` — so password auth can be turned off
immediately rather than "later".

**Put it on an isolated VLAN.** This container holds a private key controlling
real funds; it does not belong on your main LAN. The `tag=10` above places it on
a dedicated crypto VLAN whose egress is VPN-routed. Two consequences worth
planning for:

- Outbound to your monitoring server is likely blocked, so `cmk-agent-ctl
  register` cannot work. Use an **agent-over-SSH datasource** instead — Checkmk
  runs the agent over the inbound SSH path that is already permitted, and no
  agent port listens on a host holding a wallet key.
- Some hosts become unreachable from that egress. `release.solana.com` and
  `release.anza.xyz` both are, which is why `npm run keygen` exists.

If your fleet has a standard build process for new guests, use it — this
container needs the same SSH hardening, monitoring and backup coverage as
anything else, and more care than most.

### 2. Get a Helius RPC key (required)

The public endpoint `https://api.mainnet-beta.solana.com` **will not work**. This
bot makes several `getParsedAccountInfo` and `getParsedTokenAccountsByOwner`
calls per candidate per minute, and the public RPC rate-limits that within
minutes. It is fine for a brief smoke test and useless in production.

1. Sign up free at <https://helius.dev>
2. Create a project; copy the mainnet RPC URL, which looks like
   `https://mainnet.helius-rpc.com/?api-key=xxxxxxxx-xxxx-...`
3. Put it in `SOLANA_RPC_URL`

Triton One and QuickNode work equally well. The free Helius tier is sufficient
for the default intervals.

### 3. Deploy

Copy this directory into the container and run:

```bash
bash deploy.sh
```

It verifies Ubuntu 22.04, installs Node 20 via nvm, installs the Solana CLI,
creates an unprivileged `sniper` user, builds to `/opt/solana-sniper`, installs
the systemd unit and a logrotate config, and creates `.env` at mode 600. It does
**not** start the service, because `.env` is still the unedited template.

### 4. Generate a wallet

```bash
cd /opt/solana-sniper && sudo -u sniper npm run keygen
```

This writes the secret to `data/wallet.json` (mode 600) plus `data/wallet.env`
holding the base58 form, and prints **only the public key**. It then shows you
how to append it to `.env` without the secret ever reaching your screen,
scrollback or clipboard.

`solana-keygen` from the Solana CLI does the same job, but its release servers
(`release.solana.com` and `release.anza.xyz`) are unreachable from some egress
paths — including a VPN-routed VLAN — so `deploy.sh` treats that install as
optional and this command is the reliable route.

Use a **dedicated wallet**. This key is loaded into a long-running process that
submits swaps on its own. Never point this at a wallet holding anything you care
about.

Both key formats are accepted in `.env`: the raw JSON byte array, or a base58
string (what Phantom exports under "Show private key").

### 5. Fund the wallet

| Asset | Minimum | Why |
|---|---|---|
| USDC | `MAX_POSITIONS x POSITION_SIZE_USDC` (default $125) | Position capital |
| SOL | 0.1 SOL | Transaction fees, priority fees, and rent for each new token account |

Do not skip the SOL. Every new token you buy needs an associated token account,
which costs about 0.002 SOL in rent, plus fees per swap. The bot refuses to buy
below `MIN_SOL_BALANCE` (0.05) precisely so it cannot strand itself holding
tokens it lacks the SOL to sell.

**Getting USDC onto Solana**, easiest first:

- **Buy on an exchange that withdraws USDC on Solana directly.** Kraken, Coinbase
  and Binance all do. Choose the *Solana* network at withdrawal, not Ethereum or
  Arbitrum — sending an ERC-20 USDC to a Solana address loses it.
- **Buy SOL, then swap.** Send SOL to the wallet and swap part of it to USDC at
  <https://jup.ag>. Keep at least 0.1 SOL unswapped for fees.
- **Bridge from another chain** via Wormhole (<https://portalbridge.com>) or
  deBridge. Slower, more steps, more ways to make an expensive mistake. Only
  worth it if your funds are already on Arbitrum or similar.

### 6. Run it in dry run

```bash
systemctl start solana-sniper
journalctl -u solana-sniper -f

# structured log, prettier:
tail -f /opt/solana-sniper/logs/bot-$(date +%F).log | jq .
```

Leave it for 24-48 hours. Then:

```bash
cd /opt/solana-sniper && sudo -u sniper npm run status
```

Read the dry-run trades. Look specifically at:

- how many tokens were bought per day (should be roughly 5-15; hundreds means
  your filters are too loose)
- what fraction hit `STOP_LOSS` versus `TRAILING_STOP` versus `TAKE_PROFIT`
- whether `TAKE_PROFIT` ever fired at all (if it did not, see the note about the
  trailing stop at the top of this file)
- the `TOKEN_SKIPPED` reason distribution, which tells you which filter is doing
  the work

Only after that should you consider `DRY_RUN=false`.

### 7. Recommended first live configuration

Start smaller and stricter than the defaults:

```ini
POSITION_SIZE_USDC=10
MAX_POSITIONS=3
MIN_SAFETY_SCORE=70
MIN_LIQUIDITY_USD=10000
MAX_DAILY_LOSS_USDC=50
TRAILING_ACTIVATE_PCT=150    # see "Expected performance" — do not leave this at 50
```

That is $30 of exposure. If the strategy has an edge you will see it at $30 and
you will not have paid tuition to find out it does not.

---

## CLI

```bash
npm run start      # run the bot (normally via systemd)
npm run dev        # tsx watch mode for development
npm run build      # compile TypeScript to dist/
npm run status     # balances, open positions marked to market, daily stats, last 10 trades
npm run sell-all   # emergency: market-sell every open position
```

`sell-all` refuses to run while the bot is alive, because two processes selling
the same positions from the same state file will corrupt the P&L. Stop the
service first:

```bash
systemctl stop solana-sniper
cd /opt/solana-sniper && sudo -u sniper npm run sell-all
```

Use `npm run sell-all -- --force` only if the bot is genuinely wedged and you
accept that risk.

---

## Operations

```bash
systemctl status solana-sniper
systemctl restart solana-sniper
journalctl -u solana-sniper -n 200 --no-pager
```

State lives in `/opt/solana-sniper/data/`:

- `state.json` — open positions, closed trades, daily counters. Written
  atomically (temp file, fsync, rename), so a crash mid-write cannot truncate it.
  If it is ever unreadable the bot moves it aside and refuses to start rather
  than silently starting with an empty book and re-buying tokens you hold.
- `seen_tokens.json` — deduplication across restarts, capped at 20,000 entries.
- `bot.pid` — used by `sell-all` to detect a running bot.

**Open positions are not sold on shutdown.** They persist and resume on the next
start. A `systemctl stop` leaves you exposed; use `sell-all` if you want flat.

Useful log queries:

```bash
L=/opt/solana-sniper/logs/bot-$(date +%F).log

jq -r 'select(.event=="TOKEN_SKIPPED").reason' $L | sort | uniq -c | sort -rn
jq -c 'select(.event=="POSITION_CLOSED")|{symbol,reason,pnl_usdc,pnl_pct,hold_min}' $L
jq -c 'select(.event=="SCORE_RESULT")|{symbol,score,breakdown}' $L
jq -c 'select(.level=="ERROR")' $L
```

Watch for `SELL_ALERT`. It means three sell attempts failed and you are still
holding the position.

---

## Expected performance

### The scenario as originally specified

10 buys/day, 20% win rate, average winner 3x, average loser -40%, $25 per
position:

| | |
|---|---|
| 2 winners x $25 x (3.0 - 1) | **+$100.00** |
| 8 losers x $25 x 0.40 | **-$80.00** |
| Gross | **+$20.00/day** |

Then subtract the costs that model omits. Per round trip (two swaps):

| Cost | Amount |
|---|---|
| Priority fees, 2 x 100,000 lamports @ $200/SOL | $0.04 |
| Base transaction fees | $0.01 |
| Associated token account rent (~0.002 SOL, not reclaimed) | $0.41 |
| AMM swap fees, ~1% round trip on $25 | $0.25 |
| Realized price impact and slippage | $0.75 |
| **Per trade** | **~$1.46 - $2.50** |

That slippage figure is measured, not assumed. In this build's dry runs, tokens
that passed every filter showed instant buy-then-sell round-trip costs of 0.8%,
1.5%, 6.5% and 7.8%. Three percent is a fair average, so call it $2.00 per trade.

**10 trades x $2.00 = $20/day in friction. Net: roughly $0/day.** The scenario as
specified is a breakeven system before you account for anything going wrong.

### Why the real number is worse

The assumption that breaks is "average winner 3x". **This configuration cannot
produce it.**

`TRAILING_ACTIVATE_PCT=50` arms the trailing stop as soon as a position is up
50%. `TRAILING_STOP_PCT=25` then sells on any 25% retrace from the peak. For a
winner to reach the +150% take profit, it must climb from 1.5x to 2.5x without
ever pulling back 25% from a running high. Micro-caps do that pullback several
times an hour.

So in practice:

- `TAKE_PROFIT` at +150% rarely fires
- almost every winner exits on `TRAILING_STOP`, at roughly 0.75x its peak
- a position peaking at 1.8x exits around 1.35x, a +35% winner, not a +200% one
- realistic average winner: **about +50%**

Meanwhile losers are worse than -40%. The stop triggers at -40%, but the sell is
submitted into a pool that is collapsing, with 5% slippage tolerance, on a 3
second poll. Genuine rugs are well past -80% before any transaction lands. A
blended -55% is realistic.

### Realistic estimate

10 buys/day at $25, 15% win rate, average winner +50%, average loser -55%:

| | |
|---|---|
| 1.5 winners x $25 x 0.50 | **+$18.75** |
| 8.5 losers x $25 x 0.55 | **-$116.88** |
| Friction, 10 x $2.00 | **-$20.00** |
| **Net** | **about -$118/day** |

`MAX_DAILY_LOSS_USDC=100` would halt buying most days. That is the rail working
as intended, and it is also the honest answer to "what does daily P&L look like":
**the default configuration hits its daily loss limit and stops.**

### The break-even win rate

This is the number worth internalising. Solving for the win rate `w` that makes
expected value zero, with friction at 8% of position size:

**With the trailing stop as configured** (avg winner +50%, avg loser -55%):

```
w(0.50) = (1-w)(0.55) + 0.08   ->   w = 60%
```

**Without it**, letting winners run to the 2.5x take profit (avg winner +200%):

```
w(2.00) = (1-w)(0.55) + 0.08   ->   w = 24.7%
```

A 60% win rate on brand-new micro-cap tokens is not achievable. A 25% win rate is
at least arguable. **The trailing stop as specified is the single thing that
makes the arithmetic impossible**, because it systematically truncates the right
tail that the entire strategy is built on.

### What to change

Set `TRAILING_ACTIVATE_PCT=150` so it matches `TAKE_PROFIT_PCT`. The behaviour
then becomes what the design intended: winners run to +150%, 75% is sold, and the
remaining 25% free-rides under a trailing stop. The trail protects profit already
banked instead of capping profit never earned.

If you want downside protection before that point, widen `TRAILING_STOP_PCT` to
40-50% rather than arming it early at 25%.

Even after that fix, expect to lose money while tuning. The edge in this strategy,
if any exists, is in the filter quality — and the filters are what the dry-run
logs let you measure.

---

## Deviations from the original specification

Each of these is a case where the spec described something that does not exist or
does not work, found by running the code rather than reading it.

**Jupiter endpoint.** The spec's `https://quote-api.jup.ag/v6` no longer resolves
at all — DNS failure, not an HTTP error. Current endpoints are
`https://lite-api.jup.ag/swap/v1` (keyless, the default here) and
`https://api.jup.ag/swap/v1` (requires `JUPITER_API_KEY`). The request and
response shapes are otherwise unchanged, so the v6 field names in the spec are
still correct. Override with `JUPITER_BASE_URL` if this moves again.

**DexScreener WebSocket.** `wss://io.dexscreener.com/dex/screener/pairs/h24/1`
returns HTTP 404, as do the v3/v4/v5 path variants. It is an undocumented
endpoint that backs their website and it is not a supported API. The client is
implemented and kept behind `ENABLE_WEBSOCKET`, which **defaults to false**. REST
polling is the discovery path; it found 40+ new tokens per 80 seconds in testing,
which is well beyond what the candidate processor can score.

**No 1-minute buckets.** DexScreener exposes `m5`, `h1`, `h6` and `h24` only.
`MIN_TRANSACTIONS` ("50 transactions in the first minute") and the "1m buy/sell
ratio" are both evaluated against `m5`. For a token 45-120 seconds old the m5
bucket covers its entire life, so the transaction count is effectively the real
lifetime count; the buy/sell ratio is a 5-minute average and slightly less
reactive than specified.

**Token-2022 transfer fee check (added).** Not in the spec. Added after a live
token passed every specified disqualify and still lost 81% on an instant round
trip. Controlled by `MAX_TRANSFER_FEE_BPS`, default 100 (1%).

**Round-trip check before buying (added).** Not in the spec. Before any buy, the
bot quotes selling back what it is about to receive and refuses the trade if the
immediate loss exceeds `MAX_ROUND_TRIP_LOSS_PCT` (default 15%). This is the
generic backstop for honeypots, one-sided pools, and pools too thin for the
position size.

**`REQUIRE_RUGCHECK` (added, default true).** The spec disqualifies on RugCheck
"high"/"very_high" but is silent on the API being unreachable. Treating "unknown"
as acceptable lets a token pass on other factors alone, which is exactly the
situation where you cannot see rug risk. Set it false to follow the original
behaviour.

**`MAX_AGE_SECONDS` (added, default 1800).** The spec says "< 30 minutes old" for
discovery but gives no upper bound in the disqualify list. Without one, the
candidate queue accumulates tokens indefinitely.

**Sell retries.** The spec says "on stop loss, no retry logic" and also "failed
sell = retry 3x then alert". These are read as: no waiting for a better *price*,
but transaction-level failures are retried three times. A failed sell leaves the
position open and logs `SELL_ALERT` at ERROR.

**Ephemeral dry-run wallet (added).** With `DRY_RUN=true` and no
`WALLET_PRIVATE_KEY`, a throwaway keypair is generated so you can paper-trade
without funding anything. Balance rails are logged but not enforced in dry run,
since an unfunded wallet would otherwise block every simulated trade. A real key
is mandatory when `DRY_RUN=false`.

---

## Configuration reference

Every variable is documented in [.env.example](.env.example). The ones that
change behaviour most:

| Variable | Default | Notes |
|---|---|---|
| `DRY_RUN` | `true` | Simulates against real quotes; submits nothing |
| `MIN_AGE_SECONDS` | `45` | The second-wave delay. The core of the strategy |
| `MIN_SAFETY_SCORE` | `60` | Effectively "30 from the non-gate factors" |
| `TRAILING_ACTIVATE_PCT` | `50` | **Set to 150.** See Expected performance |
| `MAX_TRANSFER_FEE_BPS` | `100` | Token-2022 honeypot guard |
| `MAX_ROUND_TRIP_LOSS_PCT` | `15` | Exit-side sanity check before entry |
| `MAX_DAILY_SPEND_USDC` | `MAX_POSITIONS x POSITION_SIZE_USDC x 3` | Hard daily buy cap |
| `MAX_DAILY_LOSS_USDC` | `100` | Halts buying; never blocks selling |

---

## Security

- `.env` is mode 600 and owned by `sniper`. It contains a key that controls funds.
- The logger scrubs any field named like a key or secret, and strips the API key
  from the RPC URL before logging config at startup. The private key is never
  passed to it in the first place.
- The systemd unit runs unprivileged with `ProtectSystem=strict`,
  `NoNewPrivileges`, `PrivateTmp` and a `ReadWritePaths` allowlist of just
  `logs/` and `data/`.
- `.gitignore` excludes `.env`, `data/` and `logs/`. Do not commit this repo
  anywhere public with those present.
- Use a dedicated wallet. Treat anything in it as spent.

---

## Troubleshooting

**`429 Too Many Requests` from the RPC** — you are on the public endpoint. Get a
Helius key.

**`BUY_NO_ROUTE` on everything** — check `JUPITER_BASE_URL` resolves:
`curl -s "https://lite-api.jup.ag/swap/v1/quote?inputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&outputMint=So11111111111111111111111111111111111111112&amount=1000000&slippageBps=300" | jq .outAmount`

**Nothing is ever bought** — expected, and usually correct. Check the skip reason
distribution; `liquidity_below_minimum` and `too_old` dominating is normal.

**`rugcheck_unavailable` on everything** — RugCheck is rate-limiting or down. Wait,
or set `REQUIRE_RUGCHECK=false` while understanding what that gives up.

**`SELL_ALERT`** — three sell attempts failed and you still hold the token.
Usually a drained pool with no route. Check manually on jup.ag; you may be stuck.

**Positions survive a restart but prices look stale** — normal. The price loop
re-marks everything on the next poll.

---

## License

MIT. Provided as-is, with no warranty of any kind, least of all a financial one.
