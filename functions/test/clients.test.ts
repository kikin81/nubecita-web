import {describe, expect, it} from "vitest";
import {type ClientConfig, selectKey} from "../src/clients";

const clients: ClientConfig[] = [
  {
    clientId: "https://nubecita.app/oauth/client-metadata.json",
    defaultKid: "prod-2",
    keys: {"prod-1": "kms/prod/1", "prod-2": "kms/prod/2"},
  },
  {
    clientId: "https://nubecita.app/oauth/client-metadata-test.json",
    defaultKid: "test-1",
    keys: {"test-1": "kms/test/1"},
  },
];
const prod = "https://nubecita.app/oauth/client-metadata.json";

describe("selectKey", () => {
  it("uses the client's default key when none is named", () => {
    expect(selectKey(clients, prod, undefined)).toEqual({ok: true, kid: "prod-2", keyVersion: "kms/prod/2"});
  });

  it("uses exactly the named key, even when a newer default exists", () => {
    expect(selectKey(clients, prod, "prod-1")).toEqual({ok: true, kid: "prod-1", keyVersion: "kms/prod/1"});
  });

  it("refuses an unknown named key rather than substituting the default", () => {
    expect(selectKey(clients, prod, "prod-0")).toEqual({ok: false, reason: "unknown_key"});
  });

  it("refuses a key that belongs to a different client", () => {
    expect(selectKey(clients, prod, "test-1")).toEqual({ok: false, reason: "unknown_key"});
  });

  it("refuses a client it holds no key for", () => {
    expect(selectKey(clients, "https://evil.example/client.json", undefined)).toEqual({ok: false, reason: "unknown_client"});
    expect(selectKey(clients, undefined, undefined)).toEqual({ok: false, reason: "unknown_client"});
  });

  it("treats a blank key id as none named", () => {
    expect(selectKey(clients, prod, "  ")).toEqual({ok: true, kid: "prod-2", keyVersion: "kms/prod/2"});
  });

  it("is not fooled by an inherited property name", () => {
    expect(selectKey(clients, prod, "constructor")).toEqual({ok: false, reason: "unknown_key"});
    expect(selectKey(clients, prod, "__proto__")).toEqual({ok: false, reason: "unknown_key"});
  });
});
