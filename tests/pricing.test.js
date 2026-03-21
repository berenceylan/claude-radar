const { MODEL_PRICING, SUBSCRIPTION_PLANS, getPricing, calculateCost } = require('../src/pricing');

describe('pricing', () => {
  describe('MODEL_PRICING', () => {
    it('has pricing for all known models', () => {
      expect(MODEL_PRICING['claude-opus-4-6']).toBeDefined();
      expect(MODEL_PRICING['claude-opus-4-5-20251101']).toBeDefined();
      expect(MODEL_PRICING['claude-sonnet-4-6']).toBeDefined();
      expect(MODEL_PRICING['claude-sonnet-4-5-20251022']).toBeDefined();
      expect(MODEL_PRICING['claude-haiku-4-5-20251001']).toBeDefined();
    });

    it('has all required pricing fields', () => {
      for (const [name, pricing] of Object.entries(MODEL_PRICING)) {
        expect(pricing).toHaveProperty('input');
        expect(pricing).toHaveProperty('output');
        expect(pricing).toHaveProperty('cacheRead');
        expect(pricing).toHaveProperty('cacheWrite');
        expect(pricing.input).toBeGreaterThan(0);
        expect(pricing.output).toBeGreaterThan(0);
      }
    });

    it('opus costs more than sonnet which costs more than haiku', () => {
      const opus = MODEL_PRICING['claude-opus-4-6'];
      const sonnet = MODEL_PRICING['claude-sonnet-4-6'];
      const haiku = MODEL_PRICING['claude-haiku-4-5-20251001'];
      expect(opus.input).toBeGreaterThan(sonnet.input);
      expect(sonnet.input).toBeGreaterThan(haiku.input);
    });
  });

  describe('SUBSCRIPTION_PLANS', () => {
    it('has all plan tiers', () => {
      expect(SUBSCRIPTION_PLANS.pro_20).toEqual({ name: 'Pro', monthlyRate: 20 });
      expect(SUBSCRIPTION_PLANS.max_100).toEqual({ name: 'Max', monthlyRate: 100 });
      expect(SUBSCRIPTION_PLANS.max_200).toEqual({ name: 'Max', monthlyRate: 200 });
      expect(SUBSCRIPTION_PLANS.team).toEqual({ name: 'Team', monthlyRate: 0 });
    });
  });

  describe('getPricing', () => {
    it('returns exact match for known models', () => {
      expect(getPricing('claude-opus-4-6')).toBe(MODEL_PRICING['claude-opus-4-6']);
      expect(getPricing('claude-haiku-4-5-20251001')).toBe(MODEL_PRICING['claude-haiku-4-5-20251001']);
    });

    it('falls back to family match for unknown versions', () => {
      const result = getPricing('claude-opus-99-future');
      expect(result).toBe(MODEL_PRICING['claude-opus-4-6']);
    });

    it('falls back to opus for completely unknown models', () => {
      const result = getPricing('totally-unknown-model');
      expect(result).toBe(MODEL_PRICING['claude-opus-4-6']);
    });

    it('matches sonnet family', () => {
      expect(getPricing('claude-sonnet-future')).toBe(MODEL_PRICING['claude-sonnet-4-6']);
    });

    it('matches haiku family', () => {
      expect(getPricing('claude-haiku-future')).toBe(MODEL_PRICING['claude-haiku-4-5-20251001']);
    });
  });

  describe('calculateCost', () => {
    it('calculates cost for opus with all token types', () => {
      const usage = {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
      };
      const cost = calculateCost(usage, 'claude-opus-4-6');
      // 15 + 75 + 1.5 + 18.75 = 110.25
      expect(cost).toBeCloseTo(110.25, 2);
    });

    it('returns 0 for empty usage', () => {
      expect(calculateCost({}, 'claude-opus-4-6')).toBe(0);
    });

    it('handles missing fields gracefully', () => {
      const usage = { input_tokens: 500_000 };
      const cost = calculateCost(usage, 'claude-opus-4-6');
      expect(cost).toBeCloseTo(7.5, 2); // 0.5M * $15
    });

    it('haiku is cheaper than opus for same usage', () => {
      const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
      const opusCost = calculateCost(usage, 'claude-opus-4-6');
      const haikuCost = calculateCost(usage, 'claude-haiku-4-5-20251001');
      expect(haikuCost).toBeLessThan(opusCost);
    });
  });
});
