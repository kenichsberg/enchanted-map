## 1. Marker matching

- [x] 1.1 Add the default marker set: `.venv`, `venv`, `env`, `site-packages`,
      `node_modules`, `__pycache__`, `.tox`, `.nox`, `vendor`
- [x] 1.2 Implement segment-equality matching over a repo-relative path, so a marker matches
      a directory name and never a prefix or a substring of a filename
- [x] 1.3 Implement the portable label: strip up to and including the LAST marker segment,
      so `.venv/lib/python3.13/site-packages/pandas/core/frame.py` becomes
      `<ext>/pandas/core/frame.py`
- [x] 1.4 Unit-test matching and labelling as pure functions, including `my_venv_helpers.py`
      (not vendored), nested markers, and a path with no marker

## 2. Wiring

- [x] 2.1 Make `isExternal` and `externalLabel` configuration-aware, updating the existing
      call sites and tests that use them statically
- [x] 2.2 Classify a symbol as external when its path escapes the root OR matches a marker,
      reusing the existing `external` flag and `external` list rather than adding a concept
- [x] 2.3 Pass the project's marker set from `FlowAnalyzer` through to the extractor
- [x] 2.4 Confirm no consumer distinguishes a vendored symbol from one outside the root

## 3. Configuration

- [x] 3.1 Extend `ProjectConfig` with a vendor setting carrying an explicit extend-or-replace
      intent, defaulting to the built-in markers when absent
- [x] 3.2 Preserve the setting and its intent across a config write and read
- [x] 3.3 Test the three cases: absent (defaults), extend (defaults plus stated), replace
      (stated only, and a default such as `node_modules` no longer excluded)

## 4. Behaviour tests

- [x] 4.1 Build a fixture with a vendored package beneath the project root that the entry
      point calls into
- [x] 4.2 Test that the vendored call is recorded and its own calls are not followed
- [x] 4.3 Test that a vendored symbol is reported as external, not as truncated by depth,
      even when reached within the depth bound
- [x] 4.4 Test that a stored flow containing vendored symbols carries no interpreter version
      and no path segment above the marker
- [x] 4.5 Test that a file merely containing a marker as a substring is still project code

## 5. Verification on a real repository

- [x] 5.1 Analyze `CVDLINK/data_exporter` from `main` and confirm the flow reaches the
      project's own modules and stops at the `.venv` boundary
- [x] 5.2 Compare node and edge counts against the same flow before this change, and record
      the reduction
- [x] 5.3 Analyze `CVDLINK/stratification` and record whether the default marker set was
      sufficient or needed extending
- [x] 5.4 Run the full suite and the Neovim checks, confirming the existing fixture's
      behaviour is unchanged
