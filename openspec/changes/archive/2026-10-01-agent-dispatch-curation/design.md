## Context

The deterministic layer emits an `unresolved` record wherever a call dispatches through a
declared type and the constructor-evidence heuristic cannot close it. Each record carries the
call site, a machine-readable reason, and the candidate set from
`textDocument/implementation`. The `judgments` slots in the stored flow have been reserved
since the foundation and never written.

Measured on real code: `broadcast` in the fixture has one hole with two candidates;
`CVDLINK/stratification` has three. These are not analysis gaps to close with more static
work — Python's duck typing means the answer is not in the syntax. They are judgements.

Two decisions were taken before this design: the agent is the user's own Claude Code session
driving an MCP server, and the first judgment is dispatch resolution.

## Goals / Non-Goals

**Goals:**

- Let an agent resolve a hole without being able to invent a symbol.
- Record why, how confident, and on what inputs, so the decision can be re-examined.
- Re-ask only when the inputs change, so the map does not churn.
- Make a judgement visible as a judgement on every surface.
- Build no agent loop, hold no API key, track no model version.

**Non-Goals:**

- Clusters and labels. Free text needs a different validation story and has no test for
  "is this a good name".
- Deciding what to curate. The agent is told which flow; choosing is the human's.
- Curation during analysis, in CI, or on a schedule. Every judgment here is asked for.
- Replacing the constructor-evidence heuristic. Where it resolves, there is no hole.

## Decisions

### D1. An MCP server, not an embedded agent

The sidecar exposes tools; the user's Claude Code session calls them.

*Why:* every alternative means owning an agent loop, an API key, and a model version that
drifts. The capability is the durable part — what a flow is, what a hole is, what makes a
resolution valid — and that is what this repository should hold.

*The consequence that makes it the right shape:* the map becomes a shared artifact. The
agent works, the canvas updates, and the human clicks a node and lands in the editor. An
embedded agent would produce a report; this produces a thing both parties are looking at.

### D2. Resolution is by index into the hole's candidate list

`resolve_dispatch(flow, holeId, candidateIndex, …)`. An index outside the range is rejected,
and the error names the valid candidates.

*Why this over a symbol id:* a symbol id would have to be validated against the index, and
validation is a detection problem — something to get right, and to keep right. An index into
an enumerated set makes the invalid case unrepresentable. The hallucination that the original
design proposed to *reject* cannot be *expressed*.

*Cost:* the agent must fetch the hole to learn the ordering, so the tools are inherently
two-step. That is a fair price for deleting a class of failure.

*What it does NOT guarantee, measured after implementation:* an index guarantees the answer is
a member of the candidate set. It does not guarantee the candidate set contains the answer.
See the risk below -- this was found on the first real repository, not in theory.

### D3. Declining is recorded, not inferred from absence

`decline_dispatch(flow, holeId, reason)` records that the question was considered and could
not be answered.

*Why:* without it, "not yet asked" and "asked and unanswerable" are the same state. The
agent re-asks every session, the human cannot tell whether a hole is new or hopeless, and the
most interesting holes — the genuinely ambiguous ones — look like neglect.

### D4. A judgment is memoised on the hole's dependency hash

The stored judgment carries the hash of the inputs it rested on: the declared target and the
sorted candidate set. A hash miss marks it stale and it is re-asked.

*Why that scope and not the call site's text:* a new implementor appearing is exactly the
event that should reopen the question, and it changes the candidate set. An unrelated edit in
the calling function is not, and does not.

*The gap this leaves, stated because it is real:* if the calling code changes so that a
different candidate now flows in, while the candidate set stays the same, the hash does not
move and the judgment stands. The hash covers what the decision was *about*, not everything
that could make it wrong.

### D5. `agent-inferred` is its own provenance tier

Not folded into `heuristic`, and never rendered as `lsp-verified`.

*Why:* the whole map's usefulness rests on being able to see how much of it is known versus
guessed. A judgement that renders identically to a fact is worse than no judgement, because
it spends trust the layer has not earned.

### D6. A judgment applies only after the deterministic layer has finished

Constructor evidence runs first. A judgment is consulted only where a hole remains.

*Why:* the deterministic answer is reproducible and free. Letting a judgment override it
would mean a probabilistic result where a certain one was available, and would make the
map's content depend on whether anyone had curated it.

### D7. The stored form widens, and the old form still reads

`judgments.dispatch` becomes `callSiteId -> { target, confidence, note, by, at, depHash }`.
A bare string is read as a target with unknown provenance and no hash, which makes it stale
on first check.

*Why not a migration:* flow files are derived except for their judgments, and the judgments
are exactly what cannot be regenerated. Reading the old shape costs three lines; discarding
it would cost a user their curation.

### D8. Human acceptance stays per flow

Accepting a flow accepts the judgments in it, using the mechanism that already exists. No
per-judgment pinning.

*Why:* the same argument as when acceptance was designed. Per-judgment acceptance is too
fine-grained to keep up with, and the flow is the unit a person actually reviews.

## Risks / Trade-offs

- **A wrong resolution is worse than an open hole** → The hole was honest about not knowing;
  a wrong answer is not. Mitigated by the distinct tier, the recorded confidence, the
  required acceptance, and one-call withdrawal — and not removed by any of them. This is the
  central risk of the change and should be re-evaluated after real use, not argued away here.

- **The candidate set can be incomplete, and index-resolution cannot say so** → Measured on
  `experiments/FeatureCloud`, at `FeatureCloud/app/engine/app.py:271`, `self.current_state.run()`
  dispatching through the abstract `AppState.run`. Four implementations exist
  (`BlankState.run`, `CopyState.run`, `ConfigState.run` in `library.py`, and a nested
  `TerminalState.run`). `textDocument/implementation` reported exactly one: the nested class in
  the same file. The three that matter were never offered.

  So the agent is handed a one-element list and asked to pick, and the honest answer is not in
  it. D2 holds -- nothing invented can be expressed -- but it bounds the answer to the candidate
  set, and the candidate set is itself derived and can be wrong. An agent that reads the list as
  exhaustive will record a structurally valid, confidently wrong resolution, and no tier or
  confidence field catches that, because the shape is correct.

  Worse than incomplete: the single offered candidate is *dead at that call site*. `TerminalState`
  is registered as `'terminal'`, and `App.run` reassigns `self.current_state` through
  `transition()` and then returns from inside the terminal drain loop, so line 271 is never
  reached with the terminal state current. Its `run()` is `pass`. The one answer the system
  offered was the one answer that cannot be correct.

  This makes D3 load-bearing rather than a nicety: declining is the only correct move here, and
  without it the choice would be between a wrong answer and silence that reads as neglect. The
  tool description now says the list may be incomplete and to decline when the real target is
  absent. That is mitigation, not a fix. The fix is to stop trusting
  `textDocument/implementation` as the candidate source -- walking the subclass tree directly --
  and that is its own change.

  *Verified against a real agent session (task 7.1).* Given this hole, the agent declined, and
  gave both reasons: that the states are registered at runtime by a decorator and supplied by
  downstream packages outside the repository, and that the offered candidate is structurally
  unreachable. It reached that second conclusion by reading the engine itself. So the mechanism
  survived its worst realistic input -- but only because the agent distrusted the candidate list
  it was given, which is a property of the agent, not of this design.

- **D4's blind spot** → A judgment can be quietly wrong after a change to the calling code
  that does not touch the candidate set. Widening the hash to cover the caller would re-ask
  on every unrelated edit, which is the churn failure this project has fixed three times.
  Narrow and occasionally stale beats broad and always noisy, but it is a real hole.

- **Two analysis processes** → Claude Code spawns its own instance while the editor holds
  another, so a repository may have two language servers up. Already an accepted cost of the
  sidecar design; this makes it likelier to happen in practice.

- **Judgments are flow-scoped** → The same dispatch site reached from two flows can be
  resolved differently, which is sometimes correct and sometimes a contradiction nobody sees.
  Out of scope, and worth knowing before someone reports it.

- **A first runtime dependency** → An MCP implementation is the first dependency added since
  the foundation. It sits on the surface layer, so the analysis core stays free of it.

## Migration Plan

1. The judgment shape, its hash, and reading the old form — pure, with unit tests.
2. Applying an accepted judgment to an edge, after the heuristic, with its provenance tier.
3. The MCP server and its tools, tested by calling the tools directly rather than through an
   agent.
4. The tier on every surface.
5. Verify on `CVDLINK/stratification`: resolve its three holes from a Claude Code session,
   confirm the canvas updates live, and confirm re-analysis keeps the judgments.

Rollback is deleting the `judgments.dispatch` entries; nothing else depends on them.

## Open Questions

- Is a numeric confidence meaningful, or does it invite false precision? A coarse tier
  ("certain / likely / guess") may be more honest about what the agent actually knows.
- Should a declined hole be re-asked when its candidate set changes? The hash says yes; the
  human who watched it fail twice may disagree.
- ~~Should the MCP server expose `read_span`?~~ **Answered: no.** In the 7.1 session the agent
  used its own file tools and followed the dispatch through `app_state`, `_register_state` and
  `transition()` to establish that the offered candidate was unreachable. A `read_span` scoped
  to the call site would have shown it less, not more, and would have implied the span was the
  evidence that mattered. The agent's own tools read wider than any span this server would have
  thought to offer.
- Does a judgment belong to a flow or to a call site? Flow-scoped is what the format has, and
  it permits two flows to disagree about the same site. Site-scoped would forbid that, and
  would be wrong when the disagreement is real.
