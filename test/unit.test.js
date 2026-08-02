/**
 * Regression tests for the facts solsafe sells.
 *
 * Everything here runs offline and deterministically. That is the point: the failure modes worth
 * guarding -- a rate-limited RPC, a DexScreener outage, a token too widely held to query -- can't
 * be produced on demand against live infrastructure, so `checkMint` takes injectable dependencies
 * and the suite drives those branches directly.
 *
 *   npm test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { toDecimalString, looksLikeMint, getMintAuthorities } from "../src/solana.js";
import { rank, isPumpfunOrigin } from "../src/pairs.js";
import { checkMint } from "../src/safety.js";

// --- toDecimalString ------------------------------------------------------------------------
// The bug this guards: supply was computed as Number(raw) / 10 ** decimals, which silently loses
// precision past 2^53. Selling a number that doesn't reproduce is the worst defect this service
// can have, because reproducibility IS the product.

test("toDecimalString is exact past the float64 safe-integer limit", () => {
  // BONK, the case that exposed it. Float math reported ...146.64, dropping "642".
  assert.equal(toDecimalString("8799459860914664642", 5), "87994598609146.64642");
  assert.ok(Number("8799459860914664642") > Number.MAX_SAFE_INTEGER);
});

test("toDecimalString handles a supply far beyond what a double can hold", () => {
  // 1e27 raw at 9 decimals: a float would not even represent the input, let alone the quotient.
  assert.equal(toDecimalString("1000000000000000000000000000", 9), "1000000000000000000");
});

test("toDecimalString trims trailing fractional zeros but keeps significant ones", () => {
  assert.equal(toDecimalString("1500000", 6), "1.5");
  assert.equal(toDecimalString("1000000", 6), "1");
  assert.equal(toDecimalString("1000001", 6), "1.000001");
});

test("toDecimalString pads fractions narrower than the decimal count", () => {
  assert.equal(toDecimalString("1", 6), "0.000001");
});

test("toDecimalString passes zero-decimal amounts through unchanged", () => {
  assert.equal(toDecimalString("42", 0), "42");
});

test("toDecimalString returns null rather than guessing on bad input", () => {
  assert.equal(toDecimalString(null, 6), null);
  assert.equal(toDecimalString("100", null), null);
  assert.equal(toDecimalString("not-a-number", 6), null);
});

// --- RPC retry ------------------------------------------------------------------------------
// Observed in production: BONK returned "-32603 account index service overloaded, please try
// again" and an immediate retry succeeded. Without a retry, every such blip bills a caller full
// price for a response missing its holder section.

const withStubbedFetch = async (impl, run) => {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
};

const rpcReply = (payload) => ({ ok: true, status: 200, json: async () => payload });

test("a transient RPC overload is retried and succeeds", async () => {
  let calls = 0;
  await withStubbedFetch(
    async () => {
      calls++;
      if (calls === 1) {
        return rpcReply({ error: { code: -32603, message: "account index service overloaded, please try again" } });
      }
      return rpcReply({
        result: { value: { data: { parsed: { type: "mint", info: { decimals: 5, supply: "100000" } } } } },
      });
    },
    async () => {
      const r = await getMintAuthorities("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
      assert.equal(r.isMint, true);
      assert.equal(r.supply, "1");
    },
  );
  assert.equal(calls, 2, "should have retried exactly once");
});

test("a deterministic RPC rejection is not retried", async () => {
  let calls = 0;
  await withStubbedFetch(
    async () => {
      calls++;
      return rpcReply({ error: { code: -32602, message: "Invalid param: not a Token mint" } });
    },
    async () => {
      await assert.rejects(getMintAuthorities("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"));
    },
  );
  assert.equal(calls, 1, "must not burn the caller's latency retrying a permanent error");
});

test("retries are bounded rather than endless", async () => {
  let calls = 0;
  await withStubbedFetch(
    async () => {
      calls++;
      return { ok: false, status: 429, json: async () => ({}) };
    },
    async () => {
      await assert.rejects(getMintAuthorities("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"));
    },
  );
  assert.equal(calls, 3, "three attempts total, then give up");
});

// --- looksLikeMint --------------------------------------------------------------------------

test("looksLikeMint accepts real mints and rejects malformed input", () => {
  assert.equal(looksLikeMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"), true);
  assert.equal(looksLikeMint("not-a-mint"), false);
  assert.equal(looksLikeMint(""), false);
  assert.equal(looksLikeMint(null), false);
  assert.equal(looksLikeMint(12345), false);
  // 0, O, I and l are not in Solana's base58 alphabet.
  assert.equal(looksLikeMint("0OIl" + "1".repeat(36)), false);
});

// --- pair ranking ---------------------------------------------------------------------------
// The bug this guards cost real accuracy: ranking purely by pool depth picked JUP's biggest pool,
// quoted in MET, whose reported priceUsd was $943 against a real price near $0.19.

test("a SOL-quoted pair outranks a far deeper exotic-quoted one", () => {
  const exotic = { quoteToken: { symbol: "MET" }, liquidity: { usd: 50_000_000 } };
  const sane = { quoteToken: { symbol: "SOL" }, liquidity: { usd: 1_000 } };
  assert.ok(rank(sane) > rank(exotic), "sane quote must win regardless of depth");
});

test("among sane quotes, the deeper pool wins", () => {
  const shallow = { quoteToken: { symbol: "USDC" }, liquidity: { usd: 1_000 } };
  const deep = { quoteToken: { symbol: "SOL" }, liquidity: { usd: 900_000 } };
  assert.ok(rank(deep) > rank(shallow));
});

test("rank tolerates pairs missing quote or liquidity data", () => {
  assert.equal(Number.isFinite(rank({})), true);
});

// --- pump.fun origin ------------------------------------------------------------------------

test("isPumpfunOrigin recognises venue spellings and the surviving address suffix", () => {
  assert.equal(isPumpfunOrigin("abc", "pumpswap"), true);
  assert.equal(isPumpfunOrigin("abc", "PUMP-FUN"), true);
  // Suffix survives migration, so a pump.fun coin now on Raydium is still identifiable.
  assert.equal(isPumpfunOrigin("SomeMintAddresspump", "raydium"), true);
  assert.equal(isPumpfunOrigin("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "orca"), false);
  assert.equal(isPumpfunOrigin("abc", null), false);
});

// --- checkMint branches ---------------------------------------------------------------------

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

const workingAuthorities = async () => ({
  exists: true,
  isMint: true,
  mintAuthority: null,
  freezeAuthority: null,
  mintAuthorityActive: false,
  freezeAuthorityActive: false,
  decimals: 5,
  supplyRaw: "8799459860914664642",
  supply: "87994598609146.64642",
});

const workingHolders = async () => ({
  available: true,
  topN: 10,
  accountsReturned: 20,
  topHolderPct: 37.78,
  largestHolderPct: 7.68,
});

const workingPair = async () => ({
  available: true,
  pairsFound: 30,
  symbol: "Bonk",
  name: "Bonk",
  dexId: "orca",
  pairAddress: "5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9",
  quoteSymbol: "SOL",
  quoteIsSane: true,
  priceUsd: 0.000002892,
  liquidityUsd: 113811.46,
  volume24hUsd: 192787.71,
  priceChange5m: -0.05,
  pairCreatedAt: 1672000000000,
  pairAgeSeconds: 113713745,
});

const expectStatus = async (promise, status) => {
  await assert.rejects(promise, (e) => {
    assert.equal(e.status, status, `expected HTTP ${status}, got ${e.status}: ${e.message}`);
    return true;
  });
};

test("rejects a malformed address before spending an RPC call", async () => {
  let called = false;
  await expectStatus(
    checkMint("nope", { getMintAuthorities: async () => { called = true; } }),
    400,
  );
  assert.equal(called, false, "must not hit the RPC for input it can reject locally");
});

test("a missing account is a 404, not a fabricated empty answer", async () => {
  await expectStatus(
    checkMint(MINT, { getMintAuthorities: async () => ({ exists: false }) }),
    404,
  );
});

test("a non-mint account is a 400", async () => {
  await expectStatus(
    checkMint(MINT, { getMintAuthorities: async () => ({ exists: true, isMint: false }) }),
    400,
  );
});

test("an unreadable mint account is a 502, so the caller is not charged", async () => {
  await expectStatus(
    checkMint(MINT, {
      getMintAuthorities: async () => { throw new Error("RPC rate-limited (HTTP 429)"); },
    }),
    502,
  );
});

test("both follow-up lookups failing is a 502 rather than a billed stub", async () => {
  // The branch that could not be produced against live infrastructure, and the one with money
  // attached: settlement happens only on a sub-400 response.
  await expectStatus(
    checkMint(MINT, {
      getMintAuthorities: workingAuthorities,
      getHolderConcentration: async () => { throw new Error("RPC rate-limited (HTTP 429)"); },
      getBestPair: async () => { throw new Error("DexScreener unreachable"); },
    }),
    502,
  );
});

test("the 502 for a doubly-failed lookup names both underlying reasons", async () => {
  await assert.rejects(
    checkMint(MINT, {
      getMintAuthorities: workingAuthorities,
      getHolderConcentration: async () => { throw new Error("rate-limited-marker"); },
      getBestPair: async () => { throw new Error("dexscreener-marker"); },
    }),
    (e) => {
      assert.match(e.message, /rate-limited-marker/);
      assert.match(e.message, /dexscreener-marker/);
      return true;
    },
  );
});

test("missing holder data yields a partial answer flagged as incomplete", async () => {
  const r = await checkMint(MINT, {
    getMintAuthorities: workingAuthorities,
    getHolderConcentration: async () => { throw new Error("too many holders to query"); },
    getBestPair: workingPair,
  });
  assert.equal(r.complete, false);
  assert.deepEqual(r.unavailable, ["holders"]);
  assert.equal(r.holders.available, false);
  // The specific reason must survive: "we were rate-limited" and "this token has no holders" are
  // different facts, and a paying caller must never be handed the second when it was the first.
  assert.match(r.holders.reason, /too many holders/);
  assert.equal(r.market.liquidityUsd, 113811.46);
});

test("a failed market lookup carries the real error, not a hardcoded string", async () => {
  const r = await checkMint(MINT, {
    getMintAuthorities: workingAuthorities,
    getHolderConcentration: workingHolders,
    getBestPair: async () => { throw new Error("connect ETIMEDOUT 1.2.3.4:443"); },
  });
  assert.equal(r.complete, false);
  assert.deepEqual(r.unavailable, ["market"]);
  assert.match(r.market.reason, /ETIMEDOUT/);
});

test("a fully successful check is marked complete and omits the unavailable list", async () => {
  const r = await checkMint(MINT, {
    getMintAuthorities: workingAuthorities,
    getHolderConcentration: workingHolders,
    getBestPair: workingPair,
  });
  assert.equal(r.complete, true);
  assert.equal("unavailable" in r, false);
  assert.equal(r.authority.supply, "87994598609146.64642");
  assert.equal(r.holders.topHolderPct, 37.78);
  assert.equal(r.market.quoteIsSane, true);
  assert.equal(r.market.priceCaveat, null);
});

test("an exotic quote attaches a price caveat instead of quietly trusting the price", async () => {
  const r = await checkMint(MINT, {
    getMintAuthorities: workingAuthorities,
    getHolderConcentration: workingHolders,
    getBestPair: async () => ({ ...(await workingPair()), quoteSymbol: "MET", quoteIsSane: false }),
  });
  assert.match(r.market.priceCaveat, /may be badly wrong/);
});

test("the response exposes no score, rating, or verdict field", async () => {
  // The product boundary, asserted rather than assumed. Adding any of these would break both the
  // reproducibility claim and the reason this stays clear of investment advice.
  //
  // Checks field NAMES, not a substring of the serialised body: the disclaimer legitimately
  // contains the word "recommendation" (as in, there isn't one), and a naive text search cannot
  // tell prose from a key.
  const r = await checkMint(MINT, {
    getMintAuthorities: workingAuthorities,
    getHolderConcentration: workingHolders,
    getBestPair: workingPair,
  });

  const keys = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        keys.push(k.toLowerCase());
        walk(v);
      }
    }
  };
  walk(r);

  for (const forbidden of ["score", "rating", "recommendation", "verdict", "signal", "advice"]) {
    const offenders = keys.filter((k) => k.includes(forbidden));
    assert.deepEqual(offenders, [], `response must expose no "${forbidden}" field`);
  }
  assert.match(r.disclaimer, /not financial advice/);
});
