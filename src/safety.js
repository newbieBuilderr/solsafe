/**
 * Combines the on-chain facts and the market facts into one response.
 *
 * Design rule, and the reason this service is sellable at all: FLAGS ARE NOT VERDICTS. Every
 * field below is either a measured value or a boolean derived from one by a stated rule. There
 * is no score, no "safe/unsafe" judgement, and no recommendation to buy or avoid anything --
 * those would be opinions, and an opinion can be wrong in a way "mintAuthority is null" cannot.
 * The caller applies their own thresholds; we tell them what is true.
 */

import { getMintAuthorities, getHolderConcentration, looksLikeMint } from "./solana.js";
import { getBestPair, isPumpfunOrigin } from "./pairs.js";

export async function checkMint(mint) {
  if (!looksLikeMint(mint)) {
    const err = new Error("not a valid Solana address (expected 32-44 base58 characters)");
    err.status = 400;
    throw err;
  }

  // Both halves are independent, so failure of one shouldn't cost the other. allSettled rather
  // than all: a DexScreener outage must not turn a perfectly good authority check into a 500.
  const [authResult, pairResult] = await Promise.allSettled([
    getMintAuthorities(mint),
    getBestPair(mint),
  ]);

  if (authResult.status === "rejected") {
    const err = new Error(`could not read mint account: ${authResult.reason.message}`);
    err.status = 502;
    throw err;
  }

  const auth = authResult.value;
  if (!auth.exists) {
    const err = new Error("no account exists at this address on mainnet");
    err.status = 404;
    throw err;
  }
  if (!auth.isMint) {
    const err = new Error("this address is a Solana account but not an SPL token mint");
    err.status = 400;
    throw err;
  }

  // Concentration is a second and third RPC call, so it's only worth making once we know the
  // address really is a mint.
  let holders = { available: false };
  try {
    holders = await getHolderConcentration(mint);
  } catch (e) {
    // The reason is carried, never swallowed. "We were rate-limited" and "this token has no
    // holders" are completely different facts about the world, and a caller paying for this
    // must never be handed the second when the truth was the first.
    holders = { available: false, reason: e.message };
  }

  const pair = pairResult.status === "fulfilled"
    ? pairResult.value
    : { available: false, reason: "pair lookup failed" };

  return {
    mint,
    checkedAt: new Date().toISOString(),

    authority: {
      mintAuthorityActive: auth.mintAuthorityActive,
      freezeAuthorityActive: auth.freezeAuthorityActive,
      mintAuthority: auth.mintAuthority,
      freezeAuthority: auth.freezeAuthority,
      decimals: auth.decimals,
      supply: auth.supply,
      // Spelled out so the caller doesn't have to know SPL semantics to use the response.
      meaning: {
        mintAuthorityActive: auth.mintAuthorityActive
          ? "holder of this key can mint unlimited new supply at any time"
          : "revoked -- supply cannot be increased",
        freezeAuthorityActive: auth.freezeAuthorityActive
          ? "holder of this key can freeze any token account, blocking holders from selling"
          : "revoked -- accounts cannot be frozen",
      },
    },

    holders: holders.available
      ? {
          topHolderPct: holders.topHolderPct,
          largestHolderPct: holders.largestHolderPct,
          topN: holders.topN,
          accountsSampled: holders.accountsReturned,
          note: "the liquidity pool is normally among the largest holders, so a high figure is "
            + "not by itself evidence of anything -- read it alongside who the holders are",
        }
      : { available: false, reason: holders.reason || "holder data unavailable" },

    market: pair.available
      ? {
          symbol: pair.symbol,
          name: pair.name,
          dexId: pair.dexId,
          pairAddress: pair.pairAddress,
          priceUsd: pair.priceUsd,
          quoteSymbol: pair.quoteSymbol,
          quoteIsSane: pair.quoteIsSane,
          liquidityUsd: pair.liquidityUsd,
          volume24hUsd: pair.volume24hUsd,
          priceChange5m: pair.priceChange5m,
          pairAgeSeconds: pair.pairAgeSeconds,
          pairsFound: pair.pairsFound,
          priceCaveat: pair.quoteIsSane
            ? null
            : "this pair is quoted in a token that is not SOL or a major stablecoin, so its "
              + "derived USD price may be badly wrong -- verify before relying on it",
        }
      : { available: false, reason: pair.reason },

    origin: {
      pumpfun: isPumpfunOrigin(mint, pair.available ? pair.dexId : null),
    },

    disclaimer:
      "solsafe returns verifiable on-chain and public market data. It contains no "
      + "recommendation to buy, sell, or avoid any asset, makes no prediction of price, and is "
      + "not financial advice. Absence of a flag is not a guarantee of safety: a token with every "
      + "authority revoked and deep liquidity can still lose all its value.",
  };
}
