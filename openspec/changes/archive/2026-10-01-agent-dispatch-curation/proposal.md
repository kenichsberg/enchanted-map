## Why

The deterministic layer has been emitting holes since the foundation, and nothing consumes
them. `broadcast` in the fixture has a genuine unresolved dispatch with two candidates;
`CVDLINK/stratification` has three. The `judgments` slots in every flow file have been
reserved, documented and empty for the same length of time.

That was deliberate: establish what can be known for certain before layering anything
probabilistic on top. The deterministic ceiling is now measured. `textDocument/implementation`
gives the candidate set, the constructor-evidence heuristic closes the single-hop cases, and
what remains is genuinely a judgement — which of these implementations actually runs here.
No amount of further static analysis answers it.

This change fills the first judgment slot, and does it with the one judgment where being
wrong is structurally constrained: the answer is an element of an enumerated set.

## What Changes

- **The sidecar becomes an MCP server**, so the Claude Code session the user already has can
  drive it. Nothing here builds an agent loop, handles an API key, or tracks a model version.
  The tool exposes a capability; the agent that uses it is the user's own.

  The map is then a shared artifact rather than a report: the agent works, the canvas
  updates, and the human clicks a node and lands in the editor at that line.

- **A dispatch judgment is recorded by index, not by name.** `resolve_dispatch` takes a hole
  and an index into that hole's candidate list. A value outside the set is rejected with the
  valid options named. A hallucinated symbol is not detected and reported — it cannot be
  expressed.

- **Declining is a first-class outcome.** An agent that cannot tell records that, with a
  reason, so the hole is not re-asked every session and a human can see that it was
  considered rather than skipped.

- **Judgments carry provenance and a dependency hash**: who decided, when, how confident,
  and the hash of the inputs the decision rested on. When a new implementor appears, the
  candidate set changes, the hash misses, and the judgment is re-asked. Stability comes from
  cache hits, not from the model being repeatable.

- **A resolved edge gains a distinct provenance tier.** `agent-inferred` sits alongside
  `lsp-verified`, `heuristic` and `declared-unresolved`, and every surface shows it as such.
  A judgement that renders identically to a fact is worse than no judgement at all.

- **BREAKING (stored format).** `judgments.dispatch` widens from `callSiteId -> symbolId` to
  carry the metadata above. Files written before this change parse and are read as a bare
  target with unknown provenance.

## Capabilities

### New Capabilities

- `agent-curation`: the MCP surface and the judgment lifecycle — enumerating holes, reading
  the code a decision rests on, recording a resolution by index, declining, withdrawing, and
  the rules that make a recorded judgment valid.

### Modified Capabilities

- `flow-map`: `Judgment slots exist and remain empty` becomes a slot that carries a decision
  with its provenance and dependency hash, and states when a judgment goes stale.
- `flow-views`: the provenance view and the whole-flow view gain the `agent-inferred` tier,
  and a resolved hole leaves the hole list.
- `map-surfaces`: the MCP server joins the editor, the browser and CI as a surface, and the
  canvas and editor listing distinguish an agent-resolved edge.

## Impact

**Affected code:**

- `src/sidecar/` — an MCP server alongside the existing stdio RPC and HTTP canvas.
- `src/flow/model.ts` — the dispatch judgment shape, its hash, and reading the old form.
- `src/analysis/dispatch.ts` or a new module — applying an accepted judgment to an edge,
  after the deterministic heuristic has had its say.
- `src/views/index.ts`, `src/sidecar/render.mjs`, `lua/enchanted-map/init.lua` — the tier.
- `src/cli.ts` — an `mcp` command, and showing judgments in the text views.

**New dependency:** an MCP server implementation. This is the first runtime dependency added
since the foundation, and it sits on the surface layer rather than in analysis.

**Risk, stated plainly:** a wrong resolution is worse than an open hole, because it looks
settled. The hole was at least honest about not knowing. Everything above — the distinct
tier, the recorded confidence, the required human acceptance, the one-call withdrawal — exists
because of that asymmetry, and none of it removes it.

**Out of scope:** clusters and labels (free text, and a different validation problem
entirely), the agent choosing which flows to curate, automatic curation on analysis, CI
running an agent, and any judgment the deterministic layer could have made itself.
