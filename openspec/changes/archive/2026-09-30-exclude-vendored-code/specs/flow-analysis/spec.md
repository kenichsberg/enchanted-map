## MODIFIED Requirements

### Requirement: Symbols outside the project are recorded but not expanded

Where a call resolves to a file that is not part of the project's own source, the analyzer
SHALL record the symbol so the call remains visible, MUST NOT traverse into it, and MUST
label it with a location that is independent of the machine and the toolchain the analysis
ran on.

A file is not part of the project's own source when its path escapes the project root, or
when any segment of its path within the root matches a configured vendor marker. A vendored
file inside the root MUST be treated exactly as one outside it; the two MUST NOT be
distinguishable in a flow.

#### Scenario: A call into the standard library
- **WHEN** a function in the project calls a standard library function
- **THEN** the call and its target are recorded, and the target's own calls are not followed

#### Scenario: External symbols are distinguishable
- **WHEN** a flow contains both project and external symbols
- **THEN** each external symbol is marked as such, and a consumer can list them separately
  from symbols truncated by the depth bound

#### Scenario: External locations are portable
- **WHEN** a flow containing external symbols is stored
- **THEN** the stored file contains no absolute or installation-specific path, so the same
  analysis on another checkout produces the same bytes

#### Scenario: A dependency installed inside the project directory
- **WHEN** a call resolves into a virtualenv beneath the project root
- **THEN** the call and its target are recorded, and the target's own calls are not followed

#### Scenario: A vendored path segment matches, not a prefix or substring
- **WHEN** the project contains a file whose name merely contains a marker as a substring,
  such as `my_venv_helpers.py`, and another file beneath a directory named exactly `.venv`
- **THEN** only the file beneath the marker directory is treated as vendored

#### Scenario: A vendored location loses its toolchain version
- **WHEN** a vendored file's path includes an interpreter-specific directory, as
  `.venv/lib/python3.13/site-packages/` does
- **THEN** its recorded location contains neither the interpreter version nor any segment
  above the vendor marker, so two developers on different patch releases store the same bytes

#### Scenario: Nested vendor markers resolve to the dependency's own path
- **WHEN** a vendored path contains more than one marker segment, such as `site-packages`
  beneath `.venv`
- **THEN** the location is taken from the last marker, yielding the dependency's own path

#### Scenario: Vendored symbols are not expanded even when reachable early
- **WHEN** an entry point calls a vendored function directly, within the depth bound
- **THEN** that function's own calls are absent from the flow, and it is reported as external
  rather than as truncated by depth
