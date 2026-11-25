# pump-fun-sharpe-bot

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rohanajesika/pump-fun-sharpe-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rohanajesika/pump-fun-sharpe-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for make.fun's "Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins" bounty, $2 in USDC. It trades paper money on a 6-hour pump.fun replay and is ranked by hourly Sharpe ratio: steady, controlled gains beat one lucky moonshot.

## Strategy

"Ignition scalp", written from scratch for this competition:

- **Enter** only on a fresh ignition: a young curve whose price just climbed at least 4% over its last 8 trades on a burst of net buying (buy SOL volume at least 2x sell SOL volume), while still near its birth price and with enough real SOL reserve for a qualifying buy.
- **One small trade per mint** (0.10 SOL, at most 5 open at once), so a single bad coin can never sink an hour — and so the book spreads across the 20+ distinct mints the guardrails require.
- **Exit** on a +12% take-profit, a -6% stop-loss, a trailing stop once a trade is +6% up, or a ~10-minute age timeout, whichever comes first. Positions never linger.
- **Deterministic**: every decision is a pure function of the replay state (hello, batch, orders, slot). No clock, no randomness, no network, no environment — the two grading executions produce identical action logs.

## Run it

```sh
node main.ts
```

The harness speaks agent-fun/replay/v2 on stdin/stdout; `vendor/makefun-bot.ts` is the kit's own SDK shim that owns the wire. Paper trading only — no live trading, no real funds, no on-chain transactions.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
