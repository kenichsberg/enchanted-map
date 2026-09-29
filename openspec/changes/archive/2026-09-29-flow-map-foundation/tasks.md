## 1. Project setup

- [x] 1.1 Initialise the TypeScript/Node workspace for the sidecar with build and test scripts
- [x] 1.2 Add `basedpyright`, tree-sitter (WASM runtime), and the Python grammar as dependencies
- [x] 1.3 Add a Python fixture repository under test fixtures, including the base-type dispatch
      case (`Sender` / `SMSSender` / `notify` / `login`) that reproduces the unresolved hole
- [x] 1.4 Create the Neovim plugin skeleton with the commands stubbed but unimplemented
- [x] 1.5 Add `.enchanted/cache/` to version control ignore rules

## 2. Language server client

- [x] 2.1 Implement a JSON-RPC stdio client with Content-Length framing that skips
      notifications and correlates responses by request id
- [x] 2.2 Implement `basedpyright` spawn, initialize handshake, and shutdown; ensure the
      process is killed when the analyzer exits
- [x] 2.3 Assert `callHierarchyProvider` and `implementationProvider` at initialize and fail
      with the attempted command when either is absent
- [x] 2.4 Implement `textDocument/didOpen` synchronisation for analysed files
- [x] 2.5 Write an integration test proving analysis completes with no editor process running

## 3. Fact extraction

- [x] 3.1 Implement `prepareCallHierarchy` and `callHierarchy/outgoingCalls`, recording caller,
      callee, callee location, and each `fromRanges` call site
- [x] 3.2 Preserve multiple distinct call sites between the same caller and callee
- [x] 3.3 Implement bounded traversal from a root symbol with cycle detection, recording both
      the depth-truncated frontier and detected cycles
- [x] 3.4 Define the fact schema: symbols, edges, call sites, candidates, unresolved records
- [x] 3.5 Add a CLI command that dumps facts for a symbol, for verification without a surface
- [x] 3.6 Record symbols outside the project root without expanding them, and label their
      locations portably so committed flow files carry no installation-specific path

## 4. Branch context

- [x] 4.1 Parse analysed files with tree-sitter and build a byte-range to node lookup
- [x] 4.2 Implement the ancestor walk collecting `if`, `elif`, `else`, `match`/`case`, `for`,
      `while`, `try`/`except`, and `with` guards for a given call-site range
- [x] 4.3 Attach the ordered condition list to the edge, never to a node
- [x] 4.4 Test the fixture cases: unguarded call, `if` branch, `else` branch, nested guards

## 5. Dispatch resolution and holes

- [x] 5.1 Query `textDocument/implementation` for calls resolving to a declared or base type
      and record the candidate set
- [x] 5.2 Emit `unresolved` records with call site, machine-readable reason, and candidates;
      retain the declared-target edge at reduced confidence
- [x] 5.3 Assign a provenance tier to every edge: language-server-verified, heuristically
      resolved, or declared-target-unresolved
- [x] 5.4 Implement the single-hop constructor-evidence heuristic, resolving only when exactly
      one candidate is constructed in the flow and reaches the call site
- [x] 5.5 Test that two constructed candidates leave the hole open
- [x] 5.6 Expose all unresolved records for a flow as one enumerable collection

## 6. Caching and incremental analysis

- [x] 6.1 Implement content-hash keyed fact caching outside version control
- [x] 6.2 Serve unchanged symbols from cache, issuing no language server requests
- [x] 6.3 Scope re-analysis to changed symbols and their bounded neighbourhood
- [x] 6.4 Test that editing one function does not trigger whole-repository analysis

## 7. Flow model and persistence

- [x] 7.1 Define the project configuration format for declared entry points
- [x] 7.2 Implement flow resolution from an entry point declaration, reporting broken flows
      without deleting their stored files
- [x] 7.3 Define the flow file format, including reserved judgment slots that parse but are
      never populated by inference
- [x] 7.4 Implement one-file-per-flow read and write with stable ordering, verified by
      byte-identical round trip
- [x] 7.5 Implement dependency-scoped hashing so each entry hashes only the inputs it used
- [x] 7.6 Test that an unrelated edit leaves an entry's hash unchanged

## 8. Node identity and staleness

- [x] 8.1 Implement file-move identity using version control rename detection
- [x] 8.2 Implement rename identity via removed-plus-added symbol with identical
      implementation-body hash (signature excluded) in the same file, keeping the
      full-definition hash for staleness
- [x] 8.3 Invalidate all other non-matching cases without approximate matching
- [x] 8.4 Implement per-entry staleness detection attributed to the affected node or edge
- [x] 8.5 Implement the per-flow acceptance stamp and the accepted-but-drifted state
- [x] 8.6 Test the partially stale flow: only affected nodes marked, remainder readable

## 9. Views

- [x] 9.1 Define the serialisable view object and prove it is produced with no surface attached
- [x] 9.2 Implement the whole-flow view with conditions on edges, marked truncation, and
      marked cycles
- [x] 9.3 Implement the diff view against a revision: added and removed nodes and edges,
      condition-changed edges, and newly reachable nodes
- [x] 9.4 Ensure a modified condition reports as condition-changed, not remove-plus-add
- [x] 9.5 Implement the staleness view with per-node and per-edge attribution
- [x] 9.6 Implement the provenance view exposing tiers and candidate sets
- [x] 9.7 Test every view by asserting on view objects, with no surface attached

## 10. Neovim surface

- [x] 10.1 Implement sidecar spawn on first use, process-channel RPC, and termination on exit
- [x] 10.2 Report sidecar crashes and allow retry without restarting Neovim
- [x] 10.3 Implement the declare-entry-point command operating on the symbol at the cursor
- [x] 10.4 Implement the open-flow command rendering view output as a navigable list
- [x] 10.5 Implement the accept-flow command writing the acceptance stamp
- [x] 10.6 Implement jump-to-source, refusing with an explanation when the location is invalid

## 11. Browser surface

- [x] 11.1 Serve the canvas bundle and view snapshots over HTTP from the sidecar
- [x] 11.2 Implement the WebSocket channel and push updates on re-analysis without page reload
- [x] 11.3 Render the flow with nodes as functions and conditions as edge labels
- [x] 11.4 Render provenance tiers and staleness distinguishably
- [x] 11.5 Implement click-to-jump routing from canvas through sidecar to Neovim

## 12. CI check

- [x] 12.1 Implement the headless staleness check command
- [x] 12.2 List affected flows with their stale entries and exit non-zero when drifted
- [x] 12.3 Exit zero and report nothing when the map is current
- [x] 12.4 Test that the check never modifies a stored flow file

## 13. End-to-end validation

- [x] 13.1 Verify on the fixture repository that `login` produces edges to `notify` and
      `create_session` with the correct branch conditions on each edge
- [x] 13.2 Verify the dispatch hole is recorded with `SMSSender.send` among its candidates
- [x] 13.3 Verify the full loop on a real Python repository: declare, analyze, view, accept,
      change code, re-check staleness
- [x] 13.4 Measure analysis time at depth 3 on a real repository and record whether the
      default depth needs revising
