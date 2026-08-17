import { useRef, useState } from "react";
import { Button } from "../ui/primitives.js";
import { t } from "../ui/tokens.js";

/**
 * Picking a file and handing it to the upload route.
 *
 * **The upload is a separate route from the draft save, and that separation
 * is load-bearing rather than tidy.** Assets are stored as storage *keys*
 * and displayed as short-lived *signed URLs*, so what this screen shows is
 * not what the server holds. If a save echoed the displayed value back, it
 * would overwrite the key with a URL — which is exactly the bug the
 * reference repo shipped, compounding one nesting level per save until a
 * repair script was needed. The draft PUT therefore refuses `assets`
 * outright, and this control talks to `POST /assets` instead.
 */

/** 8MB, matching the server. Checked here too so a designer learns about it
 * before waiting for an upload rather than after. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Turns a `File` into the base64 the route expects.
 *
 * Exported and separated from the component because it is the one part
 * that can be silently wrong: `FileReader` yields a data URL
 * (`data:image/png;base64,iVBOR…`), and sending that whole string as the
 * payload would store the prefix as if it were image bytes. The file would
 * upload successfully and render as nothing.
 */
export function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

/**
 * Why a file cannot be uploaded, or `null` if it can.
 *
 * Checked client-side as a courtesy, never as the guarantee — the server
 * refuses the same cases independently, because a check in a browser is a
 * suggestion.
 */
export function uploadRejection(file: { size: number; type: string }, accept: string): string | null {
  if (file.size === 0) return "that file is empty";
  if (file.size > MAX_UPLOAD_BYTES) {
    return `that file is ${(file.size / 1024 / 1024).toFixed(1)}MB — the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`;
  }
  // `accept` is the same list handed to the file picker. A picker filters
  // by it, but a determined drag-and-drop or a browser that ignores it can
  // still deliver something else.
  const allowed = accept.split(",").map((a) => a.trim());
  if (allowed.length > 0 && !allowed.includes(file.type)) {
    return `${file.type || "that file type"} is not accepted here`;
  }
  return null;
}

export function AssetUpload({
  accept,
  disabled,
  onUpload,
}: {
  /** Comma-separated MIME types, shared with the server's allowlist. */
  accept: string;
  disabled?: boolean;
  onUpload: (upload: { contentType: string; data: string }) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function handleFile(file: File): Promise<void> {
    const rejection = uploadRejection(file, accept);
    if (rejection) {
      setProblem(rejection);
      return;
    }

    setProblem(null);
    setBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      await onUpload({ contentType: file.type, data: stripDataUrlPrefix(dataUrl) });
    } catch (err) {
      // The server's own message is shown when there is one — it knows
      // things this screen does not, like storage being unconfigured.
      setProblem(err instanceof Error ? err.message : "the upload failed");
    } finally {
      setBusy(false);
      // Cleared so selecting the SAME file again still fires a change
      // event. Without this, a designer who fixes a file and re-picks it
      // gets nothing and no explanation.
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
        }}
      />
      <Button disabled={disabled || busy} onClick={() => inputRef.current?.click()}>
        {busy ? "Uploading…" : "Upload"}
      </Button>
      {problem && <span style={{ fontSize: 11, color: t.warn }}>{problem}</span>}
    </div>
  );
}
