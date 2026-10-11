# Rugrat issuer (SKR badge upgrades)

A tiny Node service that sells **cosmetic** Rug Hunter tier badges. It never touches scores,
rankings or prizes, and it contains **no payout code**.

## What it does
`POST /v1/upgrade/prepare {wallet, tier}`:
1. reads the wallet's score records **from the chain** and re-derives how many unique rugs it survived
   (the app's claim is never trusted);
2. refuses unless the tier's requirement is met (3 / 7 / 15 unique surviving rugs) and the wallet does
   not already own that tier;
3. returns ONE transaction: *pay the tier price in the payment token to the treasury* + *memo* +
   *mint the tier badge* (Metaplex Core, in the issuer's collection, frozen/soulbound). The issuer
   signs its part; the player signs last. Payment and badge are atomic: no pay-without-badge.

The app checks the returned transaction against **its own** config (treasury, token, price) before it
asks the wallet to sign, so a bad server cannot redirect a payment.

## Run on devnet (test token standing in for SKR)
```
npm run server:setup-devnet     # creates keys, a test token, the collection; prints env vars
# set the printed env vars, then:
npm run server:start
```
In the app build set `EXPO_PUBLIC_ISSUER_URL`, `EXPO_PUBLIC_PAYMENT_MINT`, `EXPO_PUBLIC_TREASURY`
and `EXPO_PUBLIC_SOLANA_CLUSTER=devnet`. Without them the upgrade section says upgrades are unavailable.

## Before real SKR
Prices in `src/upgrade/tiers.ts` are **placeholders**. Mainnet needs: the real treasury address, the
SKR mint (`src/skr/config.ts`), a real price list, HTTPS hosting, key custody for the issuer, and the
legal / platform review for anything beyond cosmetic sales. Keep `.keys/` out of git.
