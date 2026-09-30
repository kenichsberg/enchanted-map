## MODIFIED Requirements

### Requirement: Branch condition extraction

For each call edge, the analyzer SHALL locate the call-site range within the tree-sitter
parse tree and walk the ancestor chain to collect guarding constructs. The resulting ordered
condition list MUST be attached to the edge, not to either node.

Each collected guard MUST carry a category describing its effect on control flow: `branch`
where the body runs instead of another body, `loop` where the body runs zero or more times,
and `context` where the body always runs. Every guard MUST be retained in the list regardless
of category; the category governs presentation, not collection.

#### Scenario: Call guarded by a conditional
- **WHEN** a call appears inside an `if` block
- **THEN** the edge carries that condition, and the graph gains no additional node

#### Scenario: Call guarded by an else branch
- **WHEN** a call appears inside the `else` of the same conditional
- **THEN** the edge carries the negated condition, distinguishable from the `if` branch

#### Scenario: Nested guards
- **WHEN** a call is nested inside two guarding constructs
- **THEN** the edge carries both conditions as an ordered conjunction

#### Scenario: Unguarded call
- **WHEN** a call appears at the top level of a function body
- **THEN** the edge carries an empty condition list

#### Scenario: A selecting construct is categorised as a branch
- **WHEN** a call is guarded by `if`, `elif`, `else`, a `match` case, `except`, or a
  conditional expression
- **THEN** that guard's category is `branch`

#### Scenario: A repeating construct is categorised as a loop
- **WHEN** a call is guarded by `for` or `while`
- **THEN** that guard's category is `loop`

#### Scenario: A construct whose body always runs is categorised as context
- **WHEN** a call is guarded by `with` or `finally`
- **THEN** that guard's category is `context`

#### Scenario: Context guards are still collected
- **WHEN** a call appears inside a `with` block and inside no other construct
- **THEN** the edge's condition list contains that guard, categorised as `context`
