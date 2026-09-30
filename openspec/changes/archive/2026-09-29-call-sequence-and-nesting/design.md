## Context

The analyzer records call edges from `callHierarchy/outgoingCalls`, which reports call sites
grouped by callee. Nothing in the pipeline preserves where a call sits relative to its
siblings, or whether it is lexically inside another call's argument list. The result, for
`notify(SMSSender(), "code")`:

```
login -> audit           line 21
login -> audit           line 29        <- out of order
login -> notify          line 25 col 8
login -> SMSSender       line 25 col 15 <- inside notify's parens
login -> create_session  line 27
```

Both missing facts are already in reach. The analyzer parses every analysed file with
tree-sitter to collect branch guards; the same tree yields a call expression's byte offset
and its enclosing call node. Confirmed against the fixture:

```
byte  543  L21C4   audit           (statement level)
byte  707  L25C8   notify          (statement level)
byte  714  L25C15  SMSSender       argument of -> notify
byte  753  L27C8   create_session  (statement level)
byte  858  L29C4   audit           (statement level)
```

This is a deterministic-layer change. No language server capability, no inference, no new
dependency.

## Goals / Non-Goals

**Goals:**

- Present a caller's calls in the order they appear in source.
- Represent "this call is an argument of that call" as a recorded fact, not a coincidence.
- Keep nodes as functions, expressing nesting on edges as guards already are.
- Replace the dispatch heuristic's line-number proxy with the relationship it approximates.
- Leave edge identity and staleness behaviour unchanged, so this does not churn stored maps.

**Non-Goals:**

- Runtime evaluation order. This change describes lexical structure. Python evaluates
  arguments before the call that consumes them, which makes the one ordering claim here
  sound, but no general execution-order claim is made.
- Ordering within operators, comprehensions, decorators, or default arguments.
- Changing traversal, depth bounds, or which symbols are reached.
- Any change to how holes, provenance tiers, or branch conditions work.

## Decisions

### D1. Ordinal is a per-caller index in source order

Each call site records an integer position among all call sites in the same caller, assigned
by ascending byte offset of the call expression.

*Why an index rather than the byte offset itself:* the offset is a location, and locations
move. An index is what the view needs for "first, then, then", and it survives reformatting
that shifts every byte.

*Alternative rejected:* sorting by line and column at render time. It works for the simple
case, but two calls on one line still need the column, and the view layer would be
re-deriving a fact the analyzer already has.

### D2. Edges carry a kind, and an argument edge names what it feeds

```
kind: "call"      invoked from statement level in the caller's body
kind: "argument"  lexically an argument of another call, evaluated before it
                  enclosingSite: the call site it feeds
```

*Why on the edge:* the relationship is about a call, not about a function. `SMSSender` is
not intrinsically subordinate to `notify`; it is subordinate *at this call site*, and
elsewhere it may be called at statement level. This mirrors branch conditions, which are
edge attributes for the same reason.

*Alternative rejected:* a synthetic node representing the call expression. It would let the
graph nest naturally, but it breaks the invariant that nodes are functions, and it inflates
the graph in exactly the expression-heavy code that most needs summarising.

### D3. Nesting does not change traversal or depth

`SMSSender()` is still a call made by `login`, so it is still reached at the same depth and
still expanded under the same rules. `kind` and `enclosingSite` are descriptive metadata.

*Why:* keeping traversal untouched means this change cannot alter which symbols appear in a
flow, only how they are presented. That confines the blast radius to presentation and the
dispatch heuristic.

### D4. The ordinal is excluded from the edge's dependency hash; the kind is included

```
ordinal        -> location metadata. NOT hashed.
kind           -> semantic. hashed.
enclosingSite  -> semantic. hashed.
```

*Why this split matters more than it looks:* including the ordinal would mean inserting one
call at the top of a function renumbers every later call and marks all of their edges stale.
That is precisely the "a small change looks like a big one" failure that line-numbered
identifiers caused before, and it would undo that fix in a new place.

A call moving from statement level into an argument position is, by contrast, a genuine
change to what the code does, and should mark the edge stale.

### D5. Edge identity is unchanged

Edge ids remain `<from>-><to>#<ordinal-within-pair>`. This change does not touch identity,
so stored maps continue to reconcile exactly as they do today.

*Note:* the pair-ordinal in the id and the new source ordinal are different numbers serving
different purposes. Naming them distinctly in the code matters.

### D6. Constructor evidence matches on argument nesting, not shared line

The heuristic resolves a dispatch when exactly one candidate implementation is constructed
and reaches the dispatching function. Today it finds that constructor by asking which sibling
edges share a line with the call into the dispatching function. It becomes: which edges are
`argument` edges whose `enclosingSite` is that call site.

*Why:* the line test is a proxy for the nesting relationship, and a lossy one. Two unrelated
calls on one line satisfy it; a call split across lines does not. The conservative rule is
kept exactly as it is — one distinct candidate resolves, anything else leaves the hole open.
Only the predicate for "reaches that call site" becomes exact.

*Risk accepted:* this is the most consequential behaviour in the system. The existing
dispatch tests are the guard; all of them must pass unchanged, and the fixture's ambiguous
cases must remain unresolved.

### D7. Presentation

The canvas indents an argument edge beneath the call it feeds and marks it as evaluated
first. The editor list shows ordinals, since a text list has no spatial axis to carry order.

Deep nesting is bounded by presentation, not by dropping facts: beyond a small depth the
canvas may collapse an argument subtree behind a marker, while the underlying view object
retains the full structure.

### D8. Stored flows without the new fields are re-analyzed, not migrated

A flow file lacking `ordinal` or `kind` is treated as needing re-analysis rather than being
rewritten in place.

*Why:* flow files are derived from source. A migration would have to invent the fields from
data it does not have, and re-analysis produces them correctly for a few hundred
milliseconds of work. The curation in `judgments` survives re-analysis, which is the part
that could not be regenerated.

## Risks / Trade-offs

- **Ordinal churn if D4 is got wrong** → Including the ordinal in the dependency hash would
  make any inserted call mark every later edge stale, and the map would be permanently noisy.
  This is the same class of bug that line-numbered symbol ids caused. The test for it is
  direct: insert a call at the top of a function and assert the later edges' hashes are
  unchanged.

- **Dispatch regression from D6** → Retargeting the heuristic changes the system's most
  trusted output. Mitigated by keeping the conservative "exactly one candidate" rule intact
  and requiring every existing dispatch test to pass untouched. If the new predicate proves
  less reliable in practice, D6 can be reverted independently of the rest of this change.

- **Visual depth in expression-heavy code** → `f(g(h(x)))` nests three deep at one call site.
  Bounded by D7's collapse behaviour. Python's typical style limits this in practice, but a
  language with heavier expression nesting would feel it more.

- **Several call arguments at one site** → `notify(f(), g())` produces two argument edges
  with the same `enclosingSite`, ordered between themselves by ordinal. Correct, but it
  means `enclosingSite` is one-to-many and consumers must not assume a single child.

- **The ordering claim is lexical, not runtime** → A reader may take "1, 2, 3" as execution
  order. For statement-level calls in straight-line code it is; across branches it is not,
  since only one arm runs. The guards already on the edges are what disambiguate this, and
  the view should not imply more certainty than it has.

## Migration Plan

1. Extend the fact schema and populate it in extraction. Verify via the CLI fact dump that
   the fixture reproduces the byte-offset and enclosing-call table above.
2. Add hashing for `kind` and `enclosingSite`; assert the ordinal does not participate.
3. Retarget the dispatch heuristic, running the existing dispatch tests unchanged as the gate.
4. Ordering and nesting in the view layer, asserted on view objects with no surface attached.
5. Both surfaces.

Rollback is per step: steps 3 and 4 are independent, and the dispatch retarget can be
reverted without losing ordering.

## Open Questions

- ~~How deep should the canvas nest before collapsing?~~ **Measured during implementation.**
  `json.dumps` from the CPython standard library: 13 edges, 1 argument, maximum nesting
  depth 1 (12 edges at depth 0, one at depth 1). A threshold of two levels is therefore
  generous for ordinary Python — collapsing will rarely trigger, which is the right default.
  Expression-heavy code in another language would need this revisited, and the threshold is
  a single constant in the canvas.
- Should an argument edge that is *also* an unresolved dispatch be marked with both, or does
  one marker dominate? Likely both, but it needs to be seen rendered before deciding.
- Does the editor list need indentation as well as ordinals, or is the ordinal enough to
  convey subordination in a flat list?
- Should a call in a default-argument position, or inside a decorator, be treated as an
  argument edge? Both are lexically arguments but are evaluated at definition time, not at
  call time — recording them as ordinary arguments would state something untrue about order.
