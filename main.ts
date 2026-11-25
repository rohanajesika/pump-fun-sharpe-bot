// Pump.fun Sharpe Sprint — "spray-and-trail" paper bot.
//
// The brief ranks by hourly Sharpe ratio on a 6-hour pump.fun forward
// replay, not by wildest PnL, and a place needs net PnL above holding cash
// plus at least 20 distinct mints round-tripped at 0.01 SOL or more, with
// max drawdown 50%. The dev data says what works here, and it is not
// scalping for a fixed take-profit: a fixed +12% target caps exactly the
// coins that pay (the few that run several hundred percent), while the
// 2-slot fill latency buys the top of every spike. What the data rewards is
// the opposite shape:
//
//   * ENTER early and wide: any young curve with net buying over its last
//     few trades, as soon as it holds enough real SOL reserve for a
//     qualifying buy. No rise threshold to chase, no ranking by hottest
//     rise — entries are taken in replay order, first trigger first.
//   * One small fixed-size trade per mint, at most five open at once, so a
//     single bad coin can never sink an hour.
//   * EXIT with no fixed take-profit at all: a -8% stop-loss cuts the
//     many coins that die, a trailing stop (armed at +10%, out on a 5%
//     pullback from the peak) lets the rare runners pay for all of them,
//     and a ~40-minute age timeout frees slots stuck in flat coins.
//   * Every decision is a pure function of the replay state (hello, batch,
//     orders, slot): no clock, no randomness, no network, no environment.
//     The two grading executions therefore produce identical action logs.
//
// Wire protocol: the harness speaks agent-fun/replay/v2 on stdin/stdout.
// The vendored shim (vendor/makefun-bot.ts, the kit's own SDK) owns the
// wire; this file only decides orders. Each order pays base + priority tx
// fees plus ~1.25% curve fees, so exits are sized to clear a full round
// trip's fees with room to spare.

import { runBot, type Batch, type BotState, type OrderInput } from "./vendor/makefun-bot.ts";

// ---------------------------------------------------------------- tuning

/** SOL to spend per buy, before the harness's 1%-of-real-reserve cap. */
const BUY_LAMPORTS = 100_000_000n; // 0.10 SOL
/** A buy must still be at least this big to count toward the 20-mint bar. */
const MIN_BUY_LAMPORTS = 12_000_000n; // 0.012 SOL, a margin over 0.01
/** Real SOL reserve a curve needs before we touch it (cap >= MIN_BUY). */
const MIN_REAL_RESERVE_LAMPORTS = 1_200_000_000n; // 1.2 SOL
/** Trades we must have seen on a curve before judging its buying. */
const MIN_TRADES = 4;
/** Trades kept per curve for the buying-pressure window. */
const WINDOW = 4;
/** No rise threshold: entries are early, before any spike to chase. */
const IGNITION_RISE = 0.0;
/** Buy SOL volume must beat sell SOL volume by at least this factor. */
const BUY_PRESSURE = 1.2;
/** Never chase a coin that already ran this far above its birth price. */
const MAX_RUN_FROM_BIRTH = 1.3; // +30%
/** Only coins this young (slots since CreateEvent) are eligible. */
const MAX_COIN_AGE_SLOTS = 7200;
/** A trade counts as recent only if its last trade is this fresh. */
const MAX_STALE_SLOTS = 60;
/** New buys per batch at most (keeps entries from bunching in one slot). */
const MAX_NEW_BUYS_PER_BATCH = 2;
/** No fixed take-profit: the trailing stop banks the runners instead. */
/** Stop-loss: sell when the price is this far below the entry price. */
const STOP_LOSS = 0.08; // -8%
/** Once a trade is +10% up, a 5% pullback from its peak locks the gain. */
const TRAIL_ARM = 0.1;
const TRAIL_PULLBACK = 0.05;
/** Give up on a flat trade after this many slots (~40 minutes). */
const MAX_HOLD_SLOTS = 6000;
/** Slippage tolerance on buys, in basis points: tight, so a coin that runs
 *  away inside the 2-slot latency is skipped instead of bought at its top. */
const BUY_SLIPPAGE_BPS = 300;
/** Slippage tolerance on sells: wide, so an exit lands even in a dump. */
const SELL_SLIPPAGE_BPS = 1000;

// ---------------------------------------------------------------- tracking

/** What we remember about one curve, from its own trades only. */
interface Coin {
  createdSlot: number;
  /** Price (SOL per token) at the curve's first observed trade. */
  firstPrice: number;
  /** Last WINDOW post-trade prices, oldest first. */
  prices: number[];
  /** SOL volume of the last WINDOW trades, split by side. */
  buySol: number[];
  sellSol: number[];
  trades: number;
  lastSlot: number;
  complete: boolean;
}

/** What we remember about one open trade, from its own buy fill. */
interface Entry {
  /** Effective SOL per token paid, fees included (fill quote / tokens). */
  entryPrice: number;
  entrySlot: number;
  /** Highest price seen since entry, for the trailing stop. */
  peakPrice: number;
}

/** Price of one token in SOL from a curve's virtual reserves. */
function priceOf(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

const coins = new Map<string, Coin>();
const entries = new Map<string, Entry>();
/** Mints already round-tripped once: one trade per mint keeps the book wide. */
const done = new Set<string>();

function noteTrade(
  mint: string,
  slot: number,
  price: number,
  isBuy: boolean,
  solLamports: bigint,
): void {
  let coin = coins.get(mint);
  if (coin === undefined) {
    coin = {
      createdSlot: slot,
      firstPrice: price,
      prices: [],
      buySol: [],
      sellSol: [],
      trades: 0,
      lastSlot: slot,
      complete: false,
    };
    coins.set(mint, coin);
  }
  coin.prices.push(price);
  if (coin.prices.length > WINDOW) coin.prices.shift();
  const sol = Number(solLamports) / 1e9;
  coin.buySol.push(isBuy ? sol : 0);
  coin.sellSol.push(isBuy ? 0 : sol);
  if (coin.buySol.length > WINDOW) coin.buySol.shift();
  if (coin.sellSol.length > WINDOW) coin.sellSol.shift();
  coin.trades += 1;
  coin.lastSlot = slot;
}

function sum(values: number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/** Whether a curve is eligible for a first trade, in replay order. */
function eligible(mint: string, coin: Coin, state: BotState): boolean {
  if (coin.complete) return false;
  if (coin.trades < MIN_TRADES) return false;
  if (coin.prices.length < WINDOW) return false;
  if (state.slot - coin.createdSlot > MAX_COIN_AGE_SLOTS) return false;
  if (state.slot - coin.lastSlot > MAX_STALE_SLOTS) return false;
  if (entries.has(mint) || done.has(mint)) return false;
  if (state.positions.has(mint)) return false;
  for (const pending of state.pending.values()) {
    if (pending.order.side === "buy" && pending.order.mint === mint) return false;
  }
  const curve = state.curves.get(mint);
  if (curve === undefined) return false;
  if (curve.real_quote_reserves < MIN_REAL_RESERVE_LAMPORTS) return false;

  const first = coin.prices[0];
  const last = coin.prices[coin.prices.length - 1];
  if (first <= 0 || last <= 0) return false;
  const rise = last / first - 1;
  if (rise < IGNITION_RISE) return false;
  // Do not chase a coin that already ran far from where it was born.
  if (last / coin.firstPrice > MAX_RUN_FROM_BIRTH) return false;
  const buys = sum(coin.buySol);
  const sells = sum(coin.sellSol);
  if (sells <= 0) {
    if (buys <= 0) return false;
  } else if (buys < BUY_PRESSURE * sells) {
    return false;
  }
  return true;
}

function currentPrice(state: BotState, mint: string): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  return priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
}

// ---------------------------------------------------------------- the bot

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];

    // 1. Fold this batch's events into the per-coin tracks.
    for (const event of batch.events) {
      if (event.event === "CreateEvent") {
        const price = priceOf(
          BigInt(event.virtual_quote_reserves),
          BigInt(event.virtual_token_reserves),
        );
        let coin = coins.get(event.mint);
        if (coin === undefined) {
          coin = {
            createdSlot: event.slot,
            firstPrice: price,
            prices: [],
            buySol: [],
            sellSol: [],
            trades: 0,
            lastSlot: event.slot,
            complete: false,
          };
          coins.set(event.mint, coin);
        } else {
          coin.createdSlot = event.slot;
        }
      } else if (event.event === "TradeEvent") {
        const price = priceOf(
          BigInt(event.virtual_quote_reserves),
          BigInt(event.virtual_token_reserves),
        );
        noteTrade(event.mint, event.slot, price, event.is_buy, BigInt(event.sol_amount));
      } else {
        const coin = coins.get(event.mint);
        if (coin !== undefined) coin.complete = true;
      }
    }

    // 2. Fold this batch's fills into the open-trade records.
    for (const fill of batch.fills) {
      if (fill.side === "buy") {
        if (fill.status !== "filled") {
          // A buy the market refused (slippage: the coin ran away in the
          // 2-slot latency) or a failed transaction is never chased: the
          // re-based entry would buy the top of the same pump. Skip the mint.
          done.add(fill.mint);
          continue;
        }
        const quote = Number(BigInt(fill.quote_lamports));
        const tokens = Number(BigInt(fill.token_amount));
        if (tokens > 0) {
          const entryPrice = quote / tokens;
          entries.set(fill.mint, {
            entryPrice,
            entrySlot: fill.slot,
            peakPrice: entryPrice,
          });
        }
      } else {
        if (fill.status !== "filled") continue;
        // A sell (ours, or the harness closing a completed/flattened coin).
        entries.delete(fill.mint);
        done.add(fill.mint);
      }
    }
    // A completed curve's position is closed by the harness; drop its record.
    for (const [mint, coin] of coins) {
      if (coin.complete && !state.positions.has(mint)) entries.delete(mint);
    }

    // 3. Exits first: protect every open trade before opening a new one.
    const selling = new Set<string>();
    for (const pending of state.pending.values()) {
      if (pending.order.side === "sell") selling.add(pending.order.mint);
    }
    for (const [mint, holding] of state.positions) {
      if (selling.has(mint)) continue; // a sell for it is already in flight
      const entry = entries.get(mint);
      if (entry === undefined) continue; // no cost basis yet; wait a batch
      const price = currentPrice(state, mint);
      if (price <= 0) continue;
      if (price > entry.peakPrice) entry.peakPrice = price;
      const change = price / entry.entryPrice - 1;
      const peakGain = entry.peakPrice / entry.entryPrice - 1;
      const pullback = price / entry.peakPrice - 1;
      const agedOut = state.slot - entry.entrySlot >= MAX_HOLD_SLOTS;
      const stopLoss = change <= -STOP_LOSS;
      // No fixed take-profit: the trailing stop is the only way a winner
      // leaves, so a runner keeps paying until it actually turns.
      const trailing =
        peakGain >= TRAIL_ARM && pullback <= -TRAIL_PULLBACK;
      if (stopLoss || trailing || agedOut) {
        orders.push({
          side: "sell",
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
      }
    }

    // 4. Entries: eligible coins in this batch's own order, up to the cap.
    // No ranking by hottest rise: the hottest coins are nearest their top.
    const open = state.committedPositionCount();
    const room = state.hello.caps.max_open_positions - open;
    if (room > 0) {
      let buys = 0;
      // Cash the orders already pushed this batch will take: the shim only
      // records them as pending after onBatch returns, so track it here.
      let committedLamports = 0n;
      const seen = new Set<string>();
      for (const event of batch.events) {
        if (buys >= MAX_NEW_BUYS_PER_BATCH) break;
        if (buys >= room) break;
        if (event.event !== "TradeEvent") continue;
        if (seen.has(event.mint)) continue;
        seen.add(event.mint);
        const coin = coins.get(event.mint);
        if (coin === undefined) continue;
        if (!eligible(event.mint, coin, state)) continue;
        const cap = state.maxBuyLamports(event.mint);
        const size = cap < BUY_LAMPORTS ? cap : BUY_LAMPORTS;
        if (size < MIN_BUY_LAMPORTS) continue;
        const fee = state.txFeeLamports();
        if (state.freeCashLamports() - committedLamports < size + fee) continue;
        orders.push({
          side: "buy",
          mint: event.mint,
          quote_lamports: size,
          max_slippage_bps: BUY_SLIPPAGE_BPS,
        });
        committedLamports += size + fee;
        buys += 1;
      }
    }

    return orders;
  },
});
