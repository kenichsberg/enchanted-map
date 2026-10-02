# Agent Curation

### Requirement: Holes are offered for judgment

The system SHALL expose the unresolved dispatches of a flow to an agent, each with its call
site, the symbol the language server did resolve, and its candidate implementations in a
stable order. A hole that already carries a current judgment MUST be distinguishable from one
that does not.

#### Scenario: A flow's open holes are listed
- **WHEN** an agent asks for the holes of a flow containing an unresolved dispatch
- **THEN** it receives that hole with its declared target and its candidates

#### Scenario: Candidate order is stable
- **WHEN** the holes of an unchanged flow are requested twice
- **THEN** each hole's candidates appear in the same order both times

#### Scenario: A judged hole is marked as such
- **WHEN** a flow contains one hole with a current judgment and one without
- **THEN** the two are distinguishable, so an agent does not re-answer a settled question

### Requirement: A resolution names a candidate by position

Recording a dispatch resolution SHALL identify the chosen implementation by its position in
that hole's candidate list. A position outside the list MUST be rejected, and the rejection
MUST name the valid candidates. The system MUST NOT accept a resolution that names a symbol
not in the candidate set.

#### Scenario: A valid position is recorded
- **WHEN** an agent resolves a hole to a position within its candidate list
- **THEN** the judgment is stored against that call site, naming the candidate at that position

#### Scenario: A position outside the list is refused
- **WHEN** an agent resolves a hole to a position beyond its candidates
- **THEN** the resolution is refused and the response names the valid candidates

#### Scenario: An unknown hole is refused
- **WHEN** an agent resolves a hole that does not exist in the flow
- **THEN** the resolution is refused and nothing is stored

### Requirement: A judgment records how it was reached

A stored judgment SHALL carry the chosen target, who recorded it, when, an expression of how
confident the decision was, and the hash of the inputs it rested on.

#### Scenario: Provenance is stored with the decision
- **WHEN** a resolution is recorded
- **THEN** the stored judgment carries its author, its time, its confidence, and the hash of
  the hole it answered

#### Scenario: A note may accompany the decision
- **WHEN** an agent records a resolution with a reason
- **THEN** that reason is stored alongside it

### Requirement: An agent may decline a hole

The system SHALL let an agent record that a hole was considered and could not be resolved,
with a reason. A declined hole MUST be distinguishable from one never offered, and MUST NOT
resolve its edge.

#### Scenario: A decline is recorded
- **WHEN** an agent declines a hole with a reason
- **THEN** the decline and its reason are stored, and the edge remains unresolved

#### Scenario: A declined hole is not silently re-asked
- **WHEN** the holes of a flow are listed after a decline
- **THEN** the declined hole is marked as considered rather than presented as untouched

### Requirement: A judgment may be withdrawn

The system SHALL let a recorded judgment be removed, returning the hole to its unresolved
state.

#### Scenario: Withdrawing restores the hole
- **WHEN** a judgment is withdrawn
- **THEN** the hole is open again and its edge returns to its declared target

### Requirement: A judgment goes stale when its inputs change

A judgment SHALL be compared against the hash of the hole it answered. Where the hash no
longer matches, the judgment MUST be reported stale and MUST NOT resolve its edge until it is
answered again.

#### Scenario: A new implementor reopens the question
- **WHEN** a new implementation of the declared type appears, changing the candidate set
- **THEN** the existing judgment is reported stale and the edge is unresolved again

#### Scenario: An unrelated edit does not reopen it
- **WHEN** code elsewhere in the flow changes without altering the declared target or the
  candidate set
- **THEN** the judgment remains current and continues to resolve its edge

#### Scenario: A judgment stored without a hash is stale
- **WHEN** a flow file written before judgments carried hashes is read
- **THEN** its judgments are reported stale rather than trusted

### Requirement: Curation never runs unasked

The system MUST NOT record a judgment except in response to an explicit request. Analysis,
the staleness check, and any scheduled or automatic path MUST leave judgments untouched.

#### Scenario: Analysis writes no judgments
- **WHEN** a flow is analyzed
- **THEN** no judgment is created, changed or removed

#### Scenario: The staleness check writes no judgments
- **WHEN** the check runs against a flow with stale judgments
- **THEN** it reports them and changes nothing
