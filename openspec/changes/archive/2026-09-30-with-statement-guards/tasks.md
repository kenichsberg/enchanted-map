## 1. Categorisation

- [x] 1.1 Add the guard category to `Condition`: `branch`, `loop`, `context`
- [x] 1.2 Assign a category in `guardFor` for every construct it recognises — `if`, `elif`,
      `else`, `match` case, `except` and conditional expression as `branch`; `for` and
      `while` as `loop`; `with` and `finally` as `context`
- [x] 1.3 Keep collecting every guard regardless of category, so nothing is discarded at
      extraction time
- [x] 1.4 Unit-test the category assigned for each construct, against the fixture

## 2. Presentation

- [x] 2.1 Build the condition label from `branch` and `loop` guards only
- [x] 2.2 Assert the existing fixture's labels are byte-identical — `[mfa]`, `[!mfa]`,
      `[for user in users && urgent]` must be unchanged
- [x] 2.3 Test that a call guarded only by `with` has an empty label
- [x] 2.4 Test that an `if` inside a `with` labels with the `if` alone
- [x] 2.5 Confirm the editor listing and the canvas both follow, since both read the label
      from the view

## 3. Hashing

- [x] 3.1 Include the category in the serialised condition that feeds the edge hash
- [x] 3.2 Test that two guards differing only by category hash differently
- [x] 3.3 Confirm the one-off staleness is the expected shape: a flow with `with`-guarded
      edges reports those edges stale, and no others

## 4. Fixture

- [x] 4.1 Add a fixture function using `with` as a structuring idiom, as the real code does
- [x] 4.2 Add a fixture case with an `if` nested inside a `with`
- [x] 4.3 Add a fixture case using `try`/`except` so the `branch` categorisation of `except`
      is exercised rather than assumed

## 5. Verification

- [x] 5.1 Analyze `CVDLINK/stratification` from `StratificationOrchestrator.run` and confirm
      the eleven pipeline steps read without `_logged_step` guard text
- [x] 5.2 Record the before/after label for one representative edge
- [x] 5.3 Run the full suite and the Neovim checks, confirming no existing label changed
