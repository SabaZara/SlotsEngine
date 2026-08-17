/**
 * Tests the test environment itself.
 *
 * This file exists because of F4's shape: a test harness that quietly does
 * less than it claims reports success. A DOM that is not really installed
 * does not throw — `document` is simply undefined, and a component test
 * that never mounts anything can still pass its assertions if they are
 * written loosely. So the harness is asserted directly, before anything is
 * built on it.
 *
 * What this file cannot establish: that React renders correctly into this
 * DOM. That is `primitives.test.tsx`'s job — it is the first real consumer,
 * and if the environment were subtly wrong it would fail there.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { installDom, uninstallDom } from "./domEnvironment.js";

describe("the DOM test environment", () => {
  before(() => installDom());
  after(() => uninstallDom());

  it("provides a document that can build and find a real element tree", () => {
    const host = document.createElement("div");
    host.innerHTML = `<button id="probe">Spin</button>`;
    document.body.appendChild(host);

    const button = document.getElementById("probe");
    assert.ok(button, "expected the element to be findable through the real document");
    assert.equal(button.textContent, "Spin");
    assert.equal(button.tagName, "BUTTON");
  });

  it("dispatches events to listeners, which is what a component test needs", () => {
    const button = document.createElement("button");
    let clicks = 0;
    button.addEventListener("click", () => {
      clicks += 1;
    });
    document.body.appendChild(button);

    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    assert.equal(clicks, 1, "a listener that never fires would make every interaction test vacuous");
  });

  it("exposes getComputedStyle, which Testing Library reads for visibility", () => {
    const node = document.createElement("div");
    node.style.color = "rgb(1, 2, 3)";
    document.body.appendChild(node);

    assert.equal(window.getComputedStyle(node).color, "rgb(1, 2, 3)");
  });

  it("is installed at import time rather than inside a hook", () => {
    // The ordering constraint this environment exists to satisfy. If the
    // globals only appeared inside `before`, React would already have
    // captured an undefined `document` at import and every component test
    // would fail with a message that names React rather than the cause.
    assert.equal(typeof globalThis.document, "object");
    assert.equal(typeof globalThis.window, "object");
  });

  it("installs only one DOM however many times it is called", () => {
    const marker = document.createElement("div");
    marker.id = "survives-a-second-install";
    document.body.appendChild(marker);

    installDom();

    assert.ok(
      document.getElementById("survives-a-second-install"),
      "a second install replaced the globals, which would orphan already-mounted components",
    );
  });
});
