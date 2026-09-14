# Football Teaser Odds Research (2025-2026)

Researched: 2026-09-13. Scope: DraftKings, FanDuel, BetMGM, Caesars, and the
"classic Vegas / offshore standard" card, for 6, 6.5, 7-point teasers, 2-10 legs.

## Important caveat up front

Modern US-regulated books (DraftKings, FanDuel, BetMGM, Caesars) generally do
**not** publish a full static odds table for every leg count on their public
help pages the way old-school Vegas / offshore books did. DK and FanDuel show
teaser prices dynamically in the bet slip (and DK's help article gives only a
handful of illustrative examples, not a full 2-10 leg grid). BetMGM and
Caesars publish essentially no numeric tables at all in their public help
content found via search — only descriptive rules pages. The one source that
still publishes a full, fixed, classic-style teaser card across 2-10 legs and
6/6.5/7/8/9 points is Bovada (offshore), which is the best proxy for the
"industry standard / Vegas standard" card. Treat the DK/FanDuel numbers below
as confirmed spot values, not confirmed-complete tables.

## 1. Payout tables (American odds)

### Bovada — "classic standard" full card (offshore standard; source of truth for full 2-10 leg grid)

Source: https://www.bovada.lv/help/sports-faq/teaser-betting

| Teams | 6 pts | 6.5 pts | 7 pts | 8 pts | 9 pts |
| ----- | ----- | ------- | ----- | ----- | ----- |
| 2     | -120  | -130    | -140  | -165  | -185  |
| 3     | +150  | +135    | +120  | +105  | -115  |
| 4     | +260  | +225    | +200  | +155  | +130  |
| 5     | +400  | +350    | +325  | +225  | +185  |
| 6     | +600  | +500    | +450  | +300  | +250  |
| 7     | +900  | +800    | +700  | +425  | +325  |
| 8     | +1400 | +1100   | +900  | +600  | +425  |
| 9     | +1900 | +1500   | +1200 | +750  | +550  |
| 10    | +2500 | +2000   | +1500 | +1000 | +700  |

This is the table most closely matching what's colloquially called the
"standard" or classic Vegas teaser card (NFL regular season). Bovada tables
also break out CFB/CFL separately with different point increments (not
captured here — ask if needed).

### DraftKings — confirmed spot values (not a full published 2-10 grid)

Source: https://support.draftkings.com/... "What is a teaser?" and corroborated by
covers.com's DK-sourced table (https://www.covers.com/guides/teaser-betting)

| Teams | 6 pts | 7 pts |
| ----- | ----- | ----- |
| 2     | -120  | -140  |
| 3     | +160  | +130  |
| 4     | +260  | +200  |
| 5     | +400  | +320  |

Note: 6-point 4-leg and 5-leg match the Bovada "standard" numbers almost
exactly (+260/+400); DK's 3-leg 6-point (+160) is slightly better than the
Bovada standard (+150). DK's 2-leg 6-point (-120) matches Bovada; some
secondary sources instead say DK prices 2-leg/6pt at -110, so this figure is
not fully reconciled across sources — verify live in the DK app.

DK also offers two "specialty" fixed-price teasers on football:

- **Football Super Teaser**: 3 legs, buy 10 points, ties/pushes lose (no push
  protection), price -120.
- **Football Monster Teaser**: 4 legs, buy 13 points, ties/pushes lose, price
  -140.

### FanDuel — confirmed spot values only (no full grid found in public help content)

Multiple secondary sources (bettingusa.com, boydsbets.com) converge on:

| Teams | 6 pts | 6.5 pts | 7 pts |
| ----- | ----- | ------- | ----- |
| 2     | -110  | -120    | -130  |
| 3     | +150  | —       | —     |

This is thinner than DK's; FanDuel appears to price 6-point 2-leg teasers at
essentially a straight -110 (i.e., a plain "buy the points for free at
standard vig" framing on the smallest teaser), stepping up to -120/-130 as
points bought increase. Full 4+ leg FanDuel numbers were not found published;
FanDuel's bet slip computes these live per selection.

### BetMGM / Caesars

No numeric payout tables were found on public help/support content for
either book via search. Both are known to offer 6/6.5/7-point (and often
extra-point "Superboost"-style) football teasers, priced live in the bet
slip. Could not confirm exact figures — flag as an unknown; would require
checking the live app/bet slip or a BetMGM/Caesars-specific promo/help page
not surfaced by search.

### "Widely-cited standard" generic table (secondary aggregator consensus, e.g. covers.com)

Source: https://www.covers.com/guides/teaser-betting

| Teaser size | 6 pts | 6.5 pts | 7 pts |
| ----------- | ----- | ------- | ----- |
| 2-team      | -110  | -120    | -135  |
| 3-team      | +160  | +140    | +120  |
| 4-team      | +265  | +240    | +215  |

This roughly splits the difference between the Bovada "classic" card and the
DK spot values, and is the number set most consumer betting-content sites
repeat as "the standard."

### True/fair odds reference (no vig) — Wizard of Odds

Source: https://wizardofodds.com/games/sports-betting/appendix/10/
Gives fractional fair-value odds and the house's hold % per leg count for
6/6.5/7-point teasers on spreads vs. totals (e.g., 6pt 2-team fair value is
10-to-11 with -10.99% hold on sides, -13.77% on totals; hold generally
increases with leg count, and teasing totals has consistently worse value
than teasing spreads). Useful for sanity-checking a simulator's edge/vig
assumptions, not for matching a specific book's posted price.

## 2. Push rules

- **2-leg teaser, one leg pushes**: Universally, the whole bet is graded
  "No Action" and the original stake is refunded — it does NOT reduce to a
  priced straight bet. Confirmed by Bovada, covers.com, and FanDuel-derived
  sources. (One older secondary source loosely describes a "graded as a
  one-team wager at ~-265" outcome, but this appears to be describing a
  book-specific alternate convention, not the majority rule — the dominant,
  consistently-repeated rule across sources is void/refund for 2-leg.)
- **3+ leg teaser, one leg pushes**: The push is removed and the bet is
  reduced to the payout for the next-lower leg count at the same point/teaser
  type (e.g., a 4-team 6-point teaser with 3 wins + 1 push pays as a 3-team
  6-point teaser). Confirmed by Bovada, Wizard of Odds, covers.com, FanDuel.
- **Multiple pushes**: same logic recursively applies — reduce by however
  many legs pushed. If ALL remaining legs would reduce to a single leg, that
  is graded No Action too (there's no such thing as a 1-team teaser).
- **Any leg loses**: entire teaser loses regardless of other pushes (a loss
  is never "cured" by a push elsewhere).

## 3. Bet-type and scope rules

- **Totals allowed**: Yes, confirmed across all sources — teasers can mix
  spreads and totals (over/under) in the same ticket. Teasing totals
  generally carries a worse expected value than teasing spreads (bigger hold,
  per Wizard of Odds).
- **Moneylines allowed**: **No, confirmed not allowed.** Bovada explicitly:
  "can't include futures, props, moneylines, first half (1H), second half
  (2H), and quarter lines." FanDuel-derived guidance: "can't use prop bets,
  moneyline bets, or futures bets in a teaser." This matches expectation —
  teasers only work on line-based bets (spread/total) where "moving the
  number" has meaning.
- **Cross-sport / cross-league (e.g., NFL + college football) teasers**:
  Generally allowed at major books **as long as the games are in the same
  point-category** (Bovada's language: "Point adjustments must align by
  category, e.g., Football 6 points paired with Basketball 4 points" — i.e.
  cross-sport is allowed by pairing each sport's equivalent teaser tier, and
  since NFL and NCAAF share the same football point schedule, combining them
  in one teaser is standard practice at DK/FanDuel/BetMGM/Caesars). Could not
  find an explicit DK/FanDuel/BetMGM/Caesars statement singling out NFL+CFB
  specifically, but this is the standard, widely-assumed behavior in the
  industry and consistent with how teaser tabs are built in each app (you
  simply add legs from different games/leagues and the app enforces the
  matching point-value tier). Treat as medium confidence.
- **Same-game teaser restrictions**: Could not find explicit sportsbook
  documentation confirming or denying combining two legs from the _same_
  game into one teaser (as distinct from a dedicated "Same Game Parlay"
  product). Industry norm and the general logic of correlated-bet
  restriction on parlays strongly suggests standard teasers, like standard
  parlays, disallow multiple legs from the same game (to prevent
  correlated/related outcomes) unless the book has a dedicated "Same Game
  Teaser" product. This is an **unconfirmed inference** — flag as unknown,
  would need direct book house-rules text (e.g., FanDuel's state-by-state
  House Rules pages, which do exist per search: fanduel.com/fanduel-
  sportsbook-house-rules-<state>) to confirm definitively.

## 4. Edge cases

- **Half-point vs. whole-number lines after teasing**: Standard practice
  (per Wikipedia's Teaser gambling article and general industry convention)
  is that sportsbooks set base lines so that, after applying the teaser
  points, the resulting number still lands on a half-point wherever possible,
  specifically to avoid the game pushing (a push is bad for the book on a
  teaser leg since it just reduces/voids rather than losing outright). Where
  a teased line does land on a whole number (e.g., teasing across a
  key number like 3 or 7), a push on that individual leg is possible and is
  handled per the push rules in section 2 above.
- **Postponed / canceled games**: Confirmed — if a game in a teaser is
  postponed or not played as scheduled (wrong date/location), that leg is
  graded "No Action" and the teaser reduces exactly as if that leg had
  pushed (Bovada: "Games not played on the date or at the location listed
  are graded 'No Action' and the teaser reduces"). This is consistent across
  covers.com and general secondary sources. A 2-leg teaser with one leg
  postponed is void/refunded (same as a push, per section 2).
- **Specialty fixed-line teasers** (DK's Super/Monster Teasers, and similar
  products at other books, e.g. "Reverse Teasers" or big-number teasers)
  typically have **no push protection at all** — a tie/push on any leg is
  graded a loss ("ties lose"), unlike a standard teaser. This is a
  meaningfully different rule set and should not be conflated with standard
  teaser push handling.

## Recommended default table to implement

Use the **Bovada "classic standard" table** as the default/baseline in a
simulator, since it's the only fully-populated 2-10 leg, multi-point-value
grid found, and it's the closest match to what the betting industry calls
"the standard teaser card":

| Teams | 6 pts | 6.5 pts | 7 pts |
| ----- | ----- | ------- | ----- |
| 2     | -120  | -130    | -140  |
| 3     | +150  | +135    | +120  |
| 4     | +260  | +225    | +200  |
| 5     | +400  | +350    | +325  |
| 6     | +600  | +500    | +450  |
| 7     | +900  | +800    | +700  |
| 8     | +1400 | +1100   | +900  |
| 9     | +1900 | +1500   | +1200 |
| 10    | +2500 | +2000   | +1500 |

Pair it with these implementation rules:

- 2-leg push/void/postponed leg -> whole bet No Action, stake refunded.
- 3+ leg push/void/postponed leg -> reduce to the payout for (legs - number
  of pushes) at the same point value in this table; if it would reduce to 1
  leg, grade No Action.
- Reject moneyline legs; allow spread and total legs; allow mixing
  spread+total legs and mixing NFL+NCAAF legs (same football point-value
  tier).
- Flag DraftKings differs slightly (better) at 3-leg/6pt (+160 vs +150) and
  matches Bovada elsewhere; if you want to model DK specifically instead of
  the generic standard, use the DK table in section 1, but it's incomplete
  above 5 legs (unconfirmed) — falling back to the Bovada standard for legs
  6-10 is a reasonable approximation.
- Model FanDuel as ~similar to or slightly worse than DK at 2 legs (-110 to
  -120 range) with the caveat that a full grid wasn't found.
- BetMGM/Caesars: no data found; assume standard table as placeholder and
  flag as unverified if precision matters.

## 5. The extended card (3–14 points) — model

Alex asked for tiers from 3 to 14 points (2026-09-14). No book publishes a
full grid outside 6–9, so the missing tiers are GENERATED by
`scripts/teaser-card.mjs` from one model fitted to the 45 Bovada cells above:

- A teased spread leg wins when the margin against the spread lands above
  −t. Margin-vs-spread in football is close to normal; the per-leg win
  probability is therefore p(t) = Φ(t / σ).
- An n-leg teaser's fair decimal is 1 / p(t)ⁿ and the book keeps a flat hold:
  decimal = (1 − hold) / p(t)ⁿ.
- σ and hold are fitted by least squares on log-decimal over the 45 published
  cells: **σ = 14.65, hold = 3.25 %** (RSS 0.068). The published cells are
  used verbatim; the model fills only 3, 4, 5, 10, 11, 12, 13 and 14.
- Rounding as a card is printed: to 5 under ±200, to 25 up to +1000, to 100 up
  to +3000, to 500 above. A cell that would land on ±100 is printed −105
  (even money has no American representation the odds code accepts).

Sanity checks the fit did not see: DK's 10-point 3-leg Super Teaser is −120
and its 13-point 4-leg Monster is −140, both ties-lose; the model gives −150
and −200 with ties reducing. Being worse than DK at those tiers is the right
direction, since push protection is worth something. The generated card is
monotone in both directions (more points → worse, more legs → better), which
`tests/unit/odds.spec.ts` pins.

Regenerate with `node scripts/teaser-card.mjs` (`--json` for the constant,
`--markdown` for PLAN.md §5.8).

## Sources

- [Bovada — Teaser Betting: Rules & Payouts](https://www.bovada.lv/help/sports-faq/teaser-betting) — full 6-10 leg, 6/6.5/7/8/9-point standard table; push, postponement, moneyline/totals rules; cross-sport category matching.
- [DraftKings — What is a teaser?](https://support.draftkings.com/dk/en-us/what-is-a-teaser?id=kb_article_view&sysparm_article=KB0010765) — DK spot prices (2-5 legs, 6/7pt) and Super/Monster teaser specialty products.
- [Covers.com — What Is a Teaser Bet](https://www.covers.com/guides/teaser-betting) — DK-sourced table reproduction, generic "standard" 2-4 leg table, totals-eligibility confirmation, push reduction example.
- [Wizard of Odds — NFL Teasers appendix](https://wizardofodds.com/games/sports-betting/appendix/10/) — fair-value fractional odds and house hold % by leg count for 6/6.5/7pt spreads vs totals; push-reduction rule statement.
- [Wikipedia — Teaser (gambling)](<https://en.wikipedia.org/wiki/Teaser_(gambling)>) — background on half-point line construction to avoid pushes; general teaser mechanics.
- [FanDuel via bettingusa.com / boydsbets.com aggregation](https://www.bettingusa.com/sports/teaser/) — FanDuel 2-leg 6/6.5/7pt spot prices, moneyline/prop exclusion confirmation.
- [FanDuel Sportsbook House Rules pages](https://www.fanduel.com/fanduel-sportsbook-house-rules-on) — exist per-state; not fetched in depth, recommended follow-up for definitive same-game-teaser and postponement language.
