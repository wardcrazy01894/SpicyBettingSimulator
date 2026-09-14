<!--
Keep this checklist. It is the project's merge gate written down (CLAUDE.md).
Tick what you did; strike through with ~~…~~ and one line of WHY for anything
that genuinely does not apply. An unticked box with no explanation reads as
"not done", which is the point.
-->

## What changed, and why

<!-- One paragraph. The diff says what; say why, and what you decided against. -->

## Checklist

- [ ] **Docs ship in this PR.** Behaviour changed → `PLAN.md` (the section, not
      just a footnote), `CLAUDE.md` and `README.md` are updated here, not in a
      follow-up. `npm test` runs `tests/unit/docs.spec.ts`, which catches the
      mechanical half — constants, error codes, routes, tables, the teaser card,
      the cron expressions. It cannot catch a paragraph that is now describing
      something nobody does; that is this box.
- [ ] **Pre-PR gate is green**, all five, locally:
      `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build`
- [ ] **Adversarial review: APPROVE.** Every PR gets one before merge —
      dependency bumps included. Green CI is necessary, not sufficient.
- [ ] **Every arithmetic claim is REPL-verified.** New payout figures, row-write
      counts, budgets and worked examples in code comments or docs were pasted
      from a REPL, not reasoned out (CLAUDE.md rule 2). Say which numbers below.
- [ ] **Tests first.** New pure logic has a test that failed before the
      implementation existed. No existing test was deleted without a reason here.

## Money and schema

- [ ] No float touches a code path that produces a cent; no decimal-odds rational
      is persisted (CLAUDE.md rule 2).
- [ ] Nothing writes `INSERT OR IGNORE` / `INSERT OR REPLACE` into `ledger`
      (rule 6). Any new atomic sequence is ONE `db.batch()` with its guard in the
      `WHERE`, never read-then-write (rule 5).
- [ ] `migrations/0001_init.sql` edited in place only while M8 has not deployed;
      after that, a new numbered migration (rule 9).
- [ ] `SUM(ledger) === balance_cents` still holds — a worker test asserts it for
      every scenario this PR touches.

## Numbers verified

<!--
Paste the REPL output for anything quantitative this PR asserts. Example:

  3-leg -110/+120/-105 @ 100c
    floor(100n * 9471000n / 1155000n) = 820n
-->

## Risk

<!-- What breaks if this is wrong, and how would we notice? -->
