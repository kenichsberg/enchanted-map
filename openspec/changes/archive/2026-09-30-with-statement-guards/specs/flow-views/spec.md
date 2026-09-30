## MODIFIED Requirements

### Requirement: Whole-flow view

The whole-flow view SHALL present the entry point and its bounded call tree, with nodes
representing functions only. Branch conditions MUST be carried on edges. The number of nodes
MUST NOT increase as a result of branching.

An edge's rendered condition label SHALL be built from its guards of category `branch` and
`loop`. A guard of category `context` MUST NOT appear in that label, because its body always
runs and presenting it as a condition asserts a choice that does not exist.

Edges MUST be presented in source order. An edge whose call site is an argument of another
call MUST be presented as subordinate to that call rather than as a sibling of it, and MUST
be identifiable as evaluated before the call it feeds. The number of nodes MUST NOT increase
as a result of nesting.

#### Scenario: Branch appears on the edge
- **WHEN** a flow contains a call guarded by a conditional
- **THEN** the condition appears as an attribute of the edge, and no node represents the
  conditional itself

#### Scenario: Nested conditions are presented as one label
- **WHEN** a call is guarded by nested conditions
- **THEN** the edge presents them as a single conjoined label

#### Scenario: Truncation is visible
- **WHEN** traversal stopped at the configured depth bound
- **THEN** the view marks the truncated frontier rather than presenting it as a leaf

#### Scenario: Cycles are marked
- **WHEN** the flow contains a recursive path
- **THEN** the repeated node is marked as a cycle rather than expanded

#### Scenario: Edges are emitted in source order
- **WHEN** a caller's calls were reported grouped by callee
- **THEN** the view emits that caller's edges in the order they appear in the source

#### Scenario: An argument call is subordinate, not a sibling
- **WHEN** a call is an argument of another call from the same caller
- **THEN** the view presents it beneath the call it feeds, and does not present the two as
  independent children of the caller

#### Scenario: Nesting adds no nodes
- **WHEN** a flow contains calls nested in argument positions
- **THEN** the view's node count is the same as it would be if the calls were at statement
  level

#### Scenario: Several arguments of one call are ordered
- **WHEN** two calls are arguments of the same call
- **THEN** both are presented beneath it, in source order relative to one another

#### Scenario: A flow with no nesting is unaffected
- **WHEN** every call in a flow is at statement level
- **THEN** the view presents them as siblings in source order, with no subordination

#### Scenario: A context guard does not appear as a condition
- **WHEN** a call is guarded only by a `with` block
- **THEN** its edge's condition label is empty

#### Scenario: A selecting guard survives an enclosing context guard
- **WHEN** a call is inside a `with` block and inside an `if` within it
- **THEN** the label carries the `if` condition alone
