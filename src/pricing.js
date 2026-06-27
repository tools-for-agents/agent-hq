// Token pricing for the run/cost ledger. USD per 1,000,000 tokens.
// These are CONFIGURABLE DEFAULTS, not a live price feed — set them to your
// actual contract rates. Override a model at runtime with env, e.g.:
//   HQ_PRICE_opus="10,50"   (input,output USD per 1M)
const DEFAULTS = {
  // model key (substring-matched, case-insensitive) : [inputPer1M, outputPer1M]
  opus:    [15, 75],
  sonnet:  [3, 15],
  haiku:   [1, 5],
  fable:   [3, 15],
  gpt:     [5, 15],
  gemini:  [3, 12],
  default: [3, 15],
};

function loadOverrides() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('HQ_PRICE_')) continue;
    const model = k.slice('HQ_PRICE_'.length).toLowerCase();
    const [i, o] = String(v).split(',').map(Number);
    if (Number.isFinite(i) && Number.isFinite(o)) out[model] = [i, o];
  }
  return out;
}
const TABLE = { ...DEFAULTS, ...loadOverrides() };

function rateFor(model = '') {
  const m = String(model).toLowerCase();
  for (const key of Object.keys(TABLE)) {
    if (key !== 'default' && m.includes(key)) return TABLE[key];
  }
  return TABLE.default;
}

// Compute USD cost from token counts. Returns a number rounded to 6 decimals.
export function costOf(model, inputTokens = 0, outputTokens = 0) {
  const [pi, po] = rateFor(model);
  const cost = (inputTokens / 1e6) * pi + (outputTokens / 1e6) * po;
  return Math.round(cost * 1e6) / 1e6;
}

export const priceTable = () => TABLE;
