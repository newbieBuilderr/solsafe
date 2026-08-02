/**
 * On-chain facts about an SPL token mint, straight from a Solana RPC node.
 *
 * Everything here is deliberately *verifiable*: mint authority is either present in the account
 * data or it isn't. Nothing in this file predicts, scores, or opines -- that separation is the
 * whole product. A caller can re-run any of these queries against their own RPC and get the
 * same answer, which is what makes the response worth paying for.
 */

const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";

/** Solana's base58 addresses are 32-44 chars from a restricted alphabet (no 0, O, I, l). */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function looksLikeMint(address) {
  return typeof address === "string" && BASE58_RE.test(address);
}

async function rpc(method, params) {
  const resp = await fetch(RPC_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    // 429 is the public endpoint's signature failure mode and the single most likely thing to
    // break this service under real traffic. Named explicitly so it can't be mistaken for a
    // problem with the mint being queried.
    throw new Error(
      resp.status === 429
        ? "RPC rate-limited (HTTP 429) -- the endpoint is refusing requests, not the token being bad"
        : `RPC HTTP ${resp.status}`,
    );
  }

  const body = await resp.json();
  if (body.error) throw new Error(`RPC error ${body.error.code}: ${body.error.message}`);
  return body.result;
}

/**
 * Mint/freeze authority and supply.
 *
 * Why these two matter, stated plainly so the response can explain itself: an active mint
 * authority means whoever holds it can create unlimited new supply at any moment, diluting
 * every existing holder to nothing. An active freeze authority means they can freeze any
 * holder's token account, so a holder can be blocked from ever selling. Both are ordinary
 * SPL-token features with legitimate uses -- and both are also the cleanest rug vectors that
 * exist, which is why "is it null" is worth one RPC call before touching a token.
 */
export async function getMintAuthorities(mint) {
  const result = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
  if (!result?.value) return { exists: false };

  const parsed = result.value.data?.parsed;
  if (parsed?.type !== "mint") {
    return { exists: true, isMint: false };
  }

  const info = parsed.info || {};
  return {
    exists: true,
    isMint: true,
    // Absent/null in the parsed account means the authority was revoked -- the safe state.
    mintAuthority: info.mintAuthority ?? null,
    freezeAuthority: info.freezeAuthority ?? null,
    mintAuthorityActive: Boolean(info.mintAuthority),
    freezeAuthorityActive: Boolean(info.freezeAuthority),
    decimals: info.decimals ?? null,
    supplyRaw: info.supply ?? null,
    supply: info.supply != null && info.decimals != null
      ? Number(info.supply) / 10 ** info.decimals
      : null,
  };
}

/**
 * Share of supply held by the largest accounts.
 *
 * Read this number with care, and the response says so too: on Solana the liquidity pool itself
 * is usually one of the largest holders, so a healthy token routinely shows a big top-10 figure.
 * A high number is a reason to look at WHO the holders are, not proof of anything on its own.
 * getTokenLargestAccounts returns at most 20 accounts, so this is top-N of those, never a full
 * holder census.
 */
export async function getHolderConcentration(mint, topN = 10) {
  const result = await rpc("getTokenLargestAccounts", [mint]);
  const accounts = result?.value || [];
  if (accounts.length === 0) return { available: false };

  const supplyResult = await rpc("getTokenSupply", [mint]);
  const totalSupply = Number(supplyResult?.value?.uiAmount || 0);
  if (!totalSupply) return { available: false };

  const amounts = accounts
    .map((a) => Number(a.uiAmount || 0))
    .sort((a, b) => b - a);
  const top = amounts.slice(0, topN);
  const held = top.reduce((sum, n) => sum + n, 0);

  return {
    available: true,
    topN,
    accountsReturned: accounts.length,
    topHolderPct: round(held / totalSupply * 100, 2),
    largestHolderPct: round(amounts[0] / totalSupply * 100, 2),
  };
}

function round(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export const rpcEndpointInUse = RPC_ENDPOINT;
