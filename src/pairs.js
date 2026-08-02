/**
 * Market-side facts: where a mint actually trades, how deep the pool is, how old it is.
 *
 * Sourced from DexScreener's public API (free, no key). This is the half of the answer the RPC
 * can't give -- authority flags say a token CAN'T be inflated, they say nothing about whether
 * you could sell it.
 */

const DEXSCREENER_TOKENS_URL = "https://api.dexscreener.com/latest/dex/tokens/";

/**
 * Quote tokens whose pools produce a USD price worth believing.
 *
 * This exists because of a real, expensive failure, not caution: picking a token's pair purely
 * by pool depth found JUP's biggest pool quoted in MET, whose reported priceUsd was $943 against
 * a real price of about $0.19. A ~5000x error, and everything downstream inherits it. Depth does
 * not make a derived USD price trustworthy; what it is quoted against does. So SOL/stable-quoted
 * pairs outrank deeper exotic ones, always.
 */
const SANE_QUOTE_SYMBOLS = new Set(["SOL", "WSOL", "USDC", "USDT"]);

export async function getBestPair(mint) {
  let data;
  try {
    const resp = await fetch(DEXSCREENER_TOKENS_URL + mint, {
      headers: { Accept: "application/json", "User-Agent": "solsafe/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return { available: false, reason: `DexScreener HTTP ${resp.status}` };
    data = await resp.json();
  } catch (e) {
    return { available: false, reason: `DexScreener unreachable: ${e.message}` };
  }

  // Only pairs where this mint is the BASE token: DexScreener's price math is base-oriented, so
  // reading a pair where our mint is the quote side gives the inverse of what the caller asked.
  const candidates = (data?.pairs || []).filter(
    (p) => p.chainId === "solana" && p.baseToken?.address === mint,
  );
  if (candidates.length === 0) {
    return { available: false, reason: "no Solana pair found for this mint" };
  }

  const best = candidates.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  const quoteSymbol = (best.quoteToken?.symbol || "").toUpperCase();

  return {
    available: true,
    pairsFound: candidates.length,
    symbol: best.baseToken?.symbol ?? null,
    name: best.baseToken?.name ?? null,
    dexId: best.dexId ?? null,
    pairAddress: best.pairAddress ?? null,
    quoteSymbol: quoteSymbol || null,
    // Stated so the caller can discount the price themselves rather than trusting it blindly.
    quoteIsSane: SANE_QUOTE_SYMBOLS.has(quoteSymbol),
    priceUsd: best.priceUsd != null ? Number(best.priceUsd) : null,
    liquidityUsd: best.liquidity?.usd ?? null,
    volume24hUsd: best.volume?.h24 ?? null,
    priceChange5m: best.priceChange?.m5 ?? null,
    pairCreatedAt: best.pairCreatedAt ?? null,
    pairAgeSeconds: best.pairCreatedAt ? Math.round(Date.now() / 1000 - best.pairCreatedAt / 1000) : null,
  };
}

/** Sane quote first, then depth. Array comparison isn't available, so pack into one number. */
function rank(pair) {
  const quoteSymbol = (pair.quoteToken?.symbol || "").toUpperCase();
  const liquidity = pair.liquidity?.usd || 0;
  return (SANE_QUOTE_SYMBOLS.has(quoteSymbol) ? 1e15 : 0) + liquidity;
}

/**
 * pump.fun venues, under both providers' spellings. Reported as a plain fact about origin --
 * the caller decides what it means to them.
 */
const PUMPFUN_DEX_IDS = new Set(["pumpfun", "pump-fun", "pumpswap", "pump-swap", "pumpamm", "pump-amm"]);

export function isPumpfunOrigin(mint, dexId) {
  if (PUMPFUN_DEX_IDS.has((dexId || "").toLowerCase())) return true;
  // The address suffix survives migration, so a launched-on-pump.fun coin now quoted on Raydium
  // is still identifiable.
  return typeof mint === "string" && mint.endsWith("pump");
}
