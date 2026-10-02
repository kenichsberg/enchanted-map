## RENAMED Requirements

- FROM: `### Requirement: Judgment slots exist and remain empty`
- TO: `### Requirement: Judgment slots carry a decision and its provenance`

The slots no longer remain empty; that was the point of reserving them.

## MODIFIED Requirements

### Requirement: Judgment slots carry a decision and its provenance

The stored flow format SHALL hold probabilistic judgments alongside the derived facts. A
judgment MUST record what was decided, who decided it, when, how confident the decision was,
and the hash of the inputs it rested on. Human-authored values are permitted.

A judgment MUST NOT be created, changed or removed except in response to an explicit request:
analysis, staleness checking and every automatic path MUST leave them untouched.

A flow file written before judgments carried provenance MUST still parse, its bare value read
as a decision of unknown provenance.

#### Scenario: Format accepts a judgment slot
- **WHEN** a flow file containing a judgment slot is read
- **THEN** it parses successfully and the slot's provenance is preserved

#### Scenario: No inferred values are written
- **WHEN** a flow is analyzed and stored by this system
- **THEN** no judgment slot is populated by inference

#### Scenario: A judgment carries its provenance
- **WHEN** a judgment is stored
- **THEN** it carries its author, its time, its confidence, and the hash of the inputs it
  answered

#### Scenario: Curation survives re-analysis
- **WHEN** a flow carrying judgments is re-analyzed
- **THEN** the judgments are retained, because they are the part that cannot be regenerated

#### Scenario: An older flow file still reads
- **WHEN** a flow file stores a judgment as a bare value, without provenance
- **THEN** it parses, and the value is read as a decision whose provenance is unknown

#### Scenario: Acceptance covers the judgments in a flow
- **WHEN** a flow carrying judgments is accepted
- **THEN** the acceptance stamp covers them, with no separate per-judgment acceptance
