## ADDED Requirements

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
