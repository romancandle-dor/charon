# Charon-Bot — Trading Bot (forked)

Node.js trading bot, forked from `yunus-0x/charon` (this is a SEPARATE project from
`~/charon/`). Currently in **dry_run mode** — no real trades, positions stored virtually
to collect outcome data before going live.

## Layout

```
charon-bot/
├── index.js                     # entry: daemon + Telegram bot
├── src/pipeline/                # orchestrator, llm, candidate builder
│   ├── orchestrator.js          # main loop: processCandidateFromSignals
│   ├── llm.js                   # decideCandidateBatch (LLM + rule-based fallback)
│   └── candidateBuilder.js      # filterCandidate, buildCandidate
├── src/db/                      # better-sqlite3
│   ├── positions.js             # createDryRunPosition, createLivePosition
│   ├── decisions.js             # llm_decisions, llm_batches
│   └── settings.js              # strategies table, numSetting/boolSetting
├── src/execution/               # positions, router (live swaps)
├── src/telegram/                # bot commands, menus, callbacks
├── charon.sqlite                # all bot state (gitignored, ~110MB)
└── .env                         # TRADING_MODE, RPC, GMGN_*, TELEGRAM_*
```

## Common commands

```bash
pm2 list                              # meridian + charon running
pm2 logs charon --lines 50            # tail bot logs
pm2 restart charon                    # restart bot
node index.js                         # run directly (foreground)
```

## Gotchas

- **TRADING_MODE=dry_run** is active. `createLivePosition` in `src/execution/router.js`
  is the only path that signs/sends swaps; `dry_run` skips it entirely. To go live,
  edit `.env` and understand the wallet implications first.
- **Only ONE bot instance per Telegram token.** A second instance causes 409 Conflict
  on `getUpdates` and the loser dies. If `pm2 status` shows a stale manual process,
  kill it before starting a new one.
- **rule-based picker (in `src/pipeline/llm.js`)** fires when `ENABLE_LLM=false`. Current
  threshold 40/140 → most candidates get WATCH. OpenCode is currently tuning this.
- **Strategy is stored in the DB** (`strategies` table, `sniper` is active), not in
  `config.js`. Use Telegram `/strategy` menu to switch, or `sqlite3 charon.sqlite`
  for raw edits.
- **charon.sqlite is the bot's DB.** Distinct from `~/charon/data/charon.duckdb`
  (the collector's DB). Don't confuse them.
- **`llm_min_confidence=75`** in settings — any BUY below this becomes a WATCH.
  Lower via Telegram `/settings` or direct DB edit.

## Tables (live)

`signal_events`, `candidates`, `llm_decisions`, `llm_batches`, `decision_logs`,
`dry_run_positions`, `dry_run_trades`, `tp_sl_rules`, `strategies`, `settings`,
`learning_lessons`.
