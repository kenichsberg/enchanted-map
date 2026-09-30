## Why

The map presents a caller's outgoing calls as an unordered set of siblings, which
misrepresents what the code does. In `notify(SMSSender(), "code")` the constructor is
evaluated first and its result is passed into `notify`, but the map shows `notify` and
`SMSSender` as two independent children of `login` — and in an arbitrary order, because the
language server groups call sites by callee rather than by position.

A map that claims to show code flow but has no notion of sequence or of one call feeding
another is not showing flow; it is showing an adjacency set. This is the first thing a
reader notices and the first thing that makes them distrust the picture.

Both facts are already available from the tree-sitter parse the analyzer performs for branch
conditions: source order from the call expression's byte offset, and argument nesting from
its enclosing call node. No language server work and no inference is involved.

## What Changes

- **Call sites gain a source ordinal.** Every call site records its position within the
  caller, so a flow can be presented in the order the code actually runs rather than in the
  order the language server happened to report.
- **Edges gain a kind.** An edge is either a `call` — invoked from statement level in the
  caller's body — or an `argument`, meaning the call is lexically an argument of another
  call and is evaluated before it. An `argument` edge records which call site it feeds.
- **BREAKING (stored format).** `Edge` gains `ordinal`, `kind` and `enclosingSite`. Stored
  flow files written by the previous version lack these fields; the change must either
  migrate them or treat their absence as a reason to re-analyze. Flow files are derived
  from source, so re-analysis is the cheap path.
- **Views present order and nesting.** The whole-flow view emits edges in source order, and
  an argument edge is presented as subordinate to the call it feeds rather than as a sibling.
- **Both surfaces follow.** The canvas indents an argument edge beneath its consuming call;
  the editor list shows ordinals so sequence is readable without the spatial layout.
- **Constructor-evidence resolution is retargeted.** The heuristic currently matches a
  constructor to a dispatch by *shared line number*, which is a proxy for the nesting
  relationship it is actually trying to express. Once nesting is a recorded fact, the
  heuristic matches on *is an argument of* instead. This is a correctness improvement — the
  line-number proxy is confused by unrelated calls that share a line — but it changes
  dispatch resolution, the most consequential behaviour in the system.

  *This last item is the one judgement call in this proposal.* It could reasonably be its
  own change so that a regression in dispatch resolution does not arrive tangled up with a
  rendering change. It is included here because leaving a known-approximate rule in place
  once the exact fact exists is hard to justify, and because one fixture covers both.

- **Nodes remain functions only.** Nesting is expressed on edges, exactly as branch
  conditions are. Nothing in this change adds a node for a syntactic construct.

## Capabilities

### New Capabilities

None. This change adds facts and presentation to capabilities that already exist.

### Modified Capabilities

- `flow-analysis`: `Call edge extraction` additionally records a source ordinal and, for a
  call nested in another call's arguments, the call site it feeds.
  `Constructor-evidence resolution` matches on argument nesting instead of shared line.
- `flow-views`: `Whole-flow view` presents edges in source order and renders an argument
  edge as subordinate to the call it feeds.
- `map-surfaces`: `Browser canvas` shows an argument edge nested beneath its consuming call;
  `Flow operations from the editor` shows call order in the editor listing.

## Impact

**Affected code:**

- `src/analysis/branches.ts` — a second ancestor walk, alongside the existing one for
  guards, to find the enclosing call expression and the call's byte offset.
- `src/analysis/types.ts` — `Edge` and `CallSite` gain the new fields; `edgeId` must stay
  stable, since edge identity already drives staleness.
- `src/analysis/extract.ts` — populate the fields during traversal.
- `src/analysis/dispatch.ts` — `#resolveByConstruction` matches on nesting rather than line.
- `src/flow/model.ts` — persist the new fields; decide whether they participate in the
  edge's dependency hash.
- `src/views/index.ts` — ordering and the nested presentation.
- `src/sidecar/canvas.html`, `lua/enchanted-map/init.lua` — rendering on both surfaces.

**Dependencies:** none added. Python grammar and basedpyright are already present.

**Risk concentrated in two places:** the dependency hash for edges, since including the
ordinal would make an inserted call above an existing one mark the existing edge stale; and
dispatch resolution, which is the behaviour users trust most.

**Out of scope:** evaluation order *within* an argument list of several calls, operator and
comprehension evaluation order, and any ordering claim that depends on runtime behaviour
rather than syntax. This change describes lexical structure only.
