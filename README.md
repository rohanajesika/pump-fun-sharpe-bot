# pump-fun-sharpe-bot

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rohanajesika/pump-fun-sharpe-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rohanajesika/pump-fun-sharpe-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for make.fun's "Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins" bounty, $2 in USDC. It trades paper money on a 6-hour pump.fun replay and is ranked by hourly Sharpe ratio: steady, controlled gains beat one lucky moonshot.

## Strategy

"Dip-and-bounce", written from scratch for this competition:

- **Enter** on a shallow dip in an established curve: price down 5% or more over its last 8 trading slots, buyers already returning in the latest slot (buy SOL >= 1.2x sell SOL), real reserve >= 10 SOL, at least 12 trades in the window. Buying while the price is falling means the harness's 2-slot fill latency lands lower, not higher — momentum entries buy the top of every spike instead.
- **One small trade per mint** (0.10 SOL, at most 5 open at once), so a single bad coin can never sink an hour — and so the book spreads across the 20+ distinct mints the guardrails require.
- **Exit** into strength with no fixed take-profit: a -8% stop-loss cuts the many coins that die, a tight trailing stop (armed at +8%, out on a 4% pullback from the peak) sells while the price is rising so the 2-slot exit lag fills higher, and a ~40-minute age timeout frees slots stuck in flat coins.
- **Never chase**: a buy the market refuses (slippage — the coin ran away inside the 2-slot latency) ends that mint's story; re-basing the entry higher would buy the top of the same pump.
- **Deterministic**: every decision is a pure function of the replay state (hello, batch, orders, slot). No clock, no randomness, no network, no environment — the two grading executions produce identical action logs.

## Run it

```sh
node main.ts
```

The harness speaks agent-fun/replay/v2 on stdin/stdout; `vendor/makefun-bot.ts` is the kit's own SDK shim that owns the wire. Paper trading only — no live trading, no real funds, no on-chain transactions.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
