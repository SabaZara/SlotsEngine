/**
 * The screen that issues operator credentials.
 *
 * **Why this screen gets tests when four others do not.** It is the only
 * place in the system where a secret is displayed, and the display is
 * one-shot: the stored copy is encrypted and no route returns it, so a UI
 * bug that drops the panel before it is read costs a rotation and breaks a
 * live integration. That is not a class of failure the API tests can see —
 * they establish that the server returns the secret exactly once, which is
 * precisely what makes the client's handling of it unrecoverable.
 *
 * It is also F24's shape waiting to happen. Operator CRUD is complete and
 * mutation-verified on the server; the question these tests answer is
 * whether a person can actually reach it.
 *
 * Deliberately not asserted: colours, spacing, exact wording. A test
 * restating a sentence makes copy edits fail the suite, which teaches
 * people to ignore failures. What is pinned is behaviour someone depends
 * on — that the secret appears, that it cannot be dismissed by accident,
 * that a rotation asks first, and that a read-only role is offered no
 * control the server would refuse.
 *
 * What these cannot establish: that the API client's URLs are right, or
 * that a credential issued here authenticates. Both cross a process
 * boundary — `npm run e2e:operator` creates an operator through this API
 * and then signs a real request with the returned secret.
 */
import { after, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, interact, renderComponent, screen, uninstallDom } from "../testing/renderComponent.js";
import { OperatorsScreen, type OperatorsApi } from "./OperatorsScreen.js";
import type { ManagedOperator } from "../api.js";

afterEach(() => cleanup());
after(() => uninstallDom());

const OPERATOR: ManagedOperator = {
  operatorId: "acme-casino",
  name: "Acme Casino",
  integrationType: "direct",
  apiKeyId: "key-abc",
  enabledGameIds: [],
  createdAt: "2026-08-17T00:00:00.000Z",
};

const GAME = {
  gameId: "reference-5x3",
  name: "Reference 5x3",
  publishedVersion: 1,
  hasDraft: false,
  draftUpdatedAt: null,
};

/** A stub recording what the screen asked for. Built per test so calls
 * never leak between them. */
function stubApi(overrides: Partial<OperatorsApi> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    <T,>(method: string, result: T) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };

  const client = {
    listOperators: record("listOperators", { operators: [OPERATOR] }),
    listGames: record("listGames", { games: [GAME] }),
    createOperator: record("createOperator", {
      operator: { ...OPERATOR, operatorId: "new-op", apiKeyId: "key-new", apiSecret: "s".repeat(64) },
    }),
    updateOperator: record("updateOperator", { operator: OPERATOR }),
    rotateOperatorSecret: record("rotateOperatorSecret", {
      operator: { ...OPERATOR, apiKeyId: "key-rotated", apiSecret: "r".repeat(64) },
    }),
    ...overrides,
  } as unknown as OperatorsApi;

  return { client, calls };
}

/** Mounts and lets the initial load settle — every assertion here depends
 * on the effect having run. */
async function mount(props: Parameters<typeof OperatorsScreen>[0]) {
  const result = renderComponent(<OperatorsScreen {...props} />);
  await interact(() => {});
  return result;
}

describe("issuing a credential", () => {
  it("shows the secret after creating an operator", async () => {
    const { client } = stubApi();
    await mount({ canManage: true, client, confirm: () => true });

    await interact(() => {
      fireEvent.change(screen.getByRole("textbox", { name: "Operator ID" }), { target: { value: "new-op" } });
    });
    await interact(() => {
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "New Operator" } });
    });
    await interact(() => {
      fireEvent.click(screen.getByRole("button", { name: /create operator/i }));
    });

    // The one moment this value is ever visible.
    assert.equal(screen.getByTestId("api-secret").textContent, "s".repeat(64));
  });

  it("keeps the secret on screen after the list refreshes behind it", async () => {
    // The failure this exists to prevent: `create` calls `refresh()`
    // immediately afterwards, and a panel rendered from list state rather
    // than its own would be wiped by that refresh — losing a secret that
    // cannot be re-read, in the ordinary success path.
    const { client, calls } = stubApi();
    await mount({ canManage: true, client, confirm: () => true });

    await interact(() => {
      fireEvent.change(screen.getByRole("textbox", { name: "Operator ID" }), { target: { value: "new-op" } });
    });
    await interact(() => {
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "New Operator" } });
    });
    await interact(() => {
      fireEvent.click(screen.getByRole("button", { name: /create operator/i }));
    });

    assert.ok(
      calls.filter((c) => c.method === "listOperators").length >= 2,
      "the premise: a refresh really did run after the create",
    );
    assert.ok(screen.getByTestId("api-secret"), "and the secret survived it");
  });

  it("refuses to dismiss the secret until it is acknowledged", async () => {
    // Dismissing is irreversible. The checkbox is the difference between a
    // deliberate act and a mis-click that costs a rotation.
    const { client } = stubApi();
    await mount({ canManage: true, client, confirm: () => true });

    await interact(() => {
      fireEvent.change(screen.getByRole("textbox", { name: "Operator ID" }), { target: { value: "new-op" } });
    });
    await interact(() => {
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "New Operator" } });
    });
    await interact(() => {
      fireEvent.click(screen.getByRole("button", { name: /create operator/i }));
    });

    const done = screen.getByRole("button", { name: /done/i });
    await interact(() => fireEvent.click(done));
    assert.ok(screen.queryByTestId("api-secret"), "clicking Done while unacknowledged must not dismiss it");

    await interact(() => {
      fireEvent.click(screen.getByRole("checkbox", { name: /stored this secret/i }));
    });
    await interact(() => fireEvent.click(screen.getByRole("button", { name: /done/i })));
    assert.equal(screen.queryByTestId("api-secret"), null, "and must dismiss it once acknowledged");
  });

  it("will not submit without both an ID and a name", async () => {
    // The server refuses these too. Checking here means a person is told
    // before a round trip, not after a 400.
    const { client, calls } = stubApi();
    await mount({ canManage: true, client, confirm: () => true });

    await interact(() => {
      fireEvent.click(screen.getByRole("button", { name: /create operator/i }));
    });
    assert.equal(calls.filter((c) => c.method === "createOperator").length, 0);

    await interact(() => {
      fireEvent.change(screen.getByRole("textbox", { name: "Operator ID" }), { target: { value: "only-an-id" } });
    });
    await interact(() => {
      fireEvent.click(screen.getByRole("button", { name: /create operator/i }));
    });
    assert.equal(calls.filter((c) => c.method === "createOperator").length, 0, "an ID alone is not enough");
  });

  it("creates an operator entitled to nothing", async () => {
    // The safe direction, and it must be what the UI actually sends: an
    // operator entitled to everything by default is one nobody remembers
    // to restrict.
    const { client, calls } = stubApi();
    await mount({ canManage: true, client, confirm: () => true });

    await interact(() => {
      fireEvent.change(screen.getByRole("textbox", { name: "Operator ID" }), { target: { value: "new-op" } });
    });
    await interact(() => {
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "New Operator" } });
    });
    await interact(() => {
      fireEvent.click(screen.getByRole("button", { name: /create operator/i }));
    });

    const created = calls.find((c) => c.method === "createOperator");
    assert.deepEqual((created!.args[0] as { enabledGameIds: string[] }).enabledGameIds, []);
  });
});

describe("rotating a secret", () => {
  it("asks before rotating, because it breaks a live integration", async () => {
    const { client, calls } = stubApi();
    await mount({ canManage: true, client, confirm: () => false });

    await interact(() => {
      fireEvent.click(screen.getByRole("button", { name: /rotate secret/i }));
    });

    assert.equal(calls.filter((c) => c.method === "rotateOperatorSecret").length, 0, "a declined confirm must not rotate");
  });

  it("shows the new secret once the rotation is confirmed", async () => {
    const { client } = stubApi();
    await mount({ canManage: true, client, confirm: () => true });

    await interact(() => {
      fireEvent.click(screen.getByRole("button", { name: /rotate secret/i }));
    });

    assert.equal(screen.getByTestId("api-secret").textContent, "r".repeat(64));
  });
});

describe("entitlement", () => {
  it("grants a game the operator did not have", async () => {
    const { client, calls } = stubApi();
    await mount({ canManage: true, client, confirm: () => true });

    await interact(() => {
      fireEvent.click(screen.getByRole("button", { name: "Reference 5x3" }));
    });

    const update = calls.find((c) => c.method === "updateOperator");
    assert.ok(update, "granting a game must reach the server");
    assert.deepEqual((update.args[1] as { enabledGameIds: string[] }).enabledGameIds, ["reference-5x3"]);
  });

  it("revokes a game the operator already had", async () => {
    const entitled = { ...OPERATOR, enabledGameIds: ["reference-5x3"] };
    const { client, calls } = stubApi({
      listOperators: (() => Promise.resolve({ operators: [entitled] })) as OperatorsApi["listOperators"],
    });
    await mount({ canManage: true, client, confirm: () => true });

    const toggle = screen.getByRole("button", { name: "Reference 5x3" });
    assert.equal(toggle.getAttribute("aria-pressed"), "true", "an entitled game reads as pressed");

    await interact(() => fireEvent.click(toggle));

    const update = calls.find((c) => c.method === "updateOperator");
    assert.deepEqual((update!.args[1] as { enabledGameIds: string[] }).enabledGameIds, []);
  });
});

describe("what a read-only role sees", () => {
  it("offers no control the server would refuse", async () => {
    // A nav item or a button leading to a 403 is worse than none: it reads
    // as the app being broken rather than as permission being withheld.
    // The App-level guard already hides the whole screen from roles without
    // read access; this pins the within-screen half.
    const { client } = stubApi();
    await mount({ canManage: false, client, confirm: () => true });

    assert.equal(screen.queryByRole("button", { name: /create operator/i }), null);
    assert.equal(screen.queryByRole("button", { name: /rotate secret/i }), null);
    assert.equal(screen.queryByRole("button", { name: /disable/i }), null);
    // Still readable — that is the point of the wider view permission.
    assert.ok(screen.getByText("Acme Casino"));
  });

  it("cannot toggle entitlement", async () => {
    const { client, calls } = stubApi();
    await mount({ canManage: false, client, confirm: () => true });

    await interact(() => {
      fireEvent.click(screen.getByRole("button", { name: "Reference 5x3" }));
    });

    assert.equal(calls.filter((c) => c.method === "updateOperator").length, 0);
  });
});

describe("disabling", () => {
  it("disables an active operator and re-enables a disabled one", async () => {
    const { client, calls } = stubApi();
    await mount({ canManage: true, client, confirm: () => true });

    await interact(() => fireEvent.click(screen.getByRole("button", { name: /^disable$/i })));
    assert.deepEqual((calls.find((c) => c.method === "updateOperator")!.args[1] as { disabled: boolean }).disabled, true);

    cleanup();

    const disabled = { ...OPERATOR, disabledAt: "2026-08-17T12:00:00.000Z" };
    const second = stubApi({
      listOperators: (() => Promise.resolve({ operators: [disabled] })) as OperatorsApi["listOperators"],
    });
    await mount({ canManage: true, client: second.client, confirm: () => true });

    await interact(() => fireEvent.click(screen.getByRole("button", { name: /re-enable/i })));
    assert.equal(
      (second.calls.find((c) => c.method === "updateOperator")!.args[1] as { disabled: boolean }).disabled,
      false,
    );
  });
});
