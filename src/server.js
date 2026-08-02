/**
 * solsafe -- a pay-per-call Solana token safety endpoint, billed over x402.
 *
 * Sells verifiable facts: what a mint's authorities are, how concentrated its holders are, and
 * where and how deeply it trades. No forecasts, no scores, no advice -- see safety.js for why
 * that boundary is the product rather than a limitation.
 *
 * Payment model: a caller hits /safety/<mint> with no payment and gets HTTP 402 plus machine-
 * readable instructions. They pay USDC on Base, retry with the payment header, and get the data.
 * No signup, no API key, no dashboard -- which is the entire reason an autonomous agent can use
 * this and can't use a service that requires a human to fill in a billing form.
 */

import "dotenv/config";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

import { facilitator as cdpFacilitator } from "@coinbase/x402";

import { checkMint } from "./safety.js";
import { generateBrief } from "./brief.js";
import { rpcEndpointInUse } from "./solana.js";

const PORT = process.env.PORT || 3000;
const PAY_TO = process.env.PAY_TO_ADDRESS;
const PRICE = process.env.PRICE || "$0.02";
// Higher than the raw endpoint because it costs real money to serve: model tokens, unlike
// DexScreener and an RPC read, are a per-call expense. At ~$0.05 of Opus 5 tokens per brief
// (measured, not estimated) this leaves roughly 65% margin. See brief.js for the arithmetic
// and the cheaper models.
const BRIEF_PRICE = process.env.BRIEF_PRICE || "$0.15";

// CAIP-2 chain ids. Base Sepolia is a real network with valueless test USDC, which is the whole
// point of defaulting to it: the full 402 -> pay -> retry -> settle path can be exercised end to
// end without a cent of real money moving. Flip NETWORK to eip155:8453 for Base mainnet only
// once that round trip has actually been seen working.
const NETWORK = process.env.NETWORK || "eip155:84532";
const IS_MAINNET = NETWORK === "eip155:8453";
const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://x402.org/facilitator";

const app = express();

// Behind Render's (or any) reverse proxy, so req.protocol reflects the original https rather
// than the http hop inside the platform's network. Without this the landing page advertises
// http:// URLs for an https-only service.
app.set("trust proxy", true);

// --- Free routes ------------------------------------------------------------------------
// Registered before the payment middleware so they are never gated. A service that charges for
// its own documentation cannot be discovered by the agents meant to buy from it.

app.get("/health", (_req, res) => {
  // payTo is published deliberately: it already appears in every 402 challenge, and surfacing it
  // here lets a caller confirm where their money would go before spending anything. A receiving
  // address is public by nature -- there is nothing here to protect.
  res.json({
    ok: true,
    network: NETWORK,
    mainnet: IS_MAINNET,
    priced: Boolean(PAY_TO),
    payTo: PAY_TO ?? null,
  });
});

app.get("/", (req, res) => {
  // Derived from the request, not from PORT. The old version interpolated the listening port,
  // which is correct locally and useless in production -- a deployed page told every visitor to
  // curl localhost:10000. A caller needs the address they actually reached us on.
  const base = `${req.protocol}://${req.get("host")}`;
  res.type("html").send(`<!doctype html>
<meta charset="utf-8"><title>solsafe -- Solana token safety, per call</title>
<style>
 body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1.2rem;
      background:#0d0f0d;color:#d7e3d7}
 h1{font-size:1.5rem;margin-bottom:.2rem} code,pre{background:#161a16;color:#8fe08f}
 pre{padding:.9rem;overflow-x:auto;border-radius:6px} code{padding:.1rem .3rem;border-radius:3px}
 .m{color:#7d8c7d} a{color:#8fe08f} table{border-collapse:collapse;width:100%;margin:1rem 0}
 td,th{text-align:left;padding:.35rem .6rem;border-bottom:1px solid #232823}
</style>
<h1>solsafe</h1>
<p class="m">Verifiable Solana token facts, billed per request over x402. No API key. No signup.</p>

<h2>Endpoints</h2>
<pre>GET /safety/&lt;mint&gt;    ${PRICE} per call
GET /brief/&lt;mint&gt;     ${BRIEF_PRICE} per call</pre>
<p>Call either without payment and you get <code>402</code> plus instructions. Pay, retry, get JSON.</p>
<p><code>/safety</code> returns the raw measurements. <code>/brief</code> returns those same measurements
plus a written explanation of what they establish, what is unusual about this particular token, and
what the data does not cover. The brief is generated per call, which is why it costs more.</p>

<h2>What you get</h2>
<table>
<tr><th>Field</th><th>Meaning</th></tr>
<tr><td><code>authority.mintAuthorityActive</code></td><td>Can supply still be inflated to infinity?</td></tr>
<tr><td><code>authority.freezeAuthorityActive</code></td><td>Can your token account be frozen so you can't sell?</td></tr>
<tr><td><code>holders.topHolderPct</code></td><td>Share of supply in the largest accounts. Unavailable for extremely
widely held tokens (USDC and the like), where the RPC refuses the query — the response says so
and sets <code>complete: false</code> rather than guessing.</td></tr>
<tr><td><code>market.liquidityUsd</code></td><td>Real pool depth, from the best-quoted pair</td></tr>
<tr><td><code>market.quoteIsSane</code></td><td>Whether the USD price is derived from a SOL/stable pair, or something exotic and unreliable</td></tr>
<tr><td><code>origin.pumpfun</code></td><td>Whether the mint originated on pump.fun</td></tr>
</table>

<h2>Partial answers</h2>
<p>Every response carries <code>complete</code>. When a section could not be retrieved it is listed
in <code>unavailable</code> and carries the specific reason — rate-limited, unsupported, or absent
are different facts and are reported as such. If <em>both</em> the holder and market lookups fail
the call returns <code>502</code> and <strong>you are not charged</strong>; a failed or errored
request never settles a payment.</p>

<h2>What it is not</h2>
<p>solsafe returns facts, not opinions. There is no safety score, no buy/sell signal, and no price
prediction anywhere in the response. Every flag is a measured value or a boolean derived from one
by a stated rule, so you can re-run any of it against your own RPC and get the same answer.
Absence of a flag is not a guarantee of safety.</p>

<h2>Try it</h2>
<pre>curl -i ${base}/safety/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263</pre>
<p class="m">That returns <code>402</code>. The payment instructions are in the
<code>payment-required</code> response header, base64-encoded JSON — which is why <code>-i</code>
matters, and why the body is an empty <code>{}</code>. Decode it to see the amount, the asset,
and the address to pay.</p>
<p class="m">Network: ${NETWORK}${IS_MAINNET ? " (mainnet -- real USDC)" : " (testnet -- valueless test USDC)"}</p>
`);
});

// --- Paid route -------------------------------------------------------------------------

// --- Facilitator selection ----------------------------------------------------------------
// The facilitator verifies signatures and moves the USDC. This is NOT interchangeable across
// networks: the public sandbox at x402.org/facilitator serves testnets only, and pointing it at
// Base mainnet silently yields a service that 402s every caller and can never settle. Mainnet
// needs a production facilitator -- Coinbase's CDP one, which authenticates with an API key
// pair and is free for the first 1,000 settlements a month.
const USE_CDP = Boolean(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET);

// Refuse to boot rather than accept money we cannot settle. Without this the failure is
// invisible from the outside: the paywall looks healthy, every caller is told to pay, and not
// one payment can complete.
if (IS_MAINNET && !USE_CDP) {
  console.error("[solsafe] REFUSING TO START: NETWORK is Base mainnet but no CDP credentials are set.");
  console.error("[solsafe] The public x402.org facilitator is testnet-only and cannot settle mainnet payments.");
  console.error("[solsafe] Set CDP_API_KEY_ID and CDP_API_KEY_SECRET, or set NETWORK back to eip155:84532.");
  process.exit(1);
}

if (PAY_TO) {
  const facilitatorClient = new HTTPFacilitatorClient(
    USE_CDP ? cdpFacilitator : { url: FACILITATOR_URL },
  );
  const resourceServer = new x402ResourceServer(facilitatorClient)
    .register(NETWORK, new ExactEvmScheme());

  app.use(
    paymentMiddleware(
      {
        "GET /safety/*": {
          accepts: {
            scheme: "exact",
            price: PRICE,
            network: NETWORK,
            payTo: PAY_TO,
            maxTimeoutSeconds: 60,
          },
          description: "Verifiable safety and liquidity facts for one Solana SPL token mint",
        },
        "GET /brief/*": {
          accepts: {
            scheme: "exact",
            price: BRIEF_PRICE,
            network: NETWORK,
            payTo: PAY_TO,
            // Longer than the raw endpoint's: this one waits on a model round trip as well as
            // the RPC and pair lookups.
            maxTimeoutSeconds: 240,
          },
          description: "Agent-written due-diligence brief explaining one Solana token's facts",
          // Raised from 120s. The window has to cover a cold start on a sleeping free-tier host
          // (~60s) plus a model round trip (~30s observed). If it expires we have already paid
          // for the model tokens and cannot settle -- the one failure mode here that costs us
          // rather than the caller.
        },
      },
      resourceServer,
    ),
  );
  console.log(`[solsafe] paid mode: ${PRICE}/call on ${NETWORK} -> ${PAY_TO}`);
  // Report the facilitator and the money separately. Conflating them was misleading: CDP also
  // serves Sepolia, so "CDP" does not imply real funds -- NETWORK decides that.
  console.log(
    USE_CDP
      ? "[solsafe] facilitator: Coinbase CDP"
      : `[solsafe] facilitator: ${FACILITATOR_URL} (public sandbox, TESTNET ONLY)`,
  );
  console.log(
    IS_MAINNET
      ? "[solsafe] *** MAINNET -- payments are REAL money ***"
      : "[solsafe] testnet -- payments are valueless test USDC",
  );
} else {
  // Deliberately still serves, unpriced, instead of refusing to boot. The whole service must be
  // testable before a receiving address exists -- otherwise the first time the check logic runs
  // is also the first time money is involved, which is the wrong order to debug things in.
  console.log("[solsafe] FREE MODE: PAY_TO_ADDRESS not set, so /safety is not behind a paywall.");
  console.log("[solsafe] Set PAY_TO_ADDRESS in .env to switch payments on.");
}

app.get("/safety/:mint", async (req, res) => {
  try {
    res.json(await checkMint(req.params.mint));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, mint: req.params.mint });
  }
});

// A caller is never charged for a failed brief. The payment middleware runs this handler first
// and only settles when it returns under 400; on a throw or any error status it cancels the
// verified payment instead, so nothing is submitted on chain. Verified empirically against a
// deliberately broken key: the response was a 401 and the payer's balance did not move.
//
// The practical consequence: when the Anthropic credit runs dry, callers get an error and keep
// their money. Returning an error status here is therefore the correct behaviour, not a
// fallback -- never swallow a failure and return 200 with a degraded body, because that WOULD
// charge them for nothing.
app.get("/brief/:mint", async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    // Said plainly rather than surfaced as a generic 500: a paying caller must never be billed
    // for a failure that is entirely our own missing configuration.
    return res.status(503).json({
      error: "brief endpoint unconfigured: ANTHROPIC_API_KEY is not set",
      mint: req.params.mint,
    });
  }
  try {
    res.json(await generateBrief(req.params.mint));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, mint: req.params.mint });
  }
});

app.listen(PORT, () => {
  console.log(`[solsafe] listening on http://localhost:${PORT}`);
  console.log(`[solsafe] RPC: ${rpcEndpointInUse}`);
  if (rpcEndpointInUse.includes("api.mainnet-beta.solana.com")) {
    console.log("[solsafe] WARNING: public RPC -- rate-limits hard, fine for testing, not for traffic.");
  }
});
