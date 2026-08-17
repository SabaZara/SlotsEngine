/**
 * Putting objects somewhere and handing out short-lived URLs to read them.
 *
 * S3-compatible, which locally means MinIO and in production means whatever
 * an operator points it at — the same `@aws-sdk/client-s3` code path works
 * against real S3 by changing the endpoint and dropping `forcePathStyle`.
 *
 * **The bucket is private and stays private.** Every read goes through a
 * signed URL minted at serve time, so an asset URL that leaks stops working
 * within the day rather than forever. The reference repo's own source
 * records why the policy is cleared on *every* boot rather than only at
 * creation: theirs set public-read at creation, and an environment whose
 * bucket already existed kept that policy indefinitely, because "create if
 * missing" never runs again.
 */

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteBucketPolicyCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const BUCKET = process.env.ASSET_BUCKET ?? "game-assets";

/**
 * How long a signed URL lasts.
 *
 * Long enough that a page open all day keeps working, short enough that a
 * URL copied out of devtools is not a permanent handle on the asset. It
 * only has to outlive a session, never the asset — the URL is generated
 * fresh on every read and never stored.
 */
const SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;

/**
 * Two clients, and the reason is easy to get wrong.
 *
 * A signature is computed against the host the request will be made to, so
 * a URL signed against the in-network endpoint (`http://minio:9000`) fails
 * validation when a *browser* requests it from `http://localhost:9010`. The
 * service talks to the first; the URLs it hands out must be signed against
 * the second.
 */
function makeClient(endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: process.env.ASSET_REGION ?? "us-east-1",
    credentials: {
      accessKeyId: process.env.ASSET_ACCESS_KEY ?? "",
      secretAccessKey: process.env.ASSET_SECRET_KEY ?? "",
    },
    // MinIO serves path-style only. Real S3 accepts it too, so this is
    // safe to leave on until someone needs virtual-host style.
    forcePathStyle: true,
  });
}

let internal: S3Client | null = null;
let publicSigner: S3Client | null = null;

/** Lazily constructed so importing this module does not require the
 * environment to be configured — a service that never uploads should not
 * fail to boot over a missing asset key. */
function clients(): { internal: S3Client; publicSigner: S3Client } {
  const endpoint = process.env.ASSET_ENDPOINT ?? "http://localhost:9010";
  const publicEndpoint = process.env.ASSET_PUBLIC_ENDPOINT ?? endpoint;
  internal ??= makeClient(endpoint);
  publicSigner ??= makeClient(publicEndpoint);
  return { internal, publicSigner };
}

/** Whether storage is configured at all. Callers use this to offer an
 * upload button only when there is somewhere to upload to, rather than
 * showing one that always fails. */
export function isStorageConfigured(): boolean {
  return Boolean(process.env.ASSET_ACCESS_KEY && process.env.ASSET_SECRET_KEY);
}

/**
 * Creates the bucket if absent, and removes any bucket policy every time.
 *
 * The second half runs unconditionally rather than only at creation. A
 * bucket that already existed from an earlier deployment would otherwise
 * keep whatever policy it had — including a public-read one — forever,
 * because the creation branch never runs again. That is the reference's
 * own recorded mistake, inherited as a fix rather than rediscovered.
 */
export async function ensureBucket(): Promise<void> {
  const { internal: client } = clients();
  try {
    await client.send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  }
  try {
    await client.send(new DeleteBucketPolicyCommand({ Bucket: BUCKET }));
  } catch {
    // Nothing to delete — already private, or never had a policy.
  }
}

/**
 * Stores an object and returns its **key**, never a URL.
 *
 * The return type is the whole discipline. A function that returned a URL
 * would invite a caller to persist it, which is precisely the corruption
 * the reference shipped — see `keys.ts` for the full account.
 */
export async function uploadAsset(key: string, body: Buffer, contentType: string): Promise<string> {
  const { internal: client } = clients();
  await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
  return key;
}

/** A fresh signed URL for `key`. Called at serve time, never persisted. */
export async function signAssetUrl(key: string, expiresInSeconds = SIGNED_URL_TTL_SECONDS): Promise<string> {
  const { publicSigner: signer } = clients();
  return getSignedUrl(signer, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: expiresInSeconds });
}

/** Whether an object exists. Used before proposing a repair, so a wrong
 * guess is reported rather than applied. */
export async function keyExists(key: string): Promise<boolean> {
  const { internal: client } = clients();
  try {
    await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes an object.
 *
 * Deliberately **not** called when a designer clears an asset field. A
 * published game may still reference the key, and a draft edit must never
 * break a live game — the document is what says whether an asset is in
 * use, and this function has no way to know. Orphaned objects are a
 * storage-cost problem for a later sweep, not a correctness one.
 */
export async function deleteAsset(key: string): Promise<void> {
  const { internal: client } = clients();
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}
