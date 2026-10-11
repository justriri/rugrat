# Mainnet readiness (status and what is still needed)

Nothing in this repository has sent a mainnet transaction. The score memo and Rug Hunter badge flow
has been tested on **devnet** only. This page is the checklist for moving it to Solana mainnet-beta.

## How the network is chosen

| Build | Network | How |
|---|---|---|
| `expo start` (development) | devnet if nothing is set | default for local development only |
| EAS `preview` (test APK) | devnet | `EXPO_PUBLIC_SOLANA_CLUSTER=devnet` in `eas.json` |
| EAS `production` | mainnet-beta | `EXPO_PUBLIC_SOLANA_CLUSTER=mainnet-beta` in `eas.json` |

A **release** build with the variable missing, or with any value other than `devnet` / `mainnet-beta`,
refuses to start: it never falls back to devnet silently. An RPC override that points at the other
cluster is rejected the same way. Code: `src/chain/config.ts`. Tests: `scripts/verify-mainnet.ts`.

## What is network-independent and what is not

* **Same on every cluster:** the Memo program, the SPL Token and Associated Token programs, the
  Metaplex Core program id, the badge metadata URL and the memo record format.
* **Network-dependent by design:** the Rug Hunter badge address. It is derived from the wallet's
  signature over a message that includes the network name (`Network: devnet` / `Network: mainnet-beta`),
  so a wallet gets a different badge address on each network and they cannot collide. The devnet
  message is unchanged, so existing devnet addresses are unchanged. No code change is needed for
  mainnet.
* **Mobile Wallet Adapter:** the chain id is `solana:devnet` or `solana:mainnet` (the MWA 2.0 form;
  `solana:mainnet-beta` is not a valid id and was corrected).
* **Explorer links:** mainnet links carry no cluster parameter; devnet links carry `?cluster=devnet`.
* **Saved data:** chain records and badge claims are stored per network; the badge-progress display
  cache is per network too.

## SKR

* Mint `SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3` (published at solanamobile.com/skr; an SPL Token
  mint, 6 decimals, on Solana mainnet). Holder = balance above zero. The check is read-only and always
  uses a **mainnet** RPC, whatever network the score and badge use. `npm run check:live` re-verifies
  the mint against the official page and the chain.

## RPC

Every Solana RPC method the app uses (the wallet itself submits transactions through its own node):

| Method | Used for | Load |
|---|---|---|
| `getLatestBlockhash` | building the score memo transaction | 1 per record |
| `confirmTransaction` | waiting for a recorded score / badge mint | 1 per submission |
| `getParsedTransaction` | reading a record back; badge-progress scan | 1 per candidate record |
| `getSignaturesForAddress` | duplicate check (up to 2 pages) and badge-progress scan (up to 5 pages of 100) | 1 to 5 per refresh |
| `getAccountInfo` | does the wallet's badge already exist; does the SKR mint exist on this network | 1 per check |
| `getParsedTokenAccountsByOwner` | the SKR balance (holder check) | 1 per refresh |

The badge-progress scan is the heavy one (up to 500 signatures plus one `getParsedTransaction` per
matching memo), and `getParsedTokenAccountsByOwner` is restricted on some free tiers. Pick a provider
that allows both at your expected volume.

**Supplying the production RPC (no secret is committed).** The production profile in `eas.json` sets
only the cluster; it also names the EAS `production` *environment*, so a value stored there is applied
at build time:

```
npx eas-cli env:create production --name EXPO_PUBLIC_SOLANA_RPC --value "https://<your-mainnet-rpc-url>" --visibility sensitive
```

The value is compiled into the app (`EXPO_PUBLIC_*` values cannot be `secret`), so anyone can read it
from the APK: use a provider key that is restricted (allow-list / rate limits) or a proxy you control.
The SKR check uses the same provider automatically in a mainnet build; `EXPO_PUBLIC_SKR_RPC` overrides it.
Until a value exists the app uses Solana's PUBLIC mainnet RPC (`RPC_IS_PUBLIC_DEFAULT`): enough for a
smoke test, rate limited and not production-grade.

## Still needed before production (operator decisions)

1. **Production RPC provider** (not selected; see above). No provider account or credential exists in
   this project, so none is configured and none was invented.
2. **Known scan limit:** badge progress and duplicate detection read only the wallet's most recent 500
   transactions. A very active wallet can lose progress. An indexer is the real fix (not built).
3. **Treasury:** none exists. `EXPO_PUBLIC_TREASURY` stays unset. It must be a purpose-made
   (preferably multisig) wallet, never a personal wallet. Until then upgrades are off.
4. **Issuer (SKR badge upgrades):** none exists. Before activation it needs: a production keypair held
   in a secret manager or HSM (never committed); the Core collection created on mainnet by that key; a
   persistent `ASSET_SECRET` (changing it changes every tier address); HTTPS hosting; authentication and
   per-client rate limiting (the current limit keys on the socket address, which is shared behind a
   proxy); caching of chain reads; monitoring; the app-side transaction check tightened to verify the
   Core instruction type, not just its program; and an end-to-end rehearsal on devnet with a real wallet.
   The server already refuses to start on a mainnet RPC unless the payment token is the SKR mint.
5. **Prices:** none are set. `PRICES_ARE_FINAL` stays false, so no price is shown and the upgrade
   button is absent.
6. **Prize pool:** dormant (`PAYOUT_GATE` is off and frozen; nothing in the app imports it). Payouts
   need the legal and platform review first.
7. **Anti-cheat:** the onchain record proves a wallet-signed, rule-consistent record, not that the game
   was played. An issuer that attests to runs would be needed for stronger guarantees.
