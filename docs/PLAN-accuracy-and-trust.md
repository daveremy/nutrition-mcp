# Plan — nutrition-mcp accuracy + caller-trust overhaul

**Status:** proposed, pending review
**Issue:** daveremy/nutrition-mcp#2
**Author:** Karpathy · **Reported by:** Huberman (2 field misses, physical labels as ground truth)
**Scope:** Phase 1 (correctness) + Phase 2 (caller trust) in one push, per Dave.

---

## 1. The bug (confirmed, not inferred)

Every macro in `~/.nutrition-mcp/nutrition.db` is stored **per 100 g**. The server returns those
numbers beside a `serving_size` string (`"0.75 cup"`, `"70 g"`) **with no scaling**.
`serving_weight_g` is present on 86.5% of rows and used in **zero computations** — it appears in
the DDL, the type, INSERT bindings and one COALESCE, and is never multiplied by anything.

Verified against physical labels and the live DB:

| product | stored (per 100 g) | × weight/100 | label | error |
|---|---|---|---|---|
| Chobani vanilla nonfat greek (170 g) | 76 cal / 8.24 P | **129.2 / 14.0** | **130 / 14** | −41.5% |
| G2G coconut almond bar (70 g) | 429 cal / 25.7 P | **300.3 / 18.0** | **300 / 18** | +43.0% |

Error magnitude is exactly `100 / serving_weight_g`. Sign is determined solely by whether the
serving is heavier or lighter than 100 g. **The data is correct; the presentation is unscaled.**

### Why this is nastier than a normal data bug
Servings **under** 100 g — bars, yogurt cups, drinks, i.e. most packaged single-serve food —
**over**-report. Huberman caught the yogurt only because 76 cal for a cup of sweetened yogurt is
absurd. He did **not** catch the bar, because 429 cal for a protein bar is entirely plausible, and
he logged the wrong number. Two DB entries agreed with each other and were both wrong, so
cross-record corroboration proves nothing.

**The dangerous failures are the plausible ones.**

---

## 2. Why 43 passing tests did not catch it

`test/helpers.ts:28` builds every fixture with:

```ts
serving_weight_g: 100,
```

Scaling by `100/100` is a **no-op**. The entire suite passes identically whether scaling exists or
not. The fixture uses the one value that makes this bug class invisible.

This is the same failure shape as the MCP release work this week: green tests that never exercise
the property under test. Fixing the fixture is therefore not incidental cleanup — it is the change
that gives the suite the *capacity* to catch this class at all.

---

## 3. Design principle: the caller is an LLM

Dave's framing, and it drives Phase 2. The consumer is a reasoning agent that can web-search,
re-read a label, or ask the user. So the server's job is **not** to be perfectly accurate — it is
to be **honest about what it knows and how well**, so the caller can decide whether to trust,
verify, or ask.

That reframes the two misses: an absurd number is self-policing; a **plausible** number is not.
The server must therefore emit signals that make a plausible-but-wrong value *detectable without
the label*.

---

## 4. Phase 1 — correctness

**1.1 Scale at the store boundary.** All three read paths (`search`, `lookup`, `lookupByBarcode`)
return raw rows today. Introduce one `toServingBasis(row)` helper applied at every return, so no
future read path can bypass it. Macros scaled: `calories, protein, fat, carbs, fiber, sugar, sodium`.

**1.2 `nutrition_search` does not even SELECT `serving_weight_g`** (`store.ts:97`). Add it — the
caller currently cannot scale for itself even if it wanted to.

**1.3 NULL-weight rows (44,132 = 13.5%) cannot be scaled.** Do **not** silently return per-100g
under a serving label — that is the original bug. Return the per-100g numbers and **rewrite
`serving_size` to `"100 g"`** so the values are truthfully labelled.

**1.4 Emit an explicit `basis` field** — `"per_serving" | "per_100g"` — never inferred by the caller.

**1.5 Rounding:** round to 1 decimal after scaling. Do not round intermediates.

**1.6 Fix the fixture.** `serving_weight_g: 170` as default, plus explicit cases at **70 g**
(over-report direction), **100 g** (identity — must still pass), and **NULL** (relabel path).

---

## 5. Phase 2 — caller trust

**2.1 Provenance on every result.** `source_tier` exists (326,759 local / 20 usda / 7 web) but is
not surfaced usefully. Emit it plus `data_source`, so the caller can weight a web-scraped row
differently from a USDA one.

**2.2 Atwater plausibility check.** Flag when `kcal ≉ 4P + 4C + 9F` beyond a tolerance
(propose ±15%, tunable). Emit `plausibility: "ok" | "suspect"` with the computed vs stored delta.
**The G2G bar was arithmetically detectable without the label** — this check is what turns a
plausible wrong number into a visible one.

**2.3 `verified_against_label`** boolean, set by the correction path. A number a human has checked
against a physical label is categorically better evidence than any scrape.

**2.4 Tool descriptions must tell the LLM what to do with these signals** — that a `suspect`
plausibility or a `web` tier is grounds to web-search or ask the user before logging.

---

## 6. Correction path (Dave: "yes we need an override/correction path")

`nutrition_override` already exists but has a **UX trap**: every field is documented *per 100 g*
(`"Corrected calories per 100g"`). A coach holding a physical label has **per-serving** numbers.
Requiring them to divide by serving weight re-introduces exactly the arithmetic that caused this
bug — by hand, under time pressure.

**Change:** accept per-serving input and convert internally.

```
nutrition_correct(id, serving_weight_g, calories, protein, ... , basis: "per_serving" | "per_100g")
```

- Default `basis: "per_serving"` — the label case, the common case.
- Server divides by `serving_weight_g/100` to store canonical per-100g.
- Sets `verified_against_label = true` and `source_tier = "local"` (highest trust).
- Preserves the original row (current override behaviour already creates a copy).
- **Write-back is the point:** a label Huberman verifies once is trusted permanently, so the
  correction compounds instead of being re-derived every time.

---

## 7. Test plan (the deliverable that prevents recurrence)

- Scaling correctness at **70 g / 100 g / 170 g / NULL**, asserting exact expected values.
- **Regression cases from the real misses:** Chobani → 130/14, G2G → 300/18. These are the two
  physical labels we have ground truth for; they become permanent fixtures.
- `search`/`lookup`/`barcode` all return the **same** basis for the same id — a cross-path
  assertion, the shape that catches "fixed one path, missed another" (exactly how the
  neuralingual ceiling bug survived a fix).
- NULL-weight rows relabel to `"100 g"` and never claim a serving basis.
- Atwater flag fires on the known-bad G2G values and stays quiet on the corrected ones.
- Round-trip: `nutrition_correct` with per-serving label input → `lookup` returns those exact
  per-serving numbers back.

---

## 8. Docs (for Huberman as the calling agent)

A `docs/CALLER-GUIDE.md` covering: what `basis` means; when to trust vs verify (`suspect`
plausibility, `web` tier, NULL weight); how to correct a wrong entry from a physical label; and
the explicit statement that **the LLM is expected to verify plausible-looking outliers**, because
absurd values self-police and plausible ones do not.

---

## 9. Out of scope (deliberately)

- Re-importing or repairing the 326k-row corpus. The presentation fix corrects every scaled row at
  once; a data audit is Phase 3.
- Changing the seed source.
- **Phase 3 idea, not in this push:** run the Atwater check across all 326k rows to quantify how
  much of the corpus is internally inconsistent. That number decides whether a re-import is worth it.

---

## 10. Risks

- **Silent double-scaling** if any caller already compensates. Mitigation: the explicit `basis`
  field, and no known caller does.
- **`serving_size` strings are free text** (`"0.75 cup"`); we scale by `serving_weight_g` only and
  never parse the string. Parsing it would be a second bug source.
- **The 13.5% NULL population** gets relabelled rather than fixed — honest, but it means some
  results are per-100g. The `basis` field makes that unambiguous rather than hidden.

---

# REVIEW PASS 1 — findings (codex, adversarial) + disposition

16 findings. Two verified by hand before acceptance; both were real and would have shipped bugs.

## ACCEPTED — corrections to the plan above

**R1. "All read paths" was FALSE — `listCached()` is a fourth.** `store.ts:204`, exposed publicly
as `nutrition_cache_list`, returns `SearchResult` with unscaled macros. **Verified.** Had I shipped
"all three", cached USDA/web rows would still leak the bug. *This is the same defect class as the
neuralingual ceiling bug — fix one path, miss another — which is exactly what the cross-path test
was meant to catch. The plan's own test section caught what its implementation section missed.*

**R2. The correction path would have been silently useless for barcodes. ⚠️ SEVEREST FINDING.**
`store.ts:254` writes overrides as `source_tier: "web"`; `lookupByBarcode` (`store.ts:116`) orders
`local → usda → web`. **Verified.** A correction is therefore outranked by the original row it
corrects. The feature would appear to work and never apply. **Fix: corrected rows must take
precedence explicitly, and trust must be a separate field — not overloaded onto `source_tier`.**

**R3. USDA basis is unproven.** `client.ts:53` sets `serving_weight_g = item.servingSize` and maps
`foodNutrients` directly. "All stored data is per 100g" must be proven **per tier** (`local`,
`usda`, `web`, override) before scaling on read — otherwise Phase 1 fixes local data while
**corrupting newly cached USDA rows**. Blocking prerequisite.

**R4. My Atwater justification was overstated.** I claimed the G2G bar "was arithmetically
detectable without the label." Wrong: once *all* macros scale consistently, Atwater catches
internal inconsistency, not serving-basis errors. If calories AND macros are uniformly per-100g,
Atwater is perfectly happy. It remains useful — but it does **not** guard this bug class. Claim
retracted.

**R5. Atwater ±15% will false-positive exactly where it matters.** Fibre, sugar alcohols, allulose,
polyols — i.e. protein bars, the very category that burned us. Emit `atwater_delta_pct` (a number)
rather than a binary `suspect`, or the LLM learns to ignore the flag.

**R6. `verified_against_label` needs an ALTER TABLE migration.** `CREATE TABLE IF NOT EXISTS` will
not add columns to the existing 232MB DB. Omitted entirely from the plan.

**R7. Relabelling NULL-weight `serving_size` to `"100 g"` destroys context.** A row saying
`"1 bar"` becomes `"100 g"` — discarding precisely what the LLM needs to ask "how many grams is one
bar?" **Fix: keep the original string, add `basis` + `basis_weight_g`.** Strictly better than my
version.

**R8. `basis: "per_serving"` is under-specified** — add `basis_weight_g` so "14g protein" is
unambiguously "per 170g".

**R9. Per-field rounding.** Sodium is mg and integer-ish; 1 decimal implies false precision.

**R10. Correction must REJECT a per-serving payload without explicit `serving_weight_g`.** Concrete
break: row has wrong weight 40g, user corrects a 70g bar's label but omits weight → server stores
inflated values against 40g. Never inherit weight silently.

**R11. Partial corrections create mixed provenance.** If only calories is corrected per-serving,
other fields remain canonical — so a whole-row `verified_against_label` is false advertising.
Verification metadata must be field-level, or the flag dropped.

**R12. Search dedup may surface the original over the correction** (`search.ts:14`). Same class as R2.

**R13. Test the class, not the instance** — property test: for arbitrary non-100 weights, every
nutrient on **every** public read surface equals `stored × weight / 100`. Plus: no response with
`basis: "per_serving"` may have a null weight.

**R14. Test that writes are NOT scaled** (`upsert`, `insertBulk`, cache-add), or a future dev
double-scales.

**R15. Breaking-change story.** Same field names now mean per-serving. Needs a version bump and
release note; consider `calories_per_serving` alongside `calories_per_100g` for one release.

## SCOPE — reviewer recommends splitting Phase 1 / Phase 2

Reviewer's argument: stabilise the response contract first, then layer trust semantics. Dave's
instruction was one push. **Deferred to Dave with the tradeoff visible** — R3 (prove USDA basis)
is a genuine blocking prerequisite either way, and R2 means the correction path needs precedence
work regardless of which phase it lands in.

---

# PREREQUISITE R3 — RESOLVED (proven, not assumed)

**Question:** is "all stored data is per 100 g" true per tier, or would scaling-on-read corrupt
USDA rows while fixing local ones?

**Answer: it holds for every tier. Proven empirically against the live DB** using foods whose
per-100g values are independently known:

| row (`source_tier='usda'`) | stored | per-100g truth |
|---|---|---|
| Oil, avocado | **884 cal, 100.0 g fat** | pure oil is 100 g fat/100 g → 884 kcal. Definitive. |
| Avocado, raw | **160 cal** | USDA canonical per-100g = 160 |
| Egg, whole | 148 cal / 12.4 P | per-100g whole egg ≈ 143-148 |
| Egg white / yolk | 55 / 334 | both canonical per-100g |

A per-*serving* basis is impossible here: no serving of avocado oil is 884 kcal.
**Scaling on read is safe for `local` and `usda`.** (`web` tier is 7 rows, all override-created,
already canonical per-100g by construction.)

## NEW BUG FOUND BY THIS PREREQUISITE — unit-blind serving weight

`client.ts:51-53`:
```ts
serving_size: item.servingSize ? `${item.servingSize}${item.servingSizeUnit ?? "g"}` : null,
serving_weight_g: item.servingSize ?? null,
```
Line 51 **uses** `servingSizeUnit` — so the code knows the unit varies. Line 53 stores the same
number as **grams unconditionally**. A USDA product with `servingSize: 8, servingSizeUnit: "fl oz"`
would be stored as `serving_weight_g = 8`, and post-fix would scale macros by **0.08** —
a 92% under-report, silently.

Currently latent (all 20 cached USDA rows have NULL `serving_weight_g`), but it becomes live the
moment we start scaling by that column. **Must fix in the same push:** only populate
`serving_weight_g` when the unit is grams; otherwise leave NULL and let the NULL path handle it.

*This is precisely why R3 was worth doing as a blocking prerequisite rather than an assumption —
the investigation found a bug that the fix itself would have activated.*
