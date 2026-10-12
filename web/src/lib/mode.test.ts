import assert from "node:assert/strict";
import { test } from "node:test";

import { deploymentMode, isOperatorMode, isViewerMode, parseDeploymentMode } from "./mode.ts";

test("an absent, empty or explicit operator mode is the operator", () => {
  assert.equal(parseDeploymentMode(undefined), "operator");
  assert.equal(parseDeploymentMode(""), "operator");
  assert.equal(parseDeploymentMode("operator"), "operator");
  assert.equal(parseDeploymentMode("  operator  "), "operator");
});

test("viewer mode is opt-in by name", () => {
  assert.equal(parseDeploymentMode("viewer"), "viewer");
  assert.equal(parseDeploymentMode(" viewer "), "viewer");
});

test("an unrecognised mode throws rather than defaulting to the operator", () => {
  // The whole point of failing here: a typo must never quietly stand up the privileged half of
  // the console behind an internet-facing hostname.
  assert.throws(() => parseDeploymentMode("public"), /WERWOELFE_MODE/);
  assert.throws(() => parseDeploymentMode("view"), /WERWOELFE_MODE/);
  assert.throws(() => parseDeploymentMode("Viewer"), /WERWOELFE_MODE/);
});

test("deploymentMode reads WERWOELFE_MODE per call", () => {
  const previous = process.env.WERWOELFE_MODE;
  try {
    process.env.WERWOELFE_MODE = "viewer";
    assert.equal(deploymentMode(), "viewer");
    assert.equal(isViewerMode(), true);
    assert.equal(isOperatorMode(), false);

    process.env.WERWOELFE_MODE = "operator";
    assert.equal(deploymentMode(), "operator");
    assert.equal(isViewerMode(), false);
    assert.equal(isOperatorMode(), true);

    delete process.env.WERWOELFE_MODE;
    assert.equal(deploymentMode(), "operator");
    assert.equal(isOperatorMode(), true);
  } finally {
    if (previous === undefined) {
      delete process.env.WERWOELFE_MODE;
    } else {
      process.env.WERWOELFE_MODE = previous;
    }
  }
});
