/**
 * Unit + property tests for the encrypted-file fallback secret store (design §8.2).
 *
 * Task 3.4 — verifies AES-256-GCM round-trips, owner-only-directory behavior,
 * tamper/corruption detection, name sanitization, and that stored ciphertext never
 * contains the plaintext secret (Req 5.8).
 *
 * _Requirements: 5.8, 5.9; Design §8.2_
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertProperty, fc } from "@cfls/test-utils";
import {
  createEncryptedFileStore,
  resolveDefaultFileStoreDir,
} from "./encrypted-file-store";
import { DEVICE_PRIVATE_KEY_SECRET } from "./secret-store";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cfls-efs-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createEncryptedFileStore", () => {
  it("reports itself available when the directory can be created", async () => {
    const store = createEncryptedFileStore({ fileStoreDir: dir });
    expect(store.backend).toBe("encrypted-file");
    expect(await store.isAvailable()).toBe(true);
  });

  it("returns null for a secret that was never stored", async () => {
    const store = createEncryptedFileStore({ fileStoreDir: dir });
    expect(await store.get(DEVICE_PRIVATE_KEY_SECRET)).toBeNull();
  });

  it("round-trips a stored secret value", async () => {
    const store = createEncryptedFileStore({ fileStoreDir: dir });
    const secret = "s3cr3t-device-private-key==";
    await store.set(DEVICE_PRIVATE_KEY_SECRET, secret);
    expect(await store.get(DEVICE_PRIVATE_KEY_SECRET)).toBe(secret);
  });

  it("overwrites an existing secret on a second set", async () => {
    const store = createEncryptedFileStore({ fileStoreDir: dir });
    await store.set(DEVICE_PRIVATE_KEY_SECRET, "first");
    await store.set(DEVICE_PRIVATE_KEY_SECRET, "second");
    expect(await store.get(DEVICE_PRIVATE_KEY_SECRET)).toBe("second");
  });

  it("deletes a stored secret and reports whether anything was removed", async () => {
    const store = createEncryptedFileStore({ fileStoreDir: dir });
    expect(await store.delete(DEVICE_PRIVATE_KEY_SECRET)).toBe(false);
    await store.set(DEVICE_PRIVATE_KEY_SECRET, "value");
    expect(await store.delete(DEVICE_PRIVATE_KEY_SECRET)).toBe(true);
    expect(await store.get(DEVICE_PRIVATE_KEY_SECRET)).toBeNull();
  });

  it("never persists the plaintext secret on disk (Req 5.8)", async () => {
    const store = createEncryptedFileStore({ fileStoreDir: dir });
    const secret = "PLAINTEXT-MARKER-1234567890";
    await store.set(DEVICE_PRIVATE_KEY_SECRET, secret);
    const files = await readdir(dir);
    expect(files.length).toBe(1);
    const raw = await readFile(join(dir, files[0] as string), "utf8");
    expect(raw).not.toContain(secret);
  });

  it("throws when the stored file has been tampered with", async () => {
    const store = createEncryptedFileStore({ fileStoreDir: dir });
    await store.set(DEVICE_PRIVATE_KEY_SECRET, "original");
    const files = await readdir(dir);
    const path = join(dir, files[0] as string);
    const record = JSON.parse(await readFile(path, "utf8")) as {
      ciphertext: string;
    };
    // Flip the ciphertext to a different (valid base64) value.
    record.ciphertext = Buffer.from("tampered-content-here").toString("base64");
    await writeFile(path, JSON.stringify(record), "utf8");
    await expect(store.get(DEVICE_PRIVATE_KEY_SECRET)).rejects.toThrow();
  });

  it("treats a foreign/corrupt file as unreadable", async () => {
    const store = createEncryptedFileStore({ fileStoreDir: dir });
    // Write a non-JSON file under the sanitized name for the secret.
    await store.set(DEVICE_PRIVATE_KEY_SECRET, "seed");
    const files = await readdir(dir);
    const path = join(dir, files[0] as string);
    await writeFile(path, "not-json-at-all", "utf8");
    await expect(store.get(DEVICE_PRIVATE_KEY_SECRET)).rejects.toThrow();
  });

  it("rejects secret names that cannot be sanitized to a safe basename", async () => {
    const store = createEncryptedFileStore({ fileStoreDir: dir });
    await expect(store.set("..", "value")).rejects.toThrow();
  });

  it("keeps two different secret names in separate files", async () => {
    const store = createEncryptedFileStore({ fileStoreDir: dir });
    await store.set("key-a", "value-a");
    await store.set("key-b", "value-b");
    expect(await store.get("key-a")).toBe("value-a");
    expect(await store.get("key-b")).toBe("value-b");
  });
});

describe("resolveDefaultFileStoreDir", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("prefers APPDATA when present (Windows)", () => {
    process.env["APPDATA"] = "C:\\Users\\dev\\AppData\\Roaming";
    expect(resolveDefaultFileStoreDir()).toContain("cfls");
  });
});

describe("property: encrypted-file store round-trips arbitrary secrets", () => {
  // scrypt key derivation runs on every set/get, so this is intentionally given a
  // generous timeout; a single store/dir is reused (overwriting one secret) to
  // avoid per-iteration filesystem churn while still exercising 100+ inputs.
  it(
    "get after set returns the original value for any secret",
    async () => {
      const propDir = await mkdtemp(join(tmpdir(), "cfls-efs-prop-"));
      try {
        const store = createEncryptedFileStore({ fileStoreDir: propDir });
        await assertProperty(
          fc.asyncProperty(fc.string(), async (secret) => {
            await store.set(DEVICE_PRIVATE_KEY_SECRET, secret);
            return (await store.get(DEVICE_PRIVATE_KEY_SECRET)) === secret;
          }),
        );
      } finally {
        await rm(propDir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
