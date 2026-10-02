## 1. The judgment shape

- [x] 1.1 Define the dispatch judgment: chosen target, author, time, confidence, optional
      note, and the hash of the hole it answered
- [x] 1.2 Widen `judgments.dispatch` to hold it, reading a bare string as a decision of
      unknown provenance
- [x] 1.3 Hash a judgment on the hole's inputs — declared target and sorted candidates —
      reusing the existing hole hash rather than inventing a second one
- [x] 1.4 Record a decline as its own outcome, distinguishable from never-asked and from a
      resolution
- [x] 1.5 Unit-test the shape, the old-form read, and that a judgment with no hash is stale

## 2. Applying a judgment

- [x] 2.1 Resolve an edge from a current judgment, after constructor evidence has had its say
- [x] 2.2 Mark such an edge `agent-inferred`, retaining its declared target and candidates
- [x] 2.3 Remove a resolved hole from the flow's unresolved list
- [x] 2.4 Leave the edge unresolved and the hole listed when the judgment is stale
- [x] 2.5 Leave the edge unresolved for a declined hole
- [x] 2.6 Test that a deterministic resolution is never overridden by a judgment

## 3. Staleness

- [x] 3.1 Report a judgment stale when the candidate set changes
- [x] 3.2 Test that a new implementor reopens the question
- [x] 3.3 Test that an unrelated edit in the flow does not
- [x] 3.4 Confirm the staleness check reports stale judgments and writes nothing

## 4. The MCP surface

- [x] 4.1 Add an MCP server exposing: list flows, get a flow's holes, resolve a hole by
      candidate position, decline a hole, withdraw a judgment
- [x] 4.2 Reject a position outside the candidate list, naming the valid candidates
- [x] 4.3 Reject an unknown hole or flow, storing nothing
- [x] 4.4 Mark an already-judged hole so it is not re-answered
- [x] 4.5 Add an `mcp` command, and document the one-line Claude Code registration
- [x] 4.6 Test every tool by calling it directly, without an agent in the loop

## 5. Surfaces

- [x] 5.1 Show the `agent-inferred` tier in the provenance view with its confidence and the
      candidates that were available
- [x] 5.2 Distinguish an agent-inferred edge on the canvas
- [x] 5.3 Distinguish it in the editor listing
- [x] 5.4 Show judgments and their staleness in the CLI views
- [x] 5.5 Confirm a judgment recorded through MCP is visible to the editor and the canvas

## 6. Guardrails

- [x] 6.1 Test that analysis writes no judgment
- [x] 6.2 Test that the staleness check writes no judgment
- [x] 6.3 Test that a judgment cannot name a symbol outside its hole's candidates, by any
      path through the tools

## 7. Verification

- [x] 7.1 Register the server with Claude Code and resolve the fixture's `broadcast` hole
      from a real session
- [x] 7.2 Confirm the canvas shows the resolution live, and clicking it still jumps in nvim
- [x] 7.3 Resolve the three holes in `CVDLINK/stratification` and record what the agent got
      right and wrong — the point of this step is the wrong ones
- [x] 7.4 Re-analyze and confirm the judgments survive and stay current
- [x] 7.5 Add an implementor to the fixture and confirm the affected judgment goes stale
- [x] 7.6 Run the full suite and the Neovim checks
