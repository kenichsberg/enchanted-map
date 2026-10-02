# Flow Map

### Requirement: Entry points are declared

The system SHALL read entry points from project configuration. Each entry point MUST identify
a symbol and MUST carry a stable flow name. The system MUST NOT infer entry points from
framework conventions in this change.

#### Scenario: Declared entry point becomes a flow
- **WHEN** an entry point is declared in configuration
- **THEN** a flow of that name becomes available for analysis and storage

#### Scenario: Entry point no longer resolves
- **WHEN** a declared entry point's symbol no longer exists in the codebase
- **THEN** the flow is reported as broken, and its stored file is retained rather than deleted

### Requirement: A flow is a rooted, bounded call tree

A flow SHALL consist of one entry point and its reachable call tree, bounded by a configured
maximum depth. A flow MUST be the unit of viewing, storage, staleness reporting, and
acceptance.

#### Scenario: Flow is analyzed from its entry point
- **WHEN** a flow is analyzed
- **THEN** traversal begins at the declared entry point and follows outgoing calls only

#### Scenario: Traversal terminates on a cycle
- **WHEN** the call tree contains a recursive or mutually recursive path
- **THEN** traversal terminates, and the repeated node is marked as a cycle rather than expanded

### Requirement: One committed file per flow

Each flow SHALL persist to its own file under a committed project directory. Derived facts
MUST NOT be stored in these files.

#### Scenario: Two flows are stored separately
- **WHEN** two flows are analyzed and stored
- **THEN** each occupies its own file, and editing one leaves the other byte-identical

#### Scenario: Stored output is stably ordered
- **WHEN** an unchanged flow is stored twice
- **THEN** the two files are byte-identical

### Requirement: Node identity across revisions

The system SHALL preserve node identity across revisions for file moves detected by version
control rename detection, and for symbol renames where a removed symbol and an added symbol
in the same file share an identical body hash. All other cases MUST invalidate the affected
entries rather than attempt approximate matching.

#### Scenario: File is moved
- **WHEN** a file containing mapped symbols is moved and version control reports the rename
- **THEN** the nodes retain their identity and their stored entries survive

#### Scenario: Symbol is renamed without body change
- **WHEN** a symbol is renamed and its body hash is unchanged
- **THEN** the node retains its identity

#### Scenario: Symbol is renamed and edited together
- **WHEN** a symbol is both renamed and modified
- **THEN** the node is treated as new and the prior entry is invalidated

### Requirement: Dependency-scoped hashing

Every stored entry SHALL record a hash of the specific inputs it depended on, not a hash of
the whole file or whole flow.

#### Scenario: Unrelated edit does not invalidate
- **WHEN** a line is added to a function that a stored entry does not depend on
- **THEN** that entry's hash is unchanged and it is not marked stale

#### Scenario: Dependency change invalidates
- **WHEN** an input an entry depends on changes
- **THEN** that entry's hash no longer matches and it is marked stale

### Requirement: Staleness is detected and reported per entry

The system SHALL compute staleness per stored entry and MUST attribute each stale entry to
the specific node or edge it affects. A flow with some stale entries MUST remain readable.

#### Scenario: Partially stale flow
- **WHEN** some entries in a flow are stale and others are current
- **THEN** only the affected nodes and edges are marked, and the rest render normally

#### Scenario: Staleness is enumerable
- **WHEN** a flow is inspected for staleness
- **THEN** the stale entries can be listed with the node or edge each affects

### Requirement: Per-flow acceptance

A flow SHALL carry an acceptance stamp recording the revision at which a human accepted it.
Acceptance MUST apply to the whole flow. The system MUST NOT provide a separate per-entry
pinning mechanism.

#### Scenario: Flow is accepted
- **WHEN** a user accepts a flow
- **THEN** the flow records the current revision as its accepted revision

#### Scenario: Accepted flow drifts
- **WHEN** code changes after acceptance such that entries become stale
- **THEN** the acceptance stamp is retained and the flow is reported as accepted-but-drifted

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

### Requirement: Vendor directories are configurable

Project configuration SHALL allow the set of vendor markers to be stated, and MUST make
clear whether a stated set extends the defaults or replaces them. Where no set is stated, the
analyzer SHALL apply its defaults.

#### Scenario: No configuration uses the defaults
- **WHEN** a project states no vendor markers
- **THEN** the analyzer's default markers apply

#### Scenario: Extending the defaults
- **WHEN** a project states additional markers as an extension
- **THEN** both the defaults and the stated markers are treated as vendored

#### Scenario: Replacing the defaults
- **WHEN** a project states markers as a replacement
- **THEN** only the stated markers are treated as vendored, and a default such as
  `node_modules` is no longer excluded

#### Scenario: Configuration round-trips
- **WHEN** a configuration stating vendor markers is written and read back
- **THEN** the markers and the extend-or-replace intent are preserved
