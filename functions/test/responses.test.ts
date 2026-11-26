import {describe, expect, it} from "vitest";
import {MEDIATOR_REASONS, ORIGIN_HEADER, mediatorError} from "../src/responses";

describe("mediatorError", () => {
  it("marks the response as produced by the backend, not relayed", () => {
    const response = mediatorError(503, "upstream_timeout", "unknown");

    expect(response.status).toBe(503);
    expect(response.headers[ORIGIN_HEADER]).toBe("mediator");
    expect(response.headers["Content-Type"]).toBe("application/json");
    expect(response.headers["Cache-Control"]).toBe("no-store");
    expect(JSON.parse(response.body)).toEqual({error: "mediator_upstream_timeout", forwarded: "unknown"});
  });

  it("says whether the request was forwarded", () => {
    expect(JSON.parse(mediatorError(404, "not_found", false).body).forwarded).toBe(false);
    expect(JSON.parse(mediatorError(502, "internal", true).body).forwarded).toBe(true);
  });

  it("can never be read as an OAuth error, least of all invalid_grant", () => {
    for (const reason of MEDIATOR_REASONS) {
      const body = mediatorError(400, reason, false).body;
      expect(JSON.parse(body).error).toMatch(/^mediator_/);
      expect(body).not.toContain("invalid_grant");
    }
  });
});
