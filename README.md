# RUGRAT

**Replay real, historical Solana rug pulls with paper money. Can you get out in time?**

Rugrat is a voxel arcade game for Android (built for the Solana Seeker). You drop into a little
block world that is built from the *actual price chart* of a token that really collapsed, watch the
real wallet activity unfold on the real timeline, and decide when to sell. Nothing is simulated
about the history: the prices, timestamps and wallet events are replayed from recorded data. Only
the money is pretend (10 paper SOL).

> Educational game. Not financial advice. Rugrat is not affiliated with any token, person or
> project it replays; names and logos belong to their owners and appear only to identify the
> historical token.

---

## Gameplay

1. **Pick a building.** The home screen is a living voxel village gate: the RUGRAT wordmark, Rugrat,
   and a crowd. PLAY lifts the camera over the same village, where each of the four replays has its
   own trade building (a dome, a tower, a barn or a vault, by rug type) carrying that token's real
   logo, set in its own sector with farms, houses and a church. Tap a building, then choose **EASY**
   (wallet tags are shown while you play) or **HARD** (wallet identities stay hidden until the end).
2. **Play the replay.** The terrain *is* the historical price chart, in order, on a log scale. A single
   replay clock drives everything (price, terrain, wallet events, sound). BUY spends all 10 paper
   SOL at the replay price at that exact timestamp; SELL (or tapping Rugrat) sells it. After a sale
   the position is frozen; you can keep watching the rest of the replay.
3. **Get a verdict.**
   * **CLEAN EXIT**: you sold before the replay's *signal* (see [Data](#data-and-sources)).
   * **LATE EXIT**: you sold after the signal but before the collapse.
   * **RUGGED**: you were still in at the collapse.
4. **See what happened.** The Reveal replays the whole timeline with every tracked wallet visible.
5. **Compete.** A skill score (0 to 1000) ranks runs; there are leaderboards, friends and stats.
   Scores never depend on how much paper SOL you made.

**Fair play.** The difficulty you pick on the world card is locked for the whole run, and the playback speed is the replay's fixed, intended speed. A speed control exists only in development builds, and a run whose speed was altered is never recorded for competition.

**Skill score** (`src/competition/score.ts`): RUGGED = 0. Survived = 500, plus 300 for a clean exit,
plus up to 200 for how long you stayed in before the collapse. LATE scores 500 to 700; CLEAN scores
800 to 1000. Inputs are the verdict and historical timestamps only, so paper-SOL amounts,
P/L, playback speed and frame rate cannot change a score.

## Supported rugs

All four are real tokens, replayed from recorded data.

| World | Date | Type (replay metadata) | Price candles | Wallet events | Collapse marker | Verdict signal |
|---|---|---|---|---|---|---|
| **LIBRA** | 2025-02-14 | Historical replay | 1 s (only where trades occurred) | 35 | first tick after the peak at or below 50% of the peak | first SMART SELL of at least $500,000 |
| **BARRON** | 2025-01-20 | Fast dump | 1 min | 25 | at or below 50% of the peak | first SMART SELL burst of at least $400,000 |
| **MELANIA** | 2025-01-19 | Slow bleed | 5 min | 21 | at or below 50% of the peak | first SMART SELL burst of at least $1,500,000 |
| **HAWK** | 2024-12-04 | Dev exit | 15 s | 28 | at or below **15%** of the peak | first dev-wallet supply move of at least $250,000 |

The registry (`src/data/replays/`) is the single source of truth: every screen reads from it.

---

## Data and sources

Everything below is taken from the pipeline code in `scripts/` and the provenance stored inside each
replay (`meta`, `source`, `logoSource`). All sources are public and keyless; **no paid data
provider or API key was used**. The running game never calls any of these APIs: they are used only
by the data scripts, and the app ships the processed result.

| Data | Source |
|---|---|
| Price history | Jupiter chart API, `datapi.jup.ag/v2/charts/<mint>`: USD price candles. Each tick is a candle **close** at the candle's timestamp. |
| Token name, symbol, logo, creator address | Jupiter asset search, `datapi.jup.ag/v1/assets/search`. The logo URL is the asset's `icon` field (IPFS / Irys gateways). |
| Trades and wallet histories | Jupiter trades API, `datapi.jup.ag/v1/txs/...` (token trades; trader-filtered histories of sampled candidate wallets). LIBRA also used the holders API, `datapi.jup.ag/v1/holders/`. |
| Creator-wallet transactions (and, for LIBRA, pool reserve samples and liquidity removals) | Solana public RPC, `api.mainnet-beta.solana.com`. |
| Paper SOL to USD rate | Derived per replay from the trades' own USD and SOL volumes (median ratio). It is not an external SOL price feed. |

Raw API responses are saved untouched by `scripts/fetch-*.mjs` and `scripts/rugs/fetch-rug.mjs`, and
the build scripts turn them into the replay JSON. The large raw downloads are **not** in this
repository (they are re-fetchable); the processed replays and the per-rug config, events and report
files are.

### Important limitations and honesty notes

* **Wallet labels are derived, not authoritative.** DEV, INSIDER, SMART, WHALE and LIQUIDITY are
  neutral labels produced by mechanical rules over *sampled* wallets (for example, SMART is a
  top-profit wallet that sold most of what it bought before the collapse; WHALE is a top-volume
  wallet). They are heuristics over the data we fetched, not identities, and they assert nothing about
  intent. A wallet matching no rule is left untagged. The rules are in `scripts/build-events.ts`,
  `scripts/rugs/build-rug.ts` and each `data/rugs/<slug>/config.json`.
* **Price data is coarse.** Ticks are candle closes. Rugs use different candle sizes (see the table),
  LIBRA's 1-second candles exist only where a trade happened (it has gaps of up to about 28
  minutes). The game does not invent or adjust prices.
* **Collapse and signal rules are analytical choices made for replay purposes.** The collapse marker is
  a price-only rule (50% of peak, 15% for HAWK, whose price fell much further). The verdict signal
  is a per-replay rule with a dollar floor chosen for that token. They are defensible rules, not
  official definitions of "the rug". HAWK's "dev exit" signal is the creator wallet *moving* a large
  share of supply; it does not establish that the creator sold.
* **The onchain memo is a signed record, not proof of play.** Rugrat can write a run to Solana as a
  Memo signed by the player's wallet and verify it by reading it back. The check confirms the record
  is well-formed, signed by that wallet, refers to a known rug, and is consistent with the game's own
  verdict and score rules. It does **not** independently prove that the game was physically played:
  anyone can construct a consistent record by hand. **That is the current anti-cheat model and its
  limit.** Stronger guarantees would need an issuer that attests to runs.
* **Devnet.** The tested onchain flow (wallet, score memos, Rug Hunter badge) uses Solana **devnet**.
  SKR itself exists on mainnet only, so the SKR balance check reads mainnet (read-only).
* **SKR upgrade and payment infrastructure is not production-ready.** The code exists and has unit
  tests, but it has not been run against a live network, prices are placeholders, and there is no
  deployed issuer or treasury. See [SKR](#skr).
* **The prize pool is intentionally dormant.** Only accounting and planning code exists; nothing in
  the app uses it and nothing can send funds.

---

## Architecture

```
React Native (Expo) app
 |- Home / world selection ... menu scene (Three.js in a WebView) + RN overlays
 |- Game screen .............. replay scene (Three.js in a WebView) + RN HUD / controls
 |- Competition .............. leaderboard, friends, stats, badge, SKR
 `- Chain layer .............. Mobile Wallet Adapter, memo records, badge, SKR reads

Replay engine (pure TypeScript, no UI):  ReplayClock -> TimelineCursor -> ReplayEngine
  one clock; ticks, wallet events and markers are all derived from it; deterministic across
  frame sizes and playback speeds.
```

* `src/game/`: replay engine, clock, terrain, player accounting, verdict, Reveal.
* `src/data/replays/`: the replay registry (processed historical data).
* `src/competition/`: run results, skill score, stats, leaderboard, demo players.
* `src/chain/`: wallet (Mobile Wallet Adapter), memo records, verification, submission.
* `src/badge/`: Rug Hunter achievement, claim and Metaplex Core mint.
* `src/skr/`, `src/upgrade/`, `src/prize/`: SKR reads and perks, upgrade tiers and issuer logic, prize accounting.
* `src/menu/`, `src/screens/`, `src/components/`: the UI.
* `webview/src/`: the two Three.js scenes (`main.ts` game, `menu.ts` the home gate and the village), bundled by esbuild.
* `server/`: the (optional, not deployed) SKR upgrade issuer.
* `scripts/`: data pipeline and verification suites. `badge/`: the hosted badge metadata and image.

The WebView scenes are bundled into single inline HTML strings (`src/webview/*Html.ts`). Those two
files are **generated**, not committed: `npm run build:webview` creates them.

## Tech stack

Expo SDK 57, React Native 0.86, React 19, TypeScript, Three.js (instanced and merged voxel
geometry), `react-native-webview`, esbuild, Solana Mobile Wallet Adapter, `@solana/web3.js` (v1),
Metaplex Core and Umi, AsyncStorage.

## Solana integration

* **Mobile Wallet Adapter.** Connecting a wallet is optional. The game is fully playable offline with
  no wallet.
* **Onchain score.** After a run, "Record score" writes a Memo transaction (`rugreplay/1 {...}`)
  carrying run id, rug id, wallet, verdict, score, P/L %, entry and exit timestamps and survival time.
  The score is the one the game already computed; nothing is recalculated for the chain. The record
  is read back and verified (`src/chain/memo.ts`, `verifyTx.ts`). Duplicate submissions of the same
  run are blocked ("Already recorded"). A rejected or failed transaction never affects the local
  result.
* **Rug Hunter badge.** Surviving **3 unique rugs** (clean or late exit, counted from scores
  *recorded onchain* and checked against the game's rules, one per rug) unlocks a Metaplex Core badge, minted to the player's wallet
  with a permanent freeze delegate (soulbound), immutable metadata and onchain attributes. Its
  address is derived from a signature only the wallet can produce, so the same wallet cannot mint it
  twice. Metadata and image are hosted at <https://rugrat-badge.expo.app/rug-hunter.json>.
* **SKR** (below).

### SKR

* **Holder perks (implemented).** The SKR mint is `SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3` (kept
  in `src/skr/config.ts`). With a connected wallet the app makes one read-only balance request (no
  transaction, no signature). Any balance above zero is an SKR holder and unlocks two **cosmetic**
  perks: a purple Rugrat skin and a twilight arena. SKR never affects scores, verdicts, trading or
  ranking, and is never needed to play.
* **Badge upgrade tiers and payment (not production-ready).** Tier I, II and III unlock at 3, 7 and 15
  unique recorded rugs (only Tier I is reachable with four rugs). `server/` builds one atomic
  transaction (token payment + memo + soulbound tier badge) that the app checks against its own
  configuration before the wallet signs. Prices are placeholders and nothing is deployed.
* **Prize pool (dormant).** `src/prize/` holds deterministic accounting and a payout plan, behind a
  gate that is off. No code can move funds.

---

## Run it locally

Requirements: Node.js 20 or newer (developed on Node 24), npm. For the 3D scene check, Microsoft Edge
or Chrome (set `EDGE_PATH` if it is not in the default Windows location).

```bash
npm install
npm run build:webview        # generates src/webview/*Html.ts (also run automatically by the scripts below)
npm run typecheck            # tsc --noEmit
npm run verify:replay        # the full verification suite (about 1,160 checks, no network, no wallet)
npm run stress:scene         # headless-browser stress test of the game scene
npm run check:menu           # renders the menu scene headlessly: draw budget, tap and swipe, no errors
```

Wallet features use a native module, so **Expo Go cannot run them**: use an Android build (below) or
a development build. `npm start` runs the Metro bundler for such a build.

## Build the Android APK

The EAS `preview` profile builds a standalone APK (no Metro needed).

```bash
npx eas-cli login
npx eas-cli init               # link YOUR EAS project (app.json carries the maintainer's project id and owner)
npx eas-cli build --platform android --profile preview
```

The generated WebView bundles are created on the build server by the `eas-build-post-install` hook,
so they do not need to be committed. `eas.json` sets `EXPO_PUBLIC_BADGE_METADATA_URI` for the build.

## Environment variables

All `EXPO_PUBLIC_*` values are compiled into the app and are public. Copy `.env.example` to `.env`
for local runs; EAS builds read `eas.json`.

| Variable | Purpose | Default |
|---|---|---|
| `EXPO_PUBLIC_SOLANA_CLUSTER` | `devnet` or `mainnet-beta` for score memos and the badge. **Required in release builds** (the app refuses to start without it); `eas.json` sets `devnet` for `preview` and `mainnet-beta` for `production` | `devnet` in development only |
| `EXPO_PUBLIC_SOLANA_RPC` | https RPC override for that cluster (rejected if it points at the other cluster). Production needs a provider here, stored in the EAS `production` environment (see `docs/MAINNET.md`) | Solana's public RPC (not production-grade) |
| `EXPO_PUBLIC_BADGE_METADATA_URI` | hosted badge metadata | inline fallback (no image) |
| `EXPO_PUBLIC_SKR_RPC` | https RPC override for the (mainnet, read-only) SKR check; never a devnet endpoint | public mainnet RPC |
| `EXPO_PUBLIC_ISSUER_URL`, `EXPO_PUBLIC_PAYMENT_MINT`, `EXPO_PUBLIC_TREASURY` | enable the SKR upgrade UI | unset (inactive) |

The optional issuer server has its own environment; see `server/README.md`. There are no secrets in
this repository; the issuer key and `ASSET_SECRET` must be supplied by whoever runs the server.

## Reproduce or extend the data

The raw downloads are not included. To rebuild a replay, fetch its raw data and run its build step
(see the header comment of each script):

```bash
npm run fetch:rug -- <slug>     # BARRON / MELANIA / HAWK: raw data into data/rugs/<slug>/raw (needs data/rugs/<slug>/config.json)
npm run build:rug -- <slug>     # processed replay into src/data/replays
```

LIBRA was produced by the earlier single-rug pipeline (`fetch:raw`, `fetch:trades`, `fetch:onchain`,
`build:liquidity`, `build:events`, `build:replay`). Adding a rug means adding a config, building it and
listing it in `src/data/replays/index.ts`.

## Testing

`npm run verify:replay` runs the whole suite: every replay (and a synthetic demo replay) through the
engine suite; rug selection and navigation; competition, score and leaderboard logic; onchain memo
build, parse and verification, duplicates and failure handling; the badge; SKR logic; upgrade
transaction construction; prize accounting; and the menu data. Chain and wallet behaviour is tested
against mocked RPC and wallet responses; **real-device and real-network behaviour is tested by hand**.

## Roadmap

* More rugs (the higher badge tiers need them).
* A hosted issuer, real prices and a treasury to finish SKR badge upgrades.
* A wallet indexer for weekly leaderboards, then prize payouts after legal and platform review.
* Stronger anti-cheat through issuer attestation of runs.
* A mainnet deployment of the score and badge flow (see `docs/MAINNET.md` for the checklist).

## License and attribution

Code: Apache License 2.0 (see `LICENSE`). The historical data are public onchain and API records;
token names and logos belong to their respective owners. Built with Expo, React Native, Three.js
(MIT), Solana web3.js, Metaplex Core and Umi, and the Solana Mobile Wallet Adapter. Historical data
from Jupiter's public data API and the Solana public RPC.
