// Pump.fun Sharpe Sprint — "ignition scalp" paper bot.
//
// The brief ranks by hourly Sharpe ratio on a 6-hour pump.fun forward
// replay, not by wildest PnL, and a place needs net PnL above holding cash
// plus at least 20 distinct mints round-tripped at 0.01 SOL or more, with
// max drawdown 50%. So this bot trades for steady, repeatable, small wins:
//
//   * ENTER only on a fresh ignition: a young curve whose price has just
//     climbed on a burst of net buying (buy SOL volume dominating sell SOL
//     volume over its last few trades). No chasing of coins that already
//     ran far from their birth price.
//   * One small fixed-size trade per mint, at most five open at once, so a
//     single bad coin can never sink an hour.
//   * EXIT on a fixed take-profit, a tighter stop-loss, a trailing stop
//     once a trade is clearly green, or an age timeout — whichever comes
//     first. Positions never linger.
//   * Every decision is a pure function of the replay state (hello, batch,
//     orders, slot): no clock, no randomness, no network, no environment.
//     The two grading executions therefore produce identical action logs.
//
// Wire protocol: the harness speaks agent-fun/replay/v2 on stdin/stdout.
// The vendored shim (vendor/makefun-bot.ts, the kit's own SDK) owns the
// wire; this file only decides orders. A buy's size is capped at 1% of the
// mint's real SOL reserve per reply by the harness, and each order pays
// base + priority tx fees plus ~1.25% curve fees, so the take-profit is set
// wide enough to clear a full round trip's fees with room to spare.

import { runBot, type Batch, type BotState, type OrderInput } from "./vendor/makefun-bot.ts";

// ---------------------------------------------------------------- tuning

/** SOL to spend per buy, before the harness's 1%-of-real-reserve cap. */
const BUY_LAMPORTS = 100_000_000n; // 0.10 SOL
/** A buy must still be at least this big to count toward the 20-mint bar. */
const MIN_BUY_LAMPORTS = 12_000_000n; // 0.012 SOL, a margin over 0.01
/** Real SOL reserve a curve needs before we touch it (cap >= MIN_BUY). */
const MIN_REAL_RESERVE_LAMPORTS = 1_200_000_000n; // 1.2 SOL
/** Trades we must have seen on a curve before judging its ignition. */
const MIN_TRADES = 8;
/** Trades kept per curve for the momentum / pressure window. */
const WINDOW = 8;
/** Price rise over the window that counts as ignition. */
const IGNITION_RISE = 0.04; // +4%
/** Buy SOL volume must beat sell SOL volume by at least this factor. */
const BUY_PRESSURE = 2.0;
/** Never chase a coin that already ran this far above its birth price. */
const MAX_RUN_FROM_BIRTH = 1.3; // +30%
/** Only coins this young (slots since CreateEvent) are eligible. */
const MAX_COIN_AGE_SLOTS = 7200;
/** A trade counts as recent only if its last trade is this fresh. */
const MAX_STALE_SLOTS = 60;
/** New buys per batch at most (keeps entries from bunching in one slot). */
const MAX_NEW_BUYS_PER_BATCH = 2;
/** Take-profit: sell when the price is this far above the entry price. */
const TAKE_PROFIT = 0.12; // +12%
/** Stop-loss: sell when the price is this far below the entry price. */
const STOP_LOSS = 0.06; // -6%
/** Once a trade is +6% up, a 3.5% pullback from its peak locks the gain. */
const TRAIL_ARM = 0.06;
const TRAIL_PULLBACK = 0.035;
/** Give up on a flat trade after this many slots (~10 minutes). */
const MAX_HOLD_SLOTS = 1500;
/** Slippage tolerance on every order, in basis points. */
const SLIPPAGE_BPS = 500;

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

/** Net-buying ignition score of a curve, or null when it is not eligible. */
function ignition(mint: string, coin: Coin, state: BotState): number | null {
  if (coin.complete) return null;
  if (coin.trades < MIN_TRADES) return null;
  if (coin.prices.length < WINDOW) return null;
  if (state.slot - coin.createdSlot > MAX_COIN_AGE_SLOTS) return null;
  if (state.slot - coin.lastSlot > MAX_STALE_SLOTS) return null;
  if (entries.has(mint) || done.has(mint)) return null;
  if (state.positions.has(mint)) return null;
  for (const pending of state.pending.values()) {
    if (pending.order.side === "buy" && pending.order.mint === mint) return null;
  }
  const curve = state.curves.get(mint);
  if (curve === undefined) return null;
  if (curve.real_quote_reserves < MIN_REAL_RESERVE_LAMPORTS) return null;

  const first = coin.prices[0];
  const last = coin.prices[coin.prices.length - 1];
  if (first <= 0 || last <= 0) return null;
  const rise = last / first - 1;
  if (rise < IGNITION_RISE) return null;
  // Do not chase a coin that already ran far from where it was born.
  if (last / coin.firstPrice > MAX_RUN_FROM_BIRTH) return null;
  const buys = sum(coin.buySol);
  const sells = sum(coin.sellSol);
  if (sells <= 0) {
    if (buys <= 0) return null;
  } else if (buys < BUY_PRESSURE * sells) {
    return null;
  }
  // Strongest ignition first; ties break on mint so ordering is stable.
  return rise;
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
      if (fill.status !== "filled") continue;
      if (fill.side === "buy") {
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
      const takeProfit = change >= TAKE_PROFIT;
      const stopLoss = change <= -STOP_LOSS;
      const trailing =
        peakGain >= TRAIL_ARM && pullback <= -TRAIL_PULLBACK;
      if (takeProfit || stopLoss || trailing || agedOut) {
        orders.push({
          side: "sell",
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
        });
      }
    }

    // 4. Entries: the strongest fresh ignitions in this batch, up to the cap.
    const open = state.committedPositionCount();
    const room = state.hello.caps.max_open_positions - open;
    if (room > 0) {
      const candidates: { mint: string; score: number }[] = [];
      const seen = new Set<string>();
      for (const event of batch.events) {
        if (event.event !== "TradeEvent") continue;
        if (seen.has(event.mint)) continue;
        seen.add(event.mint);
        const coin = coins.get(event.mint);
        if (coin === undefined) continue;
        const score = ignition(event.mint, coin, state);
        if (score !== null) candidates.push({ mint: event.mint, score });
      }
      candidates.sort((a, b) => b.score - a.score || (a.mint < b.mint ? -1 : 1));
      let buys = 0;
      // Cash the orders already pushed this batch will take: the shim only
      // records them as pending after onBatch returns, so track it here.
      let committedLamports = 0n;
      for (const candidate of candidates) {
        if (buys >= MAX_NEW_BUYS_PER_BATCH) break;
        if (buys >= room) break;
        const cap = state.maxBuyLamports(candidate.mint);
        const size = cap < BUY_LAMPORTS ? cap : BUY_LAMPORTS;
        if (size < MIN_BUY_LAMPORTS) continue;
        const fee = state.txFeeLamports();
        if (state.freeCashLamports() - committedLamports < size + fee) continue;
        orders.push({
          side: "buy",
          mint: candidate.mint,
          quote_lamports: size,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        committedLamports += size + fee;
        buys += 1;
      }
    }

    return orders;
  },
});
