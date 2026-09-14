// Prints the teaser card (`TEASER_PAYOUTS` in src/shared/constants.ts) and the
// markdown table PLAN.md §5.8 carries, from one model, so the two can be
// regenerated together and every number is a script output, never a guess
// (CLAUDE.md rule 2).
//
//   node scripts/teaser-card.mjs            # human-readable card
//   node scripts/teaser-card.mjs --json     # the TEASER_PAYOUTS literal
//   node scripts/teaser-card.mjs --markdown # the PLAN.md §5.8 table
//
// THE MODEL (docs/teaser-odds.md §5). A teased spread leg wins when the game's
// margin against the spread lands anywhere above -t. Margin-vs-spread in
// football is close to normal with a standard deviation near 13.5 points, so
// the per-leg win probability is p(t) = Φ(t / SIGMA), and an n-leg teaser's
// fair decimal odds are 1 / p(t)^n. The book keeps a flat share HOLD of that:
// decimal = (1 - HOLD) / p(t)^n. SIGMA and HOLD are fitted to the one fully
// published card (Bovada, 6 / 6.5 / 7 / 8 / 9 points × 2-10 legs), and those
// 45 published cells are used VERBATIM — the model only fills the tiers the
// book does not print. Sanity check on tiers it was not fitted to: DraftKings'
// "ties lose" specialty teasers are 10-pt 3-leg -120 and 13-pt 4-leg -140; the
// model gives -150 and -200, i.e. WORSE for the bettor, which is the right side
// to err on because this card keeps push protection at every tier.
//
// Prices are rounded the way a card is printed: to 5 under +/-200, to 25 up to
// +1000, to 100 up to +3000, to 500 above. Every value round-trips through
// americanToPrice/priceToAmerican (tests/unit/odds.spec.ts).

const PUBLISHED = {
  60: { 2: -120, 3: 150, 4: 260, 5: 400, 6: 600, 7: 900, 8: 1400, 9: 1900, 10: 2500 },
  65: { 2: -130, 3: 135, 4: 225, 5: 350, 6: 500, 7: 800, 8: 1100, 9: 1500, 10: 2000 },
  70: { 2: -140, 3: 120, 4: 200, 5: 325, 6: 450, 7: 700, 8: 900, 9: 1200, 10: 1500 },
  80: { 2: -165, 3: 105, 4: 155, 5: 225, 6: 300, 7: 425, 8: 600, 9: 750, 10: 1000 },
  90: { 2: -185, 3: -115, 4: 130, 5: 185, 6: 250, 7: 325, 8: 425, 9: 550, 10: 700 },
};
export const TIERS_TENTHS = [30, 40, 50, 60, 65, 70, 80, 90, 100, 110, 120, 130, 140];
const LEGS = [2, 3, 4, 5, 6, 7, 8, 9, 10];

const toDecimal = (american) => (american > 0 ? 1 + american / 100 : 1 + 100 / -american);
const toAmerican = (decimal) =>
  decimal >= 2 ? Math.round((decimal - 1) * 100) : -Math.round(100 / (decimal - 1));
/** Standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7). */
function phi(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-x * x);
  return 0.5 * (1 + Math.sign(x) * erf);
}
function roundAmerican(american) {
  const abs = Math.abs(american);
  const step = abs < 200 ? 5 : abs < 1000 ? 25 : abs < 3000 ? 100 : 500;
  const rounded = Math.sign(american) * Math.round(abs / step) * step;
  // Even money has no American representation the odds code accepts
  // (priceToAmerican(1/1) throws, PLAN §5.5), so a cell that rounds to ±100
  // is printed as the book would: a nickel of juice.
  return Math.abs(rounded) === 100 ? -105 : rounded;
}

/** Fit SIGMA and HOLD to the published cells by least squares on log-decimal. */
function fit() {
  let best = null;
  for (let sigma = 10; sigma <= 18; sigma += 0.05) {
    for (let hold = 0; hold <= 0.3; hold += 0.0025) {
      let err = 0;
      for (const [tenths, row] of Object.entries(PUBLISHED)) {
        const p = phi(Number(tenths) / 10 / sigma);
        for (const [legs, american] of Object.entries(row)) {
          const model = Math.log((1 - hold) / p ** Number(legs));
          err += (model - Math.log(toDecimal(american))) ** 2;
        }
      }
      if (best === null || err < best.err) best = { sigma, hold, err };
    }
  }
  return best;
}

const { sigma, hold, err } = fit();

export function card() {
  const out = {};
  for (const tenths of TIERS_TENTHS) {
    const p = phi(tenths / 10 / sigma);
    out[tenths] = {};
    for (const legs of LEGS) {
      out[tenths][legs] =
        PUBLISHED[tenths]?.[legs] ?? roundAmerican(toAmerican((1 - hold) / p ** legs));
    }
  }
  return out;
}

const fmt = (a) => (a > 0 ? `+${a}` : `−${-a}`); // unicode minus, as PLAN prints it
const label = (tenths) => `${tenths / 10}`;
const c = card();
const mode = process.argv[2];
if (mode === '--json') {
  console.log(JSON.stringify(c, null, 2));
} else if (mode === '--markdown') {
  console.log(`| legs | ${TIERS_TENTHS.map((t) => `${label(t)} pt`).join(' | ')} |`);
  console.log(`| ---- | ${TIERS_TENTHS.map(() => '---').join(' | ')} |`);
  for (const legs of LEGS)
    console.log(`| ${legs} | ${TIERS_TENTHS.map((t) => fmt(c[t][legs])).join(' | ')} |`);
} else {
  console.log(
    `fit: sigma=${sigma.toFixed(2)} hold=${(hold * 100).toFixed(2)}% (rss ${err.toFixed(4)} over 45 cells)`,
  );
  console.log(
    'per-leg win probability p(t):',
    TIERS_TENTHS.map((t) => `${label(t)}:${phi(t / 10 / sigma).toFixed(3)}`).join(' '),
  );
  console.log(`\nlegs  ${TIERS_TENTHS.map((t) => `${label(t)}pt`.padStart(7)).join('')}`);
  for (const legs of LEGS)
    console.log(
      `${String(legs).padStart(4)}  ${TIERS_TENTHS.map((t) => fmt(c[t][legs]).padStart(6) + (PUBLISHED[t] ? '*' : ' ')).join('')}`,
    );
  console.log(
    '\n* published (Bovada), used verbatim. DK sanity: 10pt/3-leg',
    fmt(c[100][3]),
    '(DK -120); 13pt/4-leg',
    fmt(c[130][4]),
    '(DK -140)',
  );
  const worst = Math.max(...TIERS_TENTHS.map((t) => c[t][10]));
  console.log(
    'worst cell (10 legs, 3 pt):',
    fmt(worst),
    '=> payout at 100,000c stake =',
    100000 + (100000 * worst) / 100,
    'c',
  );
}
