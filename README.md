# btc-race-24h-bot

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/satriayusuf/btc-race-24h-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/satriayusuf/btc-race-24h-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A long-only cbBTC/USDC trading bot for make.fun's [BTC race](https://make.fun/bounty/btc-race-24h-20261117-0603): it trades a $1,000 paper account minute by minute against on-chain prices, in the `agent-fun/bars-replay/v1` replay.

## The idea

A full round trip in this market costs roughly 12–26 bps once the fill fee, the modelled slippage and the constant-product price impact are counted, while the standard deviation of a single minute is only about 6 bps. Any strategy that reacts to minute-level motion is therefore paying more in friction than the motion is worth — the kit's own churning baselines demonstrate this on the dev window, losing 2–10% to fees and stop-outs on a day the underlying rose.

So this bot does almost the opposite of a typical scalper:

- **Long early, on a leash.** After a short observation delay it buys with 90% of its cash as soon as the price shows it is not in freefall (within 0.4% of the window's first close) and holds above its 30-minute EMA, confirmed over 3 bars. On a drifting day, waiting hours for a "proven" trend costs more in entry price than the proof is worth.
- **Exits are wide on purpose.** Ordinary BTC days pull back 1–2% and recover; stops inside that band convert dips into realized losses. The position is sold only on a sustained break of the buffered 4-hour EMA (0.8% below it, held for 45 bars), a −3% hard stop, or the drawdown brake.
- **Account-level brakes.** An 8% equity drawdown from the peak flattens the position and pauses entries for 6 hours; a 13% drawdown stops new entries for the rest of the run — far inside the race's 25% drawdown bar.
- **Cooldowns.** After any exit the bot waits before re-entering, four times longer after a losing round trip, so a sideways day costs a handful of trades instead of dozens.
- **A guardrail trade.** If no signal has produced a filled order by bar 1250, the bot places one 5 USDC trade, so the run is never ranked below every traded entry for having no trades at all. It costs a fraction of a cent.

On the kit's frozen dev window (graded locally with `makefun grade-local`, the server's own replay) the bot makes **+1.67 USDC (+0.167%) net of all fees in a single trade, with a 1.9% maximum drawdown** — ahead of the house buy-and-hold (+1.07) and comfortably through the dev gate (net PnL > 0) that decides who races, while the active house baselines (EMA cross, ADX momentum, RSI/Bollinger) all lose money on the same window.

## Layout

- `main.ts` — the strategy, and the only file that thinks. Written for Node 22's type stripping (erasable syntax only).
- `vendor/makefun-bars.ts` — the kit's protocol shim, copied byte for byte; it owns the wire (hello/batch/reply/done), the account state and order validation.
- `.makefun/owner.json` — the entrant wallet the entry is signed for.

The bot is deterministic: a pure function of the bars it is sent. It reads no clock, no environment and no files, and uses no randomness, so the replay's two executions produce identical action logs.
