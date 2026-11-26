import {describe, expect, it} from "vitest";
import {CLIENTS} from "../src/config";
import {keyVersionsByKid} from "../src/kmsSigner";

describe("keyVersionsByKid", () => {
  it("maps every key id to its key version", () => {
    const map = keyVersionsByKid([
      {clientId: "a", defaultKid: "a-2", keys: {"a-1": "kms/a/1", "a-2": "kms/a/2"}},
      {clientId: "b", defaultKid: "b-1", keys: {"b-1": "kms/b/1"}},
    ]);

    expect([...map]).toEqual([["a-1", "kms/a/1"], ["a-2", "kms/a/2"], ["b-1", "kms/b/1"]]);
  });

  it("refuses a key id shared by two clients, since the id alone picks the key", () => {
    expect(() =>
      keyVersionsByKid([
        {clientId: "a", defaultKid: "k-1", keys: {"k-1": "kms/a/1"}},
        {clientId: "b", defaultKid: "k-1", keys: {"k-1": "kms/b/1"}},
      ]),
    ).toThrow(/more than one client/);
  });

  it("refuses a default key id with no key behind it", () => {
    expect(() => keyVersionsByKid([{clientId: "a", defaultKid: "a-2", keys: {"a-1": "kms/a/1"}}])).toThrow(/default key id/);
  });
});

describe("the deployed client configuration", () => {
  it("is internally consistent", () => {
    expect(() => keyVersionsByKid(CLIENTS)).not.toThrow();
  });

  it("only serves Nubecita's own published client metadata files", () => {
    for (const client of CLIENTS) {
      expect(client.clientId).toMatch(/^https:\/\/nubecita\.app\/oauth\/client-metadata(-[a-z]+)?\.json$/);
    }
    expect(new Set(CLIENTS.map((client) => client.clientId)).size).toBe(CLIENTS.length);
  });

  it("keeps each client's keys in its own KMS key", () => {
    const keysOf = (clientId: string) =>
      Object.values(CLIENTS.find((client) => client.clientId === clientId)?.keys ?? {}).map(
        (name) => /cryptoKeys\/([^/]+)\//.exec(name)?.[1],
      );

    expect(new Set(keysOf("https://nubecita.app/oauth/client-metadata.json"))).toEqual(new Set(["nubecita-prod"]));
    expect(new Set(keysOf("https://nubecita.app/oauth/client-metadata-test.json"))).toEqual(new Set(["nubecita-test"]));
  });
});
