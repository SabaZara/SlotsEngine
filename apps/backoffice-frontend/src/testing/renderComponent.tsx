/**
 * Mounting a React component in a test.
 *
 * Thin on purpose. Testing Library's `render` already does the work; what
 * this adds is the DOM install and the React 19 `act` wiring, both of which
 * are easy to get subtly wrong in a way that produces passing tests that
 * assert nothing.
 *
 * `IS_REACT_ACT_ENVIRONMENT` is the part worth knowing about. React only
 * flushes effects synchronously inside `act` when that global is set, and
 * when it is not set React warns rather than failing — so an effect-driven
 * assertion silently reads the state *before* the effect ran. That is the
 * component-test version of a test asserting nothing, which this repo has
 * already been bitten by more than once.
 */
// MUST be first: importing this installs the DOM, and both React and
// Testing Library capture `document` when their own module bodies run.
// ESM evaluates dependencies in import order, so this line is what makes
// the two below safe. Moving it changes nothing visible until a query
// fails with a message about `document.body` that names no cause.
import "./domEnvironment.js";
import { act } from "react";
import { render as tlRender, cleanup, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";

// Read by React itself, not by Testing Library. Set here rather than in a
// global .d.ts because this is the only place that needs it.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

export function renderComponent(element: ReactElement): RenderResult {
  return tlRender(element);
}

/**
 * Runs an interaction and flushes everything it caused.
 *
 * Every click in these tests goes through here rather than calling
 * `fireEvent` directly, because a state update outside `act` is applied
 * *after* the assertion that follows it — the test then reads the old DOM
 * and passes for the wrong reason.
 */
export async function interact(action: () => void): Promise<void> {
  await act(async () => {
    action();
  });
}

export { cleanup, screen, fireEvent, within } from "@testing-library/react";
// Re-exported so a test file never has to import the environment module
// directly — one import keeps the ordering constraint in one place.
export { uninstallDom } from "./domEnvironment.js";
