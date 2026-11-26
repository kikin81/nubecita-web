import {describe, expect, it} from "vitest";
import {handleRequest} from "../src/mediator";
import {ORIGIN_HEADER} from "../src/responses";

describe("handleRequest (scaffold)", () => {
  it.each([
    ["GET", "/"],
    ["POST", "/"],
    ["POST", "/xrpc/app.bsky.feed.getTimeline"],
    ["GET", "/par"],
    ["POST", "/token/extra"],
  ])("answers %s %s with a backend-produced 404 and forwards nothing", async (method, path) => {
    const response = await handleRequest({method, path, headers: {}, body: ""});

    expect(response.status).toBe(404);
    expect(response.headers[ORIGIN_HEADER]).toBe("mediator");
    expect(JSON.parse(response.body)).toEqual({error: "mediator_not_found", forwarded: false});
  });
});
