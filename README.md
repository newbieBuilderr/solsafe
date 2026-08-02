# solsafe

Pay-per-call Solana token safety facts, billed over [x402](https://x402.org).

`GET /safety/<mint>` returns what a token's authorities are, how concentrated its holders are,
and where and how deeply it trades. Callers pay a few cents in USDC per request. No API key,
no signup, no dashboard.

## Why anyone would pay for this

The buyer is an **autonomous agent**, not a person. An agent about to swap an unknown Solana
mint needs to know whether the supply can be inflated out from under it, and whether it could be
frozen out of selling. It cannot fill in a billing form to find out. x402 lets it pay per call
and move on, which is the entire wedge — the underlying facts are public, the frictionless
machine-payable access to them is not.

Free alternatives exist (RugCheck, GoPlus, Birdeye). They generally want an API key and a human
to sign up for one. That is the gap this fills. **It is a wedge, not a moat.**

## What it returns

```
GET /safety/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
```

| Field | Meaning |
|---|---|
| `authority.mintAuthorityActive` | Can supply still be inflated to infinity? |
| `authority.freezeAuthorityActive` | Can a holder's account be frozen so they can't sell? |
| `holders.topHolderPct` | Share of supply in the largest accounts |
| `market.liquidityUsd` | Real pool depth, from the best-quoted pair |
| `market.quoteIsSane` | Is the USD price derived from a SOL/stable pair, or something exotic? |
| `market.pairAgeSeconds` | How long the pool has existed |
| `origin.pumpfun` | Did the mint originate on pump.fun? |

### Facts, not verdicts

There is no safety score, no buy/sell signal, and no price prediction anywhere in the response.
Every field is a measured value or a boolean derived from one by a stated rule, so a caller can
re-run any of it against their own RPC and get the same answer. That reproducibility *is* the
product — an opinion can be wrong in a way `mintAuthority is null` cannot.

**Absence of a flag is not a guarantee of safety.** A token with every authority revoked and deep
liquidity can still go to zero.

### Why `quoteIsSane` exists

Picking a token's pair by pool depth alone once found JUP's biggest pool quoted in MET, reporting
a price of **$943 against a real price of about $0.19** — a ~5000x error that silently poisons
everything downstream. Depth does not make a derived USD price trustworthy; what it is quoted
against does. So SOL/stablecoin-quoted pairs always outrank deeper exotic ones, and when the best
available pair is still exotic, the response says so in `market.priceCaveat` instead of quietly
handing over a wrong number.

## Running it

```bash
npm install
cp .env.example .env
npm start
```

With `PAY_TO_ADDRESS` blank it runs in **free mode** — no paywall — so the check logic can be
tested before money is involved. That ordering is deliberate: the first time the logic runs
should not also be the first time a payment is involved.

```bash
curl -s localhost:3000/safety/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
```

### Turning payments on

1. Put a **public receiving address** on Base in `PAY_TO_ADDRESS`. This is a receive-only
   address — the kind you paste into someone's "send me money" box.
2. Leave `NETWORK=eip155:84532` (Base **Sepolia testnet**, valueless test USDC) and confirm the
   full `402 → pay → retry → settle` round trip works.
3. Only then switch to `NETWORK=eip155:8453` (Base mainnet, real money).

> **This server never signs a transaction, never holds funds, and never needs a private key.**
> Nothing in `.env` is ever a secret key or seed phrase. If any guide tells you to put a private
> key in a server's `.env`, that guide is wrong.

## The RPC problem

**This is the one operational thing that will break the service under real traffic.**

`solsafe` makes up to three Solana RPC calls per request: `getAccountInfo` (authorities),
`getTokenLargestAccounts` and `getTokenSupply` (concentration). The free public endpoint at
`api.mainnet-beta.solana.com` does not survive that.

It is not a theory — it is already happening. On the very first test against BONK:

```
getAccountInfo          -> HTTP 200  ok
getTokenSupply          -> HTTP 200  ok
getTokenLargestAccounts -> HTTP 429  "Too many requests for a specific RPC call"
```

The public node selectively refuses the *expensive* method while cheap ones sail through. So the
response degrades to:

```json
"holders": {
  "available": false,
  "reason": "RPC rate-limited (HTTP 429) -- the endpoint is refusing requests, not the token being bad"
}
```

That reason string is carried deliberately and never swallowed. "We were rate-limited" and "this
token has no holders" are entirely different facts about the world, and a caller who **paid** for
the response must never be handed the second when the truth was the first.

The fix is a dedicated RPC provider (Helius, QuickNode, Triton, Alchemy) in `RPC_ENDPOINT`. Most
have a free tier that already lifts this specific limit. Until that's set, treat
`holders.available: false` as the expected state rather than a bug.

## Honest status

- The check logic works and is tested against real mainnet tokens.
- The paywall is wired but has **not** yet been exercised end to end on testnet.
- **Demand is unproven.** x402 is early. "Agents will pay for this" is an assumption, not a fact,
  and revenue could be zero. Nothing here is a projection of income.
