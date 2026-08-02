/**
 * Exercises the full x402 cycle against a running solsafe: call, get 402, pay, retry, get data.
 *
 * This is the only part of the system that spends anything, so it is deliberately kept separate
 * from the server and pinned to testnet. It refuses to run against Base mainnet -- see the guard
 * below. The server never signs anything; only this test client holds a key, and that key is a
 * throwaway that guards nothing but valueless faucet tokens.
 *
 *   node test/pay.js                          # localhost, /safety
 *   node test/pay.js --url https://...        # a deployed instance
 *   node test/pay.js --endpoint brief         # the expensive one
 */

import "dotenv/config";
import { readFileSync } from "node:fs";

import { createPublicClient, http, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";

// Base Sepolia test USDC. Worthless by construction -- this is the whole reason we start here.
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NETWORK = "eip155:84532";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const baseUrl = arg("url", "http://localhost:3000").replace(/\/$/, "");
const endpoint = arg("endpoint", "safety");
const mint = arg("mint", BONK);

// The key lives in .env.test, which is gitignored and holds nothing of value. Read directly
// rather than through dotenv so a missing file produces a useful message instead of a crash.
function loadKey() {
  let raw;
  try {
    raw = readFileSync(new URL("../.env.test", import.meta.url), "utf8");
  } catch {
    console.error("No .env.test found. It should contain TEST_BUYER_KEY=0x...");
    process.exit(1);
  }
  const m = raw.match(/^TEST_BUYER_KEY=(0x[0-9a-fA-F]{64})\s*$/m);
  if (!m) {
    console.error("TEST_BUYER_KEY missing or malformed in .env.test");
    process.exit(1);
  }
  return m[1];
}

const account = privateKeyToAccount(loadKey());
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });

console.log(`buyer   : ${account.address}`);
console.log(`target  : ${baseUrl}/${endpoint}/${mint}`);

// --- Refuse to spend real money -----------------------------------------------------------
// A test script that quietly works against mainnet is how testnet discipline dies. If the
// server we are pointed at is not on Sepolia, stop rather than sign.
const probe = await fetch(`${baseUrl}/health`).catch((e) => {
  console.error(`\nCannot reach ${baseUrl} -- ${e.message}`);
  process.exit(1);
});
const health = await probe.json();
if (health.network !== NETWORK) {
  console.error(`\nREFUSING TO RUN: server is on ${health.network}, not ${NETWORK} (Base Sepolia).`);
  console.error("This script signs payments and will not do so outside testnet.");
  process.exit(1);
}
if (!health.priced) {
  console.error("\nServer is in FREE MODE (no PAY_TO_ADDRESS), so there is no payment to make.");
  process.exit(1);
}

// --- Do we have anything to spend? --------------------------------------------------------
const balance = await publicClient.readContract({
  address: USDC,
  abi: [
    {
      name: "balanceOf",
      type: "function",
      stateMutability: "view",
      inputs: [{ name: "account", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
    },
  ],
  functionName: "balanceOf",
  args: [account.address],
});

console.log(`balance : ${formatUnits(balance, 6)} test USDC`);

if (balance === 0n) {
  console.error("\nBuyer has no test USDC, so the payment cannot be signed.");
  console.error("Fund this address from a Base Sepolia USDC faucet, then re-run:");
  console.error(`\n  ${account.address}\n`);
  process.exit(1);
}

// --- The actual cycle ---------------------------------------------------------------------
// wrapFetchWithPayment does the work: first request comes back 402, it reads the requirements,
// signs an authorization, and retries with the payment header attached. No gas is spent -- the
// exact scheme signs an EIP-3009 authorization and the facilitator submits it.
const client = new x402Client().register(NETWORK, new ExactEvmScheme(account));
const fetchWithPay = wrapFetchWithPayment(fetch, client);

console.log("\ncalling (expect 402 -> pay -> retry) ...");
const started = Date.now();

const res = await fetchWithPay(`${baseUrl}/${endpoint}/${mint}`);
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

console.log(`HTTP ${res.status} in ${elapsed}s`);

const settlement = res.headers.get("payment-response");
if (settlement) {
  try {
    console.log("settlement:", JSON.stringify(decodePaymentResponseHeader(settlement), null, 2));
  } catch {
    console.log("settlement header present but could not be decoded");
  }
}

const body = await res.json();

if (!res.ok) {
  console.error("\nRequest failed:", JSON.stringify(body, null, 2));
  process.exit(1);
}

console.log("\n--- PAID RESPONSE ---");
console.log(JSON.stringify(body, null, 2).slice(0, 2000));

const after = await publicClient.readContract({
  address: USDC,
  abi: [
    {
      name: "balanceOf",
      type: "function",
      stateMutability: "view",
      inputs: [{ name: "account", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
    },
  ],
  functionName: "balanceOf",
  args: [account.address],
});

console.log(`\nbalance before : ${formatUnits(balance, 6)} test USDC`);
console.log(`balance after  : ${formatUnits(after, 6)} test USDC`);
console.log(`spent          : ${formatUnits(balance - after, 6)} test USDC`);
