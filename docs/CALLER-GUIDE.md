# Caller guide — for agents using this MCP server

This is written for an LLM agent (e.g. a health-coaching assistant) calling
`nutrition_search` / `nutrition_lookup` / `nutrition_barcode` / `nutrition_cache_list` and
deciding what to do with the result. If you're a human reading the tool schemas, it's still
useful background — but the framing below (verify vs. trust, when to ask) is written for you to
follow programmatically, in-conversation, without a human in the loop for every lookup.

## The one thing to internalize

**Absurd nutrition numbers self-police. Plausible ones do not.**

A food showing 3000 calories for a small yogurt cup is obviously wrong and you'll catch it without
being told to look. A protein bar showing 429 calories when it's actually 300 will not trigger any
instinct to double-check — it's a completely ordinary number for a protein bar. That's the failure
this server's response fields exist to prevent: they give you a way to tell "confidently correct"
apart from "confidently plausible and wrong" *before* a number reaches someone's health log,
because you can't tell the difference by eyeballing the value alone.

This guide exists because a coaching agent logged a real user's protein intake at 25.7g when the
physical label said 18g — a 43% overstatement that looked completely normal and was caught only
because someone happened to read the wrapper. The number was internally consistent, sourced, and
wrong. Treat every field below as a way to catch that class of error without needing the label.

## `basis` — never assume, always check

Every result carries `basis: "per_serving" | "per_100g"`. The headline macro fields
(`calories`, `protein`, `fat`, `carbs`, `fiber`, `sugar`, `sodium`) mean different things depending
on which:

- `"per_serving"` — the numbers are scaled to `basis_weight_g` grams (the food's actual serving).
  This is what you want for "how much did I just eat."
- `"per_100g"` — the food's serving weight isn't known, so the numbers are the canonical per-100g
  values, unscaled. **Do not silently treat these as a serving amount** — that's the exact bug
  this server used to have. If you need a serving-sized number and get `per_100g` back, ask the
  user for the serving weight (it's usually on the package) or web-search for it, then use
  `nutrition_override` to write the corrected weight back so it's fixed for next time (see below).

`per_100g` is included on **every** result regardless of `basis`, so you always have the canonical
values available for your own reasoning even when `basis` is `"per_serving"`.

## `atwater_delta_pct` — a number, not a flag, and it doesn't catch what you think

`atwater_delta_pct` measures how far stated calories diverge from what protein/fat/carbs imply
(4 kcal/g protein and carbs, 9 kcal/g fat), as a signed percentage. It's a real signal, but it has
a specific, narrow job: **it catches internal arithmetic inconsistency in a single row, not a
serving-basis error.** A row can be perfectly self-consistent (calories exactly match its own
macros) and *still* be presented under the wrong basis — that was this server's original bug, and
Atwater would not have caught it.

It's a *number*, not a binary "ok"/"suspect" flag, on purpose: fiber, sugar alcohols, and other
low-calorie bulk ingredients (protein bars are the classic case) legitimately push real products
several percent off naive Atwater math. Use it as one more input, not a pass/fail gate — a large
`|atwater_delta_pct|` (rule of thumb: past ±15%) on a food that isn't fiber/sugar-alcohol-heavy is
worth a second look; a small one on a protein bar is unremarkable.

## `source_tier`, `is_correction`, `verified_fields` — how much to trust this row

- `source_tier`: `"local"` (OpenNutrition dataset), `"usda"` (USDA FoodData Central), or `"web"`
  (cached from a web search or a correction). `web` rows that are corrections are also flagged via
  `is_correction` — don't infer trust from `source_tier` alone.
- `is_correction: true` means this exact row was written by `nutrition_override` — a human
  corrected it, typically from a physical label. Weight this above an uncorrected row.
- `verified_fields`: which specific macro fields have been checked against a physical label (e.g.
  `["calories", "protein"]`), or `null`. This is **field-level**, not whole-row — a row can have
  `calories` verified and `fat` still be an unverified USDA/web value. Don't assume the whole row
  is trustworthy because one field is.
- No `verified_fields` at all (`null`) does **not** mean the data is wrong — most of the corpus is
  unverified-but-fine. It means nobody has specifically checked it against a label. Weight it
  accordingly when a plausible-but-uncertain number matters (e.g. before logging something new to
  a user's regular routine).

## `superseded_by` — a correction exists, even if you didn't search for it

If you call `nutrition_lookup` with an id you already had (from an earlier search, a "usual
breakfast" shortcut, a persisted health-log entry) and the result has a non-null `superseded_by`,
**a correction now exists for this exact food and you looked up the stale original.** Look up
`superseded_by` instead before using the values. This can happen even though the id you called
with is completely valid and returns real data — the row itself isn't wrong, it's just not the
most current one.

## When to trust vs. web-search vs. ask the user

Rough decision order, cheapest-to-most-effort:

1. **`is_correction: true` or a verified field for the value you need** → trust it.
2. **`basis: "per_serving"`, no correction, plausible `atwater_delta_pct`, source is `local` or
   `usda`** → trust it, this is the common case and it's fine.
3. **`basis: "per_100g"` (unknown serving weight)** → you cannot get a per-serving number from
   this alone. Ask the user for the serving weight (often on the package next to "Nutrition
   Facts"), or web-search for the specific product's serving size, then proceed.
4. **Large `|atwater_delta_pct|` on a food that isn't fiber/sugar-alcohol-heavy, or `source_tier:
   "web"` with no `verified_fields`** → treat as a hint, not a source. Web-search to corroborate
   before logging something a user will rely on, especially for a new/unfamiliar food.
5. **The user has the physical package in hand** → this is strictly better evidence than any
   database lookup. Prefer asking them to read the label over trusting a plausible-looking number,
   *especially* for branded packaged foods (bars, yogurt cups, drinks) — these are exactly the
   foods most likely to have a small serving weight, which is exactly the failure shape that
   overstates by the largest margin.

## Correcting a wrong entry from a physical label

Use `nutrition_override` with `basis: "per_serving"` (the default) — paste the label's numbers in
directly, no need to do the per-100g division yourself:

```jsonc
{
  "id": "on_fd_vUZSKMYWbRkt",
  "basis": "per_serving",
  "serving_weight_g": 70,
  "calories": 300,
  "protein": 18
}
```

`serving_weight_g` is **required** in the same call whenever you're correcting any macro field
under `basis: "per_serving"` — the server will reject the call rather than guess using whatever
weight happens to already be stored, since that stored weight may be exactly what's wrong.

This creates (or updates, if you've corrected this food before) a `web`-tier row that takes
precedence over the original on barcode lookup, and is signaled via `is_correction`/
`superseded_by` on search, direct lookup, and cache listing — so the correction actually gets used
on every future lookup, not just the one you happened to make it from.

You only need to supply the fields you're actually correcting — everything else is inherited from
the original row unchanged, and `verified_fields` tracks exactly which fields you've verified
(accumulating across repeated corrections, not resetting).
