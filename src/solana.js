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

/**
 * Whether a failure is worth trying again.
 *
 * Deliberately narrow. Retrying a deterministic rejection -- a malformed address, a token with
 * too many holders to index -- just burns latency the caller is waiting on and ends in the same
 * answer. Only load-shedding qualifies: `-32603 account index service overloaded, please try
 * again` was observed in production against BONK, where an immediate retry succeeded, and the
 * message says as much.
 */
function isTransient(message) {
  return /rate-limited|HTTP 429|HTTP 5\d\d|overloaded|try again|timeout|ETIMEDOUT|ECONNRESET|fetch failed/i
    .test(message);
}

const RPC_ATTEMPTS = 3;

async function rpcOnce(method, params) {
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

async function rpc(method, params) {
  let lastError;
  for (let attempt = 1; attempt <= RPC_ATTEMPTS; attempt++) {
    try {
      return await rpcOnce(method, params);
    } catch (e) {
      lastError = e;
      if (attempt === RPC_ATTEMPTS || !isTransient(e.message)) throw e;
      // Short backoff: the caller is blocked on this, and a paid request that takes ten seconds
      // to answer is its own kind of failure. 200ms then 600ms.
      await new Promise((r) => setTimeout(r, 200 * 3 ** (attempt - 1)));
    }
  }
  throw lastError;
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
    // Exact decimal string, not a float. `Number(raw) / 10 ** decimals` silently loses precision
    // above 2^53 (~9.0e15) -- BONK's raw supply is already 8.8e15, and a 9-decimal token with a
    // large supply would simply report a wrong number. A wrong number is worse than no number
    // for a service whose whole claim is that you can re-derive its answers yourself.
    supply: toDecimalString(info.supply, info.decimals),
  };
}

/**
 * Exact base-10 string for a raw integer amount and a decimal count, via BigInt.
 *
 * Returns a string rather than a number on purpose: some SPL supplies genuinely exceed what a
 * double can represent, and quietly rounding one would be indistinguishable from reporting a
 * fact. Callers who want arithmetic can parse it with full knowledge of the tradeoff.
 */
export function toDecimalString(rawAmount, decimals) {
  if (rawAmount == null || decimals == null) return null;
  let raw;
  try {
    raw = BigInt(rawAmount);
  } catch {
    return null;
  }
  if (decimals === 0) return raw.toString();

  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const fraction = (raw % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
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
  let result;
  try {
    result = await rpc("getTokenLargestAccounts", [mint]);
  } catch (e) {
    // Very widely held tokens (USDC, USDT) exceed what getTokenLargestAccounts will scan and the
    // node rejects the query outright. That is a permanent property of the token, not a transient
    // failure, and a caller who retries forever deserves to be told the difference. Verified
    // against USDC, which fails this way every time.
    if (/too many accounts/i.test(e.message)) {
      throw new Error(
        "this token has too many holders for the RPC's largest-accounts query, so concentration "
        + "cannot be computed for it -- this is permanent for tokens this widely held, not a "
        + "transient error worth retrying",
      );
    }
    throw e;
  }
  const accounts = result?.value || [];
  // Each no-data case carries its own reason. "Nobody holds this token" and "the supply is zero"
  // are different facts about the world, and collapsing them into one blank answer is exactly
  // the failure this service exists to avoid.
  if (accounts.length === 0) {
    return { available: false, reason: "the RPC returned no token accounts for this mint" };
  }

  const supplyResult = await rpc("getTokenSupply", [mint]);
  // Raw integer strings throughout -- see toDecimalString above for why floats are not safe here.
  // Percentages are derived by integer arithmetic in basis points, so the figure is exact for any
  // supply an SPL mint can express rather than merely close for small ones.
  let totalRaw;
  try {
    totalRaw = BigInt(supplyResult?.value?.amount ?? "0");
  } catch {
    return { available: false, reason: "RPC returned an unreadable supply value" };
  }
  if (totalRaw === 0n) {
    return { available: false, reason: "token supply is zero, so concentration is undefined" };
  }

  const amounts = accounts
    .map((a) => {
      try {
        return BigInt(a.amount ?? "0");
      } catch {
        return 0n;
      }
    })
    .sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));

  const top = amounts.slice(0, topN);
  const held = top.reduce((sum, n) => sum + n, 0n);

  const pct = (part) => Number((part * 1000000n) / totalRaw) / 10000;

  return {
    available: true,
    topN,
    accountsReturned: accounts.length,
    topHolderPct: round(pct(held), 2),
    largestHolderPct: round(pct(amounts[0]), 2),
  };
}

function round(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export const rpcEndpointInUse = RPC_ENDPOINT;
