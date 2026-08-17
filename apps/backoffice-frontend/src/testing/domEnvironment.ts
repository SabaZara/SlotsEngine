/**
 * A DOM for component tests, installed as an import side effect.
 *
 * This closes the stopping point `docs/TODO.md` section C recorded: the
 * React components had no tests because this repo had no DOM environment
 * and no component testing library. That was an honest limit rather than an
 * oversight, and it is worth saying what changed — the limit was acceptable
 * while the frontend was a reference client whose only untested part was
 * presentation. It stops being acceptable the moment the UI is the surface
 * a designer configures money through, which is exactly what F24 was.
 *
 * **The install has to happen at module-evaluation time, not in a hook.**
 * React and `@testing-library/dom` both read `document` when they are first
 * imported, and ESM hoists every `import` above every statement in a file —
 * so a test file that calls `installDom()` as its first statement has
 * already imported Testing Library by then, and Testing Library has already
 * captured an undefined `document`. Measured, not reasoned: that ordering
 * produced "For queries bound to document.body a global document has to be
 * available", which names the symptom and not the cause.
 *
 * The fix is that importing THIS module installs the DOM, and
 * `renderComponent.tsx` imports it before it imports Testing Library. Node
 * evaluates a module's dependencies depth-first in import order, so the DOM
 * exists before Testing Library's module body runs.
 */
import globalJsdom from "global-jsdom";

let teardown: (() => void) | null = null;

/**
 * Idempotent on purpose: two test files in one process must not stack two
 * JSDOM instances, because the second would replace the globals that the
 * first's already-mounted components still hold. Node's runner isolates
 * files into separate processes today, so this guards a change to that
 * rather than a case that happens now.
 */
function install(): void {
  if (teardown) return;
  teardown = globalJsdom(undefined, {
    // Testing Library reads `getComputedStyle` for its visibility checks,
    // which jsdom only implements usefully when it is parsing CSS at all.
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
}

// The side effect the ordering above depends on. Deliberately at module
// scope rather than exported-and-called.
install();

/** Exported so a test can assert the environment is present, and so the
 * idempotence above is reachable by a test rather than only by argument. */
export function installDom(): void {
  install();
}

export function uninstallDom(): void {
  teardown?.();
  teardown = null;
}
