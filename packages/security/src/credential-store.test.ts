/**
 * Unit tests for the composite Device_Private_Key secret store (design §8.2).
 *
 * Task 3.4 — verifies backend selection (OS credential store → encrypted-file
 * fallback), that the encrypted-file fallback is used when the OS store is
 * unavailable/disabled (Req 5.8), and that a {@link SecureStorageUnavailableError}
 * carrying the `SECURE_STORAGE_UNAVAILABLE` protocol code is surfaced when neither
 * backend is usable so the agent can fail closed (Req 5.9).
 *
 * _Requirements: 5.8, 5.9; Design §8.2_
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSecretStore } from "./credential-store";
import {
  DEVICE_PRIVATE_KEY_SECRET,
  SecureStorageUnavailableError,
} from "./secret-store";
import { __resetKeytarProbeForTests } from "./os-credential-store";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cfls-cs-"));
});

afterEach(async () => {
  __resetKeytarProbeForTests();
  await rm(dir, { recursive: true, force: true });
});

describe("createSecretStore — fallback to encrypted file", () => {
  // In this environment keytar is not installed, so the OS store is unavailable
  // and the composite store must resolve to the encrypted-file fallback.
  it("resolves to the encrypted-file backend when the OS store is unavailable", async () => {
    const store = createSecretStore({ fileStoreDir: dir });
    expect(await store.isAvailable()).toBe(true);
    // Perform an operation so the backend is resolved, then inspect it.
    await store.set(DEVICE_PRIVATE_KEY_SECRET, "seed");
    expect(store.backend).toBe("encrypted-file");
  });

  it("round-trips the Device_Private_Key through the fallback", async () => {
    const store = createSecretStore({ fileStoreDir: dir });
    const secret = "device-private-key-material==";
    await store.set(DEVICE_PRIVATE_KEY_SECRET, secret);
    expect(await store.get(DEVICE_PRIVATE_KEY_SECRET)).toBe(secret);
    expect(await store.delete(DEVICE_PRIVATE_KEY_SECRET)).toBe(true);
    expect(await store.get(DEVICE_PRIVATE_KEY_SECRET)).toBeNull();
  });

  it("uses the fallback when the OS store is explicitly disabled", async () => {
    const store = createSecretStore({
      disableOsStore: true,
      fileStoreDir: dir,
    });
    await store.set(DEVICE_PRIVATE_KEY_SECRET, "x");
    expect(store.backend).toBe("encrypted-file");
  });
});

describe("createSecretStore — no usable backend (Req 5.9)", () => {
  it("isAvailable resolves false when both backends are disabled", async () => {
    const store = createSecretStore({
      disableOsStore: true,
      disableFileStore: true,
    });
    expect(await store.isAvailable()).toBe(false);
    expect(store.backend).toBe("unavailable");
  });

  it("throws SecureStorageUnavailableError on get when no backend is usable", async () => {
    const store = createSecretStore({
      disableOsStore: true,
      disableFileStore: true,
    });
    await expect(store.get(DEVICE_PRIVATE_KEY_SECRET)).rejects.toBeInstanceOf(
      SecureStorageUnavailableError,
    );
  });

  it("throws SecureStorageUnavailableError on set when no backend is usable", async () => {
    const store = createSecretStore({
      disableOsStore: true,
      disableFileStore: true,
    });
    await expect(
      store.set(DEVICE_PRIVATE_KEY_SECRET, "value"),
    ).rejects.toBeInstanceOf(SecureStorageUnavailableError);
  });

  it("carries the SECURE_STORAGE_UNAVAILABLE protocol error code", async () => {
    const store = createSecretStore({
      disableOsStore: true,
      disableFileStore: true,
    });
    try {
      await store.delete(DEVICE_PRIVATE_KEY_SECRET);
      expect.fail("expected SecureStorageUnavailableError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SecureStorageUnavailableError);
      expect((err as SecureStorageUnavailableError).code).toBe(
        "SECURE_STORAGE_UNAVAILABLE",
      );
    }
  });
});
