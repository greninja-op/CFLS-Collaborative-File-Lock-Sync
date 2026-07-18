/**
 * Unit tests for the OS credential-store adapter (design §8.2).
 *
 * Task 3.4 — verifies the adapter degrades gracefully when the optional `keytar`
 * native module is absent: it reports itself unavailable and every read/write
 * operation throws rather than pretending to persist the Device_Private_Key.
 *
 * These tests run in an environment WITHOUT `keytar` installed, which exercises
 * exactly the "OS store unavailable" path that the composite store relies on to
 * fall back (Req 5.8) or fail closed (Req 5.9).
 *
 * _Requirements: 5.8, 5.9; Design §8.2_
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  createOsCredentialStore,
  __resetKeytarProbeForTests,
} from "./os-credential-store";
import { DEFAULT_SECRET_SERVICE, DEVICE_PRIVATE_KEY_SECRET } from "./secret-store";

afterEach(() => {
  __resetKeytarProbeForTests();
});

describe("createOsCredentialStore (keytar not installed)", () => {
  it("identifies its backend as the OS credential store", () => {
    const store = createOsCredentialStore();
    expect(store.backend).toBe("os-credential-store");
  });

  it("reports itself unavailable when keytar cannot be loaded", async () => {
    const store = createOsCredentialStore();
    expect(await store.isAvailable()).toBe(false);
  });

  it("throws (never returns a value) on get when unavailable", async () => {
    const store = createOsCredentialStore();
    await expect(store.get(DEVICE_PRIVATE_KEY_SECRET)).rejects.toThrow();
  });

  it("throws on set when unavailable so no false success is reported", async () => {
    const store = createOsCredentialStore();
    await expect(store.set(DEVICE_PRIVATE_KEY_SECRET, "value")).rejects.toThrow();
  });

  it("throws on delete when unavailable", async () => {
    const store = createOsCredentialStore();
    await expect(store.delete(DEVICE_PRIVATE_KEY_SECRET)).rejects.toThrow();
  });

  it("accepts a custom service namespace without changing availability", async () => {
    const store = createOsCredentialStore("custom-service");
    expect(store.backend).toBe("os-credential-store");
    expect(await store.isAvailable()).toBe(false);
  });

  it("defaults the service namespace to DEFAULT_SECRET_SERVICE", () => {
    // Constant is exported for callers that need to key secrets consistently.
    expect(DEFAULT_SECRET_SERVICE).toBe("cfls-coordination-agent");
  });
});
