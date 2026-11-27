import {Timestamp} from "firebase-admin/firestore";
import {afterAll, describe, expect, it} from "vitest";
import {REPLAY_COLLECTION} from "../../src/config";
import type {OutboundResponse} from "../../src/outbound";
import {entryId, issuedMark} from "../../src/replayCrypto";
import {ENTRY_LIFETIME_MS} from "../../src/replayStore";
import {REPLAYED_HEADER} from "../../src/responses";
import {DPOP, START, dpopProof, harness, json, refresh, tokenTraces} from "../harness";
import {newToken, replayScenarios, tokens} from "../replayScenarios";
import {emulatedStores, rawDocument} from "./firestore";

const {database, store, otherStore, close} = emulatedStores();
afterAll(close);

describe("replay-safe refresh on Firestore", () => {
  replayScenarios(() => store);

  it("forwards once when the same refresh reaches two instances at the same moment", async () => {
    const token = newToken();
    const body = tokens();
    let forwards = 0;
    let answer: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    const upstream = async (): Promise<OutboundResponse> => {
      forwards += 1;
      await answered;
      return json(200, body);
    };
    const instances = [store, otherStore].map((replayStore) => harness({replayStore, upstream: [upstream]}));

    const both = instances.map((instance) => instance.handle(refresh({}, token)));
    // The authorization server has not answered yet, so whichever returns
    // first is the one that was held back.
    const heldBack = await Promise.race(both);
    answer();
    const responses = await Promise.all(both);

    expect(forwards).toBe(1);
    expect(heldBack.status).toBe(409);
    expect(JSON.parse(heldBack.body)).toEqual({error: "mediator_in_progress", forwarded: "unknown"});
    expect(JSON.parse(responses.find((response) => response !== heldBack)!.body)).toEqual(body);

    // Whichever instance the retry lands on, it is given the same answer.
    for (const instance of instances) {
      const retried = await instance.handle(refresh({dpop: dpopProof()}, token));
      expect(JSON.parse(retried.body)).toEqual(body);
      expect(retried.headers[REPLAYED_HEADER]).toBe("1");
    }
    expect(forwards).toBe(1);
  });
});

describe("what is written to Firestore", () => {
  it("contains no part of any token, in a finished entry or a pending one", async () => {
    const [first, stalled] = [newToken(), newToken()];
    const body = tokens();
    const proof = dpopProof();
    const h = harness({
      replayStore: store,
      upstream: [
        () => json(200, body),
        () => {
          throw new Error("no answer");
        },
      ],
    });
    await h.handle(refresh({dpop: proof}, first));
    await h.handle(refresh({dpop: proof}, stalled));

    const done = await rawDocument(entryId(first));
    const pending = await rawDocument(entryId(stalled));

    const secrets = [first, stalled, body.access_token, body.refresh_token, proof, DPOP, "did:plc:alice1234567890"];
    expect(tokenTraces(done, secrets)).toEqual([]);
    expect(tokenTraces(pending, secrets)).toEqual([]);
    // The same again on the decoded bytes, in case an encoding hid something.
    const data = (await database.collection(REPLAY_COLLECTION).doc(entryId(first)).get()).data() ?? {};
    const bytes = Buffer.concat([data["salt"], data["iv"], data["ciphertext"]]);
    expect(tokenTraces([bytes.toString("latin1"), bytes.toString("hex"), bytes.toString("base64url")].join("\n"), secrets)).toEqual([]);

    expect(Object.keys(data).sort()).toEqual(["at", "ciphertext", "expireAt", "issued", "iv", "salt", "state"]);
    expect(data).toMatchObject({state: "done", at: START, issued: issuedMark(body.refresh_token)});
    expect(Object.keys(JSON.parse(pending).fields).sort()).toEqual(["at", "expireAt", "lease", "state"]);
  });

  it("carries the time at which the TTL policy may delete it: 24 hours on", async () => {
    const token = newToken();
    await harness({replayStore: store, upstream: [() => json(200, tokens())]}).handle(refresh({}, token));

    const data = (await database.collection(REPLAY_COLLECTION).doc(entryId(token)).get()).data();

    expect(data?.["expireAt"]).toBeInstanceOf(Timestamp);
    expect((data?.["expireAt"] as Timestamp).toMillis()).toBe(START + ENTRY_LIFETIME_MS);
  });
});
