# solsafe

Pay-per-call Solana token facts, billed over [x402](https://x402.org).

Two endpoints. Callers pay a few cents in USDC per request. No API key, no signup, no dashboard.

| Endpoint | Price | Returns |
|---|---|---|
| `GET /safety/<mint>` | $0.02 | Authority flags, holder concentration, market depth — the raw measurements |
| `GET /brief/<mint>` | $0.15 | Those same facts plus a written explanation of what they establish, what is unusual, and what the data does not cover |

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
| `authority.supply` | Exact total supply, as a decimal **string** — see below |
| `holders.topHolderPct` | Share of supply in the largest accounts |
| `market.liquidityUsd` | Real pool depth, from the best-quoted pair |
| `market.quoteIsSane` | Is the USD price derived from a SOL/stable pair, or something exotic? |
| `market.pairAgeSeconds` | How long the pool has existed |
| `origin.pumpfun` | Did the mint originate on pump.fun? |
| `complete` | Was every section retrieved? |
| `unavailable` | Which sections were not, present only when something is missing |

### Facts, not verdicts

There is no safety score, no buy/sell signal, and no price prediction anywhere in the response.
Every field is a measured value or a boolean derived from one by a stated rule, so a caller can
re-run any of it against their own RPC and get the same answer. That reproducibility *is* the
product — an opinion can be wrong in a way `mintAuthority is null` cannot.

**Absence of a flag is not a guarantee of safety.** A token with every authority revoked and deep
liquidity can still go to zero.

### Why supply is a string

`Number(rawSupply) / 10 ** decimals` silently loses precision above 2^53. BONK's raw supply is
8.8e15, close enough that the float answer was already wrong: `87994598609146.64` against an exact
`87994598609146.64642`. Supply is computed with `BigInt` and returned as an exact decimal string.
A rounded number is indistinguishable from a fact, which is fatal for a service selling
reproducibility.

### Why `quoteIsSane` exists

Picking a token's pair by pool depth alone once found JUP's biggest pool quoted in MET, reporting
a price of **$943 against a real price of about $0.19** — a ~5000x error that silently poisons
everything downstream. Depth does not make a derived USD price trustworthy; what it is quoted
against does. So SOL/stablecoin-quoted pairs always outrank deeper exotic ones, and when the best
available pair is still exotic, the response says so in `market.priceCaveat` instead of quietly
handing over a wrong number.

### Partial answers, and who pays for them

A failed request never settles a payment. The x402 middleware runs the handler first and settles
only on a sub-400 response; anything else cancels the verified payment, so nothing is submitted
on chain. Concretely:

- **Both the holder and market lookups fail** → `502`, and the caller is **not charged**.
  Authority flags alone are not what this endpoint advertises.
- **One section is missing** → `200` with `complete: false`, the section named in `unavailable`,
  and the specific reason carried. Rate-limited, unsupported, and absent are different facts.
- **`/brief` fails for any reason** (including an exhausted model budget) → an error status, and
  the caller keeps their money.

This is why the handlers return error statuses rather than degrading to a `200` with a partial
body. Returning `200` with less than was promised would charge someone for it.

**Holder concentration is permanently unavailable for the most widely held tokens.** USDC and the
like exceed what `getTokenLargestAccounts` will scan, and the node rejects the query outright.
That is a property of the token, not a transient failure, and the response says so.

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
curl -i localhost:3000/safety/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
```

The 402's payment instructions ride in the `payment-required` **response header**, base64-encoded
JSON — hence `-i`. The body is an empty `{}`, which looks broken and is not.

## Tests

```bash
npm test
```

25 tests, no dependencies, offline, under a second. `checkMint` takes optional dependency seams so
the suite can drive failures that cannot be produced on demand against live infrastructure — a
rate-limited RPC, a DexScreener outage, both at once. Production always uses the defaults.

The two guards with money attached — exact supply arithmetic, and refusing to charge for an empty
answer — are mutation-tested: reintroducing each bug fails the suite. A test that cannot fail is
not a test.

## Turning payments on

1. Put a **public receiving address** on Base in `PAY_TO_ADDRESS`. This is a receive-only
   address — the kind you paste into someone's "send me money" box.
2. Leave `NETWORK=eip155:84532` (Base **Sepolia testnet**, valueless test USDC) and confirm the
   full `402 → pay → retry → settle` round trip works. `node test/pay.js` does exactly that, and
   refuses to run against mainnet.
3. Only then switch to `NETWORK=eip155:8453` (Base mainnet, real money) **and set CDP
   credentials** — see below.

> **This server never signs a transaction, never holds funds, and never needs a private key.**
> Nothing in `.env` is ever a secret key or seed phrase. If any guide tells you to put a private
> key in a server's `.env`, that guide is wrong.

### Mainnet needs a different facilitator

The facilitator verifies the payment signature and moves the USDC. **`x402.org/facilitator` is
testnet-only.** Pointing it at Base mainnet yields a service that looks perfectly healthy, returns
402 to every caller, and can never settle a single payment.

Mainnet requires a production facilitator. Set `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` from
[portal.cdp.coinbase.com](https://portal.cdp.coinbase.com) and the server switches to Coinbase's
facilitator automatically, ignoring `FACILITATOR_URL`. Free for the first 1,000 settlements per
month, then $0.001 each.

The server **refuses to start** on mainnet without those credentials. Failing at boot is better
than accepting money it cannot settle.

## The RPC problem

`solsafe` makes up to three Solana RPC calls per request: `getAccountInfo` (authorities),
`getTokenLargestAccounts` and `getTokenSupply` (concentration). The free public endpoint at
`api.mainnet-beta.solana.com` does not survive that — it selectively refuses the *expensive*
method while cheap ones sail through:

```
getAccountInfo          -> HTTP 200  ok
getTokenSupply          -> HTTP 200  ok
getTokenLargestAccounts -> HTTP 429  "Too many requests for a specific RPC call"
```

Use a dedicated provider (Helius, QuickNode, Triton, Alchemy) in `RPC_ENDPOINT`. A free keyed tier
is enough — the fix is a *dedicated* endpoint, not a *paid* one.

Even on a good provider, transient load-shedding happens: `-32603 account index service overloaded,
please try again` was observed in production, and an immediate retry succeeded. Transient failures
are retried up to three times with short backoff. Deterministic rejections are not retried, since
that would only add latency before reaching the same answer.

## Honest status

- Live on Base mainnet, settling through Coinbase's facilitator.
- The full `402 → pay → retry → settle` cycle is **proven end to end** on testnet, with two
  settled payments confirmed on chain.
- Mainnet settlement itself is **unproven** — verifying it requires a real payment, and no
  stranger has called the service yet.
- **Demand is unproven.** x402 is early. "Agents will pay for this" is an assumption, not a fact,
  and revenue could be zero. Nothing here is a projection of income.
