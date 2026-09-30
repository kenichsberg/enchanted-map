## Context

`guardFor` in `src/analysis/branches.ts` returns a `Condition` for every enclosing construct
it recognises, and `conditionLabel` joins all of them with `&&`. That was written against a
fixture whose guards were all `if`/`else`/`for`, where every guard genuinely selects.

Real code uses `with` as a structuring idiom. `StratificationOrchestrator.run` wraps each
pipeline phase in `with self._logged_step(...)`, so each of its eleven steps prints its own
label twice and every line is long enough to hide the call it describes.

## Goals / Non-Goals

**Goals:**

- Distinguish guards that select a path from guards that do not.
- Keep the edge label to guards that tell a reader something about *whether* the call runs.
- Retain every guard in the data, so nothing is lost and a later change can surface context.

**Non-Goals:**

- Deciding how context guards should eventually be displayed. This change removes them from
  the condition label; presenting them as context is a separate question with its own design.
- Changing negation, conjunction, or ordering for the guards that still label.
- Any change to dispatch resolution, nesting, or ordering.

## Decisions

### D1. Three categories, by effect on control flow

```
branch   if · elif · else · match case · except · conditional expression
         the body runs instead of some other body

loop     for · while
         the body runs zero or more times

context  with · finally
         the body always runs
```

*Why three and not two:* collapsing `loop` into `branch` loses the fact that a loop body may
not run at all, which is worth seeing; collapsing it into `context` claims the body always
runs, which is false for an empty sequence. Neither is true enough to justify the smaller
model.

### D2. `except` is a branch

Its body runs only when the matching error is raised, which is a selection between paths.

*Stated because I expect disagreement:* unlike an `if`, the condition is implicit — the label
reads as an exception type rather than as a test. It is still a selection, and a reader
seeing a call only reachable on `except ValueError` has learned something real.

### D3. Label from branch and loop; retain context

The rendered condition label is built from branch and loop guards. Context guards stay in the
stored list with their category and are simply not rendered as conditions.

*Why retain rather than drop:* `with transaction():` and `with lock:` are worth knowing, and
a guard that was discarded at extraction time cannot be surfaced later without re-analysis.
The cost of keeping them is a few bytes per edge in a file that is already regenerable.

### D4. Only the guards that label participate in the edge's dependency hash

**Revised during implementation.** The original decision was to write the category into the
serialised condition alongside the kind and text. Measured against the fixture, that changed
the hash of *every guarded edge*, including ones whose label did not move:

```
                 guarded  context-guarded   hash changed
  login                3                0              3   <- all spurious
  broadcast            4                0              4   <- all spurious
  with_structured      4                4              4
```

Churn with no meaning behind it is the fastest way to teach someone that staleness reports
are noise, and this project has already fixed that failure twice (line-numbered symbol ids,
and the source ordinal in the edge hash). Writing a third instance of it into the hash to
satisfy a hypothetical was the wrong trade.

`serialiseConditions` therefore excludes `context` guards and leaves the remaining format
untouched. The churn is then exactly the edges whose label really changed:

```
                 guarded  context-guarded   hash changed
  login                3                0              0
  broadcast            4                0              0
  with_structured      4                4              4
  with_try             2                1              1
```

*Cost, stated plainly:* reclassifying a construct between `branch` and `loop` would not
register in the hash. That can only happen through an edit to the classification table in
this repository, never through a change to the analysed code, so it is a re-analysis to
remember when revising the table rather than a detection to rely on.

### D5. The label change is a one-off staleness event, not a migration

A stored flow with an edge inside a `with` sees that edge's label and hash change, and
reports stale on the next check. Edges guarded only by selecting constructs are untouched
(see D4 as revised).

*Why not suppress it:* the label genuinely changed, and a staleness report that hides a real
change to protect the user from churn is the wrong trade — it teaches them the report is
unreliable. Re-analysis costs a second.

## Risks / Trade-offs

- **The categorisation is a judgement, and `except` is the arguable one** (D2) → It is one
  line to move if it reads badly in practice. The categories are data, not structure, so
  reclassifying is not a redesign.

- **A `with` that does gate execution** → `with suppress(Error):` changes whether the code
  after it in the block runs, and a context manager can swallow an exception. The body still
  always *starts*, which is what the category claims, but a reader could reasonably want that
  distinction. Out of scope, and worth knowing this model does not capture it.

- **One-off staleness for existing maps** (D5) → Accepted and explained above.

- **Loop guards still produce long labels** → `[for user in users && urgent]` is kept because
  it is informative, but a loop over a long expression is still a long label. Truncation is a
  presentation concern this change does not address.

## Migration Plan

1. Categorise in `guardFor`, with unit tests per construct.
2. Filter the label in `conditionLabel`; assert the fixture's `if`/`else`/`for` labels are
   unchanged.
3. Include the category in the edge hash.
4. Verify on `CVDLINK/stratification` that `StratificationOrchestrator.run` reads as eleven
   steps with no `_logged_step` guard text.

Rollback is reverting the label filter; the stored category is inert without it.

## Verified on CVDLINK

`stratification`, `StratificationOrchestrator.run`, depth 1 — the case that prompted this:

```
before                                                    after
0. run -> _logged_step   [self._logged_step("Data          0. run -> _logged_step
                          loading", "Loading dataset")]
1. run -> _load_dataset  [self._logged_step("Data          1. run -> _load_dataset
                          loading", "Loading dataset")]
3. run -> _logged_step   [self._logged_step("Data          3. run -> _logged_step
                          validation", "Starting data
                          validation")]
```

All eleven pipeline steps now read as a sequence. No `_logged_step` guard text remains, and
no selecting guard was lost.

One thing this made visible that the guard noise was hiding: `run -> _logged_step` still
appears once per phase, because the context manager is itself a call. That is correct — it
is a call the code makes — and collapsing it is a judgement about what is interesting rather
than about what is true, which is the agent layer's job and not this one's.

## Open Questions

- Should a loop guard be rendered differently from a branch guard, given it says "may run"
  rather than "runs instead of"? They are conjoined into one label today, which reads as
  though both are conditions of the same kind.
- Should `finally` be context or its own thing? Its body runs on both the normal and the
  error path, which is "always" in the sense that matters here, but it is reached from two
  quite different places.
- Does an `async with` need separate treatment? Structurally identical, so it should fall out,
  but the fixture has no async code and the grammar node type differs.
