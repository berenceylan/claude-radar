/**
 * Claude model pricing and cost calculation.
 * Prices are per 1M tokens in USD (API rates).
 */

const MODEL_PRICING = {
  'claude-opus-4-5-20251101':   { input: 15,  output: 75, cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-opus-4-6':            { input: 15,  output: 75, cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-sonnet-4-5-20251022': { input: 3,   output: 15, cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-sonnet-4-6':          { input: 3,   output: 15, cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-haiku-4-5-20251001':  { input: 0.8, output: 4,  cacheRead: 0.08, cacheWrite: 1 },
};

const SUBSCRIPTION_PLANS = {
  pro_20:   { name: 'Pro',  monthlyRate: 20 },
  max_100:  { name: 'Max',  monthlyRate: 100 },
  max_200:  { name: 'Max',  monthlyRate: 200 },
  team:     { name: 'Team', monthlyRate: 0 },
};

function getPricing(model) {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];

  // Fallback: match by model family
  if (model.includes('opus'))   return MODEL_PRICING['claude-opus-4-6'];
  if (model.includes('sonnet')) return MODEL_PRICING['claude-sonnet-4-6'];
  if (model.includes('haiku'))  return MODEL_PRICING['claude-haiku-4-5-20251001'];

  // Default to opus pricing (most conservative estimate)
  return MODEL_PRICING['claude-opus-4-6'];
}

function calculateCost(usage, model) {
  const pricing = getPricing(model);
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;

  return (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output +
    (cacheRead / 1_000_000) * pricing.cacheRead +
    (cacheWrite / 1_000_000) * pricing.cacheWrite
  );
}

module.exports = { MODEL_PRICING, SUBSCRIPTION_PLANS, getPricing, calculateCost };
