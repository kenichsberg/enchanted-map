## 1. Fact extraction

- [x] 1.1 Extend `BranchIndex` with a lookup that, for a call-site range, returns the call
      expression's byte offset and its enclosing call expression when it has one
- [x] 1.2 Extend `CallSite` and `Edge` with `ordinal`, `kind` (`call` | `argument`) and
      `enclosingSite`, keeping the existing pair-ordinal in `edgeId` untouched and named
      distinctly from the new source ordinal
- [x] 1.3 Assign each caller's ordinals by ascending source position during traversal,
      independently of the order the language server reported the call sites in
- [x] 1.4 Classify each call site as `call` or `argument`, recording the enclosing call
      site's id for an argument
- [x] 1.5 Extend the CLI fact dump to show ordinal, kind and enclosing site
- [x] 1.6 Verify against the fixture that `login` reproduces the expected table: `audit`,
      `notify`, `SMSSender` (argument of `notify`), `create_session`, `audit`

## 2. Fact extraction tests

- [x] 2.1 Test that ordinals follow source order when the language server groups call sites
      by callee
- [x] 2.2 Test that a call in an argument position records `kind: argument` and names the
      call site it feeds
- [x] 2.3 Test that a statement-level call records `kind: call` and no enclosing site
- [x] 2.4 Test two calls in one argument list: same enclosing site, ordered between themselves
- [x] 2.5 Test that the set of reached symbols and their depths are unchanged by this work

## 3. Persistence and hashing

- [x] 3.1 Persist `ordinal`, `kind` and `enclosingSite` in the stored flow format
- [x] 3.2 Include `kind` and `enclosingSite` in the edge's dependency hash; exclude `ordinal`
- [x] 3.3 Test that inserting a call at the top of a function leaves the later edges'
      dependency hashes unchanged
- [x] 3.4 Test that moving a call from statement level into an argument position does change
      that edge's dependency hash
- [x] 3.5 Treat a stored flow lacking the new fields as needing re-analysis, and confirm
      curation in `judgments` survives that re-analysis

## 4. Dispatch heuristic

- [x] 4.1 Retarget `#resolveByConstruction` to match candidates constructed as arguments of
      the call reaching the dispatching function, replacing the shared-line test
- [x] 4.2 Keep the conservative rule intact: exactly one distinct candidate resolves,
      anything else leaves the hole open
- [x] 4.3 Run the existing dispatch tests unchanged as the gate for this step
- [x] 4.4 Add a fixture case where a candidate is constructed on the same line as the call
      but is not an argument of it, and test that it is not treated as evidence

## 5. Views

- [x] 5.1 Emit a caller's edges in source order in the whole-flow view
- [x] 5.2 Present an argument edge as subordinate to the call it feeds, identifiable as
      evaluated first
- [x] 5.3 Confirm the view's node count is unchanged by nesting
- [x] 5.4 Test ordering, subordination, sibling ordering within one argument list, and that
      a flow with no nesting is presented exactly as before
- [x] 5.5 Assert all of the above on view objects with no surface attached

## 6. Browser canvas

- [x] 6.1 Render an argument edge subordinate to the call it feeds
- [x] 6.2 Make an argument edge visually distinct from a statement-level call without
      relying on its label
- [x] 6.3 Collapse nesting deeper than two levels behind a marker, keeping the full
      structure in the view object
- [x] 6.4 Render the flow in a browser and confirm `login` shows `SMSSender` beneath
      `notify`, not beside it

## 7. Editor surface

- [x] 7.1 Show each call's position in the flow listing, in source order
- [x] 7.2 Mark an argument call as subordinate in the listing
- [x] 7.3 Extend the headless Neovim test to assert both, without a configured root

## 8. End-to-end validation

- [x] 8.1 Verify on the fixture that `login`'s listing reads `audit`, `notify` with
      `SMSSender` beneath it, `create_session`, `audit` — in that order
- [x] 8.2 Verify `broadcast` still leaves its dispatch hole open with both candidates
- [x] 8.3 Verify on a real Python module that ordering and nesting are produced, and record
      whether expression nesting depth there argues for a different collapse threshold
- [x] 8.4 Run the full suite and the Neovim checks, confirming no existing test needed
      modification to pass
