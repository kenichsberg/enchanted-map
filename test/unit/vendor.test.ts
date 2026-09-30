import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VENDOR_MARKERS,
  externalLabel,
  isExternal,
  isVendored,
  resolveMarkers,
} from "../../src/analysis/vendor.ts";

const M = DEFAULT_VENDOR_MARKERS;

test("a virtualenv inside the project is vendored", () => {
  assert.ok(isVendored(".venv/lib/python3.13/site-packages/pandas/core/frame.py", M));
  assert.ok(isVendored("node_modules/left-pad/index.js", M));
  assert.ok(isVendored("src/__pycache__/thing.cpython-313.pyc", M));
});

test("project source is not vendored", () => {
  assert.ok(!isVendored("src/data_exporter/__main__.py", M));
  assert.ok(!isVendored("run_states.py", M));
  assert.ok(!isVendored("stratification/core/model.py", M));
});

test("markers match a whole segment, never a prefix or substring", () => {
  // The bug a substring test would introduce.
  assert.ok(!isVendored("src/my_venv_helpers.py", M), "a filename containing a marker");
  assert.ok(!isVendored("src/venvtools/setup.py", M), "a directory merely starting with one");
  assert.ok(!isVendored("src/environment/config.py", M), "'env' must not match 'environment'");
  assert.ok(isVendored("src/env/config.py", M), "…but an exact segment does");
});

test("a file named like a marker is not a vendored directory", () => {
  assert.ok(!isVendored("tools/vendor", M), "the last segment is the file itself");
  assert.ok(isVendored("tools/vendor/lib.py", M), "as a directory it counts");
});

test("a nested marker resolves to the dependency's own path", () => {
  assert.equal(
    externalLabel(".venv/lib/python3.13/site-packages/pandas/core/frame.py", M),
    "<ext>/pandas/core/frame.py",
  );
});

test("the label carries no interpreter version and nothing above the marker", () => {
  const a = externalLabel(".venv/lib/python3.13/site-packages/numpy/core.py", M);
  const b = externalLabel(".venv/lib/python3.12/site-packages/numpy/core.py", M);
  assert.equal(a, b, "two patch releases must produce the same bytes");
  assert.ok(!a.includes("python3."), "no interpreter version");
  assert.ok(!a.includes(".venv"), "nothing above the marker");
});

test("a path outside the root still labels from its marker", () => {
  assert.equal(
    externalLabel("../../../node_modules/basedpyright/dist/typeshed/builtins.pyi", M),
    "<ext>/basedpyright/dist/typeshed/builtins.pyi",
  );
});

test("a path with no marker falls back to its basename", () => {
  assert.equal(externalLabel("../../elsewhere/foo.py", M), "<ext>/foo.py");
});

test("external means outside the root or vendored inside it", () => {
  assert.ok(isExternal("../outside.py", M), "escapes the root");
  assert.ok(isExternal(".venv/lib/site-packages/x.py", M), "vendored inside it");
  assert.ok(!isExternal("src/app.py", M), "project source");
});

test("markers default, extend, or replace", () => {
  assert.deepEqual(resolveMarkers(), [...DEFAULT_VENDOR_MARKERS]);
  assert.deepEqual(resolveMarkers(null), [...DEFAULT_VENDOR_MARKERS]);

  const extended = resolveMarkers({ extend: ["thirdparty"] });
  assert.ok(extended.includes("node_modules"), "defaults are kept");
  assert.ok(extended.includes("thirdparty"), "and the stated marker added");

  const replaced = resolveMarkers({ replace: [".venv"] });
  assert.deepEqual(replaced, [".venv"]);
  assert.ok(!replaced.includes("node_modules"), "a default is no longer excluded");

  // replace sets the base; extend adds to it.
  assert.deepEqual(resolveMarkers({ replace: [".venv"], extend: ["thirdparty"] }), [
    ".venv",
    "thirdparty",
  ]);
});

test("replacing the defaults really stops excluding them", () => {
  const only = resolveMarkers({ replace: [".venv"] });
  assert.ok(!isVendored("node_modules/x/index.js", only), "node_modules is now project code");
  assert.ok(isVendored(".venv/lib/x.py", only));
});
