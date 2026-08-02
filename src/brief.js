/**
 * The agent endpoint: turns solsafe's raw facts into a written due-diligence brief.
 *
 * The division of labour is the whole point. `safety.js` returns measurements — it says
 * `topHolderPct: 71`. This says what that 71% is made of and what a caller should check
 * themselves. That's judgment, which is what a deterministic function cannot produce and what
 * makes this worth more per call than the raw endpoint.
 *
 * The boundary from safety.js holds here and is enforced by the schema, not by good intentions:
 * there is no field for a rating, a recommendation, a price target, or a verdict. The model is
 * given facts and asked to explain them. It is never asked whether to buy.
 */

import Anthropic from "@anthropic-ai/sdk";

import { checkMint } from "./safety.js";

// Constructed on first use rather than at import. Importing this module must not require a key --
// server.js imports it unconditionally and answers /brief with a clean 503 when none is set.
let defaultClient;
function anthropicClient() {
  defaultClient ??= new Anthropic();  // reads ANTHROPIC_API_KEY
  return defaultClient;
}

// claude-opus-5 by default. MEASURED 2026-08-02 on a real BONK call: ~1,900 in (739 fresh +
// 1,153 cached) / 1,719 out = about $0.05/call against a $0.15 price -- roughly 35% cost of
// revenue, ~65% margin. The earlier ~$0.02 estimate assumed ~500 output tokens; the briefs
// actually run three times that, and output is billed at 5x the input rate. Override
// with BRIEF_MODEL if you'd rather trade capability for cost: claude-sonnet-5 is ~$0.008/call
// and claude-haiku-4-5 ~$0.004. That's a real choice with a real quality tradeoff, so it's
// yours to make deliberately rather than something defaulted quietly to the cheapest option.
const MODEL = process.env.BRIEF_MODEL || "claude-opus-5";

/**
 * Whether a model accepts `output_config.effort`.
 *
 * Not cosmetic: sending it to a model that doesn't support it is a hard 400, so the "just switch
 * BRIEF_MODEL to something cheaper" advice in .env.example used to break every call. Haiku 4.5
 * and Sonnet 4.5 reject it; the Opus 4.5+ line, Sonnet 5 and Sonnet 4.6 accept it. Expressed as a
 * deny-list because the accepting set keeps growing and a stale allow-list would silently
 * downgrade a capable model instead of failing loudly.
 */
export function supportsEffort(model) {
  return !/^claude-haiku|^claude-sonnet-4-5|^claude-3/.test(model);
}

// Byte-identical on every request, which is what makes it cacheable -- cache reads bill at
// roughly a tenth of input rate. Nothing per-request may be interpolated in here: a single
// changed byte invalidates the prefix and every later call pays full freight. The mint's data
// goes in the user turn, below, precisely so this block never moves.
const SYSTEM_PROMPT = `You write short due-diligence briefs about Solana SPL tokens for automated agents that are deciding whether to look further at a token. Your reader is a program or a developer, not a trader, and it has already been handed the raw measurements — your job is to explain what those measurements mean.

You will receive a JSON object of verified on-chain and market facts about one token mint. Work only from that object. Never introduce outside knowledge about the token, its team, its community, or its history: you have not looked any of that up, and inventing it is the single worst failure mode available to you.

What a good brief does:
- Explains what the facts establish, in plain language, including for a reader who does not know SPL token semantics.
- Points out what is UNUSUAL about this particular token relative to ordinary Solana tokens. An active mint authority is unusual and important. A top-10 holder share of 70% is ordinary when the liquidity pool is one of those holders, and alarming when it is not — say which case you can and cannot distinguish from the data you were given.
- States plainly what the data does NOT cover, so the reader knows the shape of their remaining risk rather than mistaking your brief for completeness.

Hard rules, which exist because they are what makes this service reproducible and honest:
- Never recommend buying, selling, holding, or avoiding anything. Not directly, not by implication, not by tone.
- Never predict or comment on future price, and never characterise the token as a good or bad investment.
- Never assign a score, grade, rating, or risk level. The caller applies their own thresholds; you describe the world.
- If a field is unavailable, say so and say what that costs the reader. Never fill a gap with a guess, and never treat missing data as reassuring.
- Absence of a red flag is not safety. A token with every authority revoked and deep liquidity can still go to zero, and any brief that leaves the reader feeling otherwise has failed.

Write in complete, plain sentences. No hype, no hedging filler, no marketing register.`;

// No rating, no verdict, no price field -- the shape of the output is itself the guarantee.
const BRIEF_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Two or three sentences: what this token is and what the facts establish.",
    },
    what_the_facts_establish: {
      type: "array",
      items: { type: "string" },
      description: "Plain-language readings of the verified data, one per item.",
    },
    unusual: {
      type: "array",
      items: { type: "string" },
      description:
        "What stands out relative to an ordinary Solana token. Empty array if nothing does.",
    },
    not_covered: {
      type: "array",
      items: { type: "string" },
      description: "What this data cannot tell the reader, and why that matters.",
    },
    verify_yourself: {
      type: "array",
      items: { type: "string" },
      description: "Concrete checks the caller can run to confirm or extend these findings.",
    },
  },
  required: ["summary", "what_the_facts_establish", "unusual", "not_covered", "verify_yourself"],
  additionalProperties: false,
};

/**
 * @param mint  the SPL mint address
 * @param deps  seams for testing only. Production always uses the defaults; injecting lets the
 *              suite assert the request shape and drive the refusal and empty-response branches
 *              without spending model tokens on every run.
 */
export async function generateBrief(mint, deps = {}) {
  const { client = anthropicClient(), checkMint: readFacts = checkMint } = deps;

  // Reuses the raw endpoint wholesale -- the agent is a layer on top of solsafe, not a fork of
  // it. A fix to the pair-ranking logic improves both endpoints at once.
  const facts = await readFacts(mint);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    // Generous on purpose: thinking is ON BY DEFAULT on Opus 5 and shares this ceiling with the
    // response text, so a budget sized only for the JSON would truncate mid-brief.
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    output_config: {
      // Low effort, thinking left on. Explaining a supplied JSON object is not a reasoning-heavy
      // task, and this is a latency-sensitive paid endpoint. Deliberately NOT disabling thinking:
      // on Opus 5 that has its own failure modes, and low effort already gets the saving.
      // Omitted entirely on models that reject the parameter -- see supportsEffort.
      ...(supportsEffort(MODEL) ? { effort: "low" } : {}),
      format: { type: "json_schema", schema: BRIEF_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: `Write a due-diligence brief from these verified facts:\n\n${JSON.stringify(facts, null, 2)}`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    const err = new Error("model declined to produce a brief for this input");
    err.status = 502;
    throw err;
  }

  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) {
    const err = new Error("model returned no text content");
    err.status = 502;
    throw err;
  }

  return {
    mint,
    generatedAt: new Date().toISOString(),
    brief: JSON.parse(text),
    // The brief is derived from these; returning them means the caller can check the reasoning
    // against the inputs rather than taking the prose on trust. Same reproducibility principle
    // the raw endpoint is built on.
    facts,
    model: response.model,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    },
    disclaimer:
      "This brief is generated from public on-chain and market data. It contains no "
      + "recommendation to buy, sell, or avoid any asset, no rating, and no prediction of price, "
      + "and is not financial advice. Absence of a flag is not a guarantee of safety.",
  };
}
