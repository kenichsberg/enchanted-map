## MODIFIED Requirements

### Requirement: Provenance view

Every edge SHALL carry a provenance tier, and the provenance view MUST make tiers
distinguishable. The tiers are language-server-verified, heuristically resolved,
agent-inferred, and declared-target-unresolved.

An agent-inferred edge MUST be distinguishable from every deterministic tier wherever it is
shown. A judgement that renders identically to a fact spends trust the layer has not earned.

#### Scenario: Tiers are distinguishable
- **WHEN** a flow contains edges of more than one tier
- **THEN** each edge's tier is reported and the tiers are distinguishable from one another

#### Scenario: Unresolved dispatch is visible
- **WHEN** an edge points at a declared target whose concrete implementation is unresolved
- **THEN** the view marks the edge as unresolved and exposes its candidate set

#### Scenario: Holes are reachable from the view
- **WHEN** a flow contains unresolved call sites
- **THEN** the view exposes them as an enumerable collection

#### Scenario: An agent-resolved edge is marked as judged
- **WHEN** a dispatch has been resolved by a recorded judgment
- **THEN** the edge points at the chosen implementation and is reported as agent-inferred,
  not as verified or heuristically resolved

#### Scenario: A resolved hole leaves the hole list
- **WHEN** a hole carries a current judgment
- **THEN** it is no longer presented among the flow's unresolved calls

#### Scenario: A stale judgment does not resolve its edge
- **WHEN** a judgment's inputs have changed since it was recorded
- **THEN** the edge is presented as unresolved again, and the hole returns to the list

#### Scenario: The decision remains inspectable
- **WHEN** an edge is agent-inferred
- **THEN** the view exposes the candidates that were available and the confidence recorded
