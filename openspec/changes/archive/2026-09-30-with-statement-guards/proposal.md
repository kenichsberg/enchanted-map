## Why

Every guarding construct is treated as a condition, so a call inside
`with self._logged_step("Data loading", "Loading dataset"):` carries that whole expression as
its guard label. On a real orchestrator the result is unreadable:

```
0. run -> _logged_step   [self._logged_step("Data loading", "Loading dataset")]
1. run -> _load_dataset  [self._logged_step("Data loading", "Loading dataset")]
3. run -> _logged_step   [self._logged_step("Data validation", "Starting data validation")]
4. run -> _validate_...  [self._logged_step("Data validation", "Starting data validation")]
```

The label is not wrong — the call really is inside that `with` — but it is not a *branch*. A
`with` body always runs. The label answers a question nobody asked, and crowds out the one
case where a guard carries real information: `[mfa]` versus `[!mfa]`, where the condition
tells you which path was taken.

The underlying mistake is that guards were modelled as a single kind. They are not: an `if`
selects between paths, a `for` may run its body zero or more times, and a `with` always runs
it. Only the first is a branch.

## What Changes

- **Guards are categorised** by what they do to control flow:

  ```
  branch    if · elif · else · match case · except · conditional expression
  loop      for · while
  context   with · finally
  ```

- **The edge label carries branch and loop guards; context guards are excluded from it.**
  Whether a call is inside a `with` is still recorded — it is real structure, and
  `with transaction():` is worth knowing — but it stops masquerading as a condition.
- **Nothing is discarded.** Context guards remain in the stored condition list with their
  category, so a consumer that wants them can render them, and a later change could surface
  them as context rather than as a guard.
- **The conjunction rule is unchanged** for the guards that still label: nested branch and
  loop guards join as before, outermost first.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `flow-analysis`: `Branch condition extraction` categorises each collected guard, and
  specifies which categories participate in an edge's condition label.
- `flow-views`: `Whole-flow view` states that the rendered condition label is built from
  selecting guards, so a context guard does not appear as a condition.

## Impact

**Affected code:**

- `src/analysis/branches.ts` — `guardFor` assigns a category alongside the existing kind.
- `src/analysis/types.ts` — `Condition` gains the category.
- `src/views/index.ts` — `conditionLabel` filters by category.
- `src/flow/model.ts` — the edge dependency hash serialises conditions; the category must be
  included, since a construct changing category is a real change.

**Risk:** the categorisation is a judgement per construct, and `except` is the one I would
expect disagreement on. An `except` clause body runs only when the corresponding error is
raised, which is a selection, so it is a branch here — but it is a selection on an implicit
condition rather than a written one, and its label reads as a type name rather than a test.

**Behavioural consequence:** every existing stored flow whose edges sit inside a `with` will
see its condition label change, so those edges' dependency hashes move and the flows report
stale. That is correct — the label genuinely changed — but it is a one-off churn for anyone
with a stored map.

**Out of scope:** rendering context guards as context (a separate presentation question),
and any change to how conditions are negated or conjoined.
