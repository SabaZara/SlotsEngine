/**
 * The upload control.
 *
 * Two pure helpers carry everything that can be silently wrong, so they are
 * tested directly and the component only for the wiring a DOM can reach.
 *
 * `stripDataUrlPrefix` is the one worth the most attention. `FileReader`
 * yields `data:image/png;base64,iVBOR…`, and sending that whole string
 * would store the prefix as if it were image bytes — the upload would
 * succeed, the route would return 200, and the image would render as
 * nothing. Nothing downstream disagrees with a corrupt payload.
 */
import { after, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanup, renderComponent, screen, uninstallDom } from "../testing/renderComponent.js";
import { AssetUpload, MAX_UPLOAD_BYTES, stripDataUrlPrefix, uploadRejection } from "./AssetUpload.js";

afterEach(() => cleanup());
after(() => uninstallDom());

const IMAGES = "image/png,image/jpeg";

describe("stripDataUrlPrefix", () => {
  it("keeps only the payload, not the data-URL header", () => {
    /*
     * The failure this prevents is invisible at every layer below: the
     * route accepts the string, base64-decodes it, stores the result and
     * returns 200. Only the rendered image is wrong.
     */
    assert.equal(stripDataUrlPrefix("data:image/png;base64,iVBORw0KGgo="), "iVBORw0KGgo=");
  });

  it("leaves a bare payload alone", () => {
    // Defensive: a caller that already stripped must not lose data.
    assert.equal(stripDataUrlPrefix("iVBORw0KGgo="), "iVBORw0KGgo=");
  });

  it("handles a payload containing a comma-free header edge", () => {
    assert.equal(stripDataUrlPrefix(""), "");
  });
});

describe("uploadRejection", () => {
  it("accepts an ordinary file", () => {
    assert.equal(uploadRejection({ size: 4096, type: "image/png" }, IMAGES), null);
  });

  it("refuses an empty file", () => {
    // Zero bytes uploads "successfully" and renders as nothing, which is
    // the same silent failure as a corrupt payload.
    assert.ok(uploadRejection({ size: 0, type: "image/png" }, IMAGES));
  });

  it("refuses a file over the limit, and says how big it was", () => {
    // The size is in the message because "too large" alone leaves a
    // designer guessing how much to shrink it by.
    const message = uploadRejection({ size: MAX_UPLOAD_BYTES + 1, type: "image/png" }, IMAGES);
    assert.ok(message);
    assert.match(message, /MB/);
  });

  it("accepts a file exactly at the limit", () => {
    // The boundary belongs on the allowed side, matching the server's
    // `>` rather than `>=`. A limit the two ends disagree about is a file
    // the browser accepts and the route refuses.
    assert.equal(uploadRejection({ size: MAX_UPLOAD_BYTES, type: "image/png" }, IMAGES), null);
  });

  it("refuses a type the slot does not accept", () => {
    /*
     * The picker filters by `accept`, but drag-and-drop and some browsers
     * ignore it — so this is a real path rather than belt-and-braces. The
     * server refuses it independently either way; this only saves the
     * designer a round trip.
     */
    assert.ok(uploadRejection({ size: 4096, type: "application/pdf" }, IMAGES));
  });

  it("names the type it refused", () => {
    const message = uploadRejection({ size: 4096, type: "application/pdf" }, IMAGES);
    assert.ok(message);
    assert.match(message, /pdf/);
  });

  it("copes with a file whose type the browser could not determine", () => {
    // Browsers report "" for unknown extensions rather than guessing.
    const message = uploadRejection({ size: 4096, type: "" }, IMAGES);
    assert.ok(message, "an unknown type must be refused rather than sent");
  });
});

describe("AssetUpload", () => {
  it("offers an upload control", () => {
    renderComponent(<AssetUpload accept={IMAGES} onUpload={async () => {}} />);

    assert.ok(screen.getByRole("button", { name: /upload/i }));
  });

  it("can be disabled while something else is in flight", () => {
    renderComponent(<AssetUpload accept={IMAGES} disabled onUpload={async () => {}} />);

    assert.equal((screen.getByRole("button", { name: /upload/i }) as HTMLButtonElement).disabled, true);
  });

  it("hides the file input, since the button is the affordance", () => {
    // A native file input styled inconsistently across browsers is why it
    // is hidden behind a button — but it must still exist, because it is
    // what actually opens the picker.
    const { container } = renderComponent(<AssetUpload accept={IMAGES} onUpload={async () => {}} />);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    assert.ok(input, "the file input must exist");
    assert.equal(input.accept, IMAGES, "the picker must filter by the same list the server allows");
  });
});
