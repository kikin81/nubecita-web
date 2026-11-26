import {describe, expect, it} from "vitest";
import {GuardError, type Lookup, checkedAddress, isPublicAddress, parseIssuer} from "../src/guard";

describe("parseIssuer", () => {
  it.each(["https://bsky.social", "https://pds.example.com", "https://bsky.social/"])("accepts %s", (issuer) => {
    expect(parseIssuer(issuer).origin).toBe(issuer.replace(/\/$/, ""));
  });

  it.each([
    ["http scheme", "http://bsky.social"],
    ["another scheme", "ftp://bsky.social"],
    ["IPv4 literal", "https://93.184.216.34"],
    ["IPv6 literal", "https://[2606:2800:220:1:248:1893:25c8:1946]"],
    ["loopback literal", "https://127.0.0.1"],
    ["metadata literal", "https://169.254.169.254"],
    ["decimal IPv4", "https://2130706433"],
    ["hex IPv4", "https://0x7f000001"],
    ["a path", "https://bsky.social/oauth"],
    ["a query", "https://bsky.social?x=1"],
    ["a fragment", "https://bsky.social#x"],
    ["credentials", "https://user:pass@bsky.social"],
    ["a non-default port", "https://bsky.social:8443"],
    ["a single-label host", "https://localhost"],
    ["an internal name", "https://metadata.google.internal"],
    ["a .local name", "https://printer.local"],
    ["nothing", ""],
    ["not a URL", "bsky.social"],
  ])("refuses an issuer with %s", (_label, issuer) => {
    expect(() => parseIssuer(issuer)).toThrow(GuardError);
  });
});

describe("isPublicAddress", () => {
  it.each(["93.184.216.34", "8.8.8.8", "2606:2800:220:1:248:1893:25c8:1946", "2001:4860:4860::8888"])(
    "allows %s",
    (address) => expect(isPublicAddress(address)).toBe(true),
  );

  it.each([
    ["unspecified", "0.0.0.0"],
    ["loopback", "127.0.0.1"],
    ["loopback (other)", "127.8.8.8"],
    ["private 10/8", "10.0.0.1"],
    ["private 172.16/12", "172.16.0.1"],
    ["private 172.31", "172.31.255.255"],
    ["private 192.168/16", "192.168.1.1"],
    ["carrier-grade NAT", "100.64.0.1"],
    ["link-local", "169.254.1.1"],
    ["cloud metadata", "169.254.169.254"],
    ["benchmarking", "198.18.0.1"],
    ["documentation", "192.0.2.1"],
    ["multicast", "224.0.0.1"],
    ["reserved", "240.0.0.1"],
    ["broadcast", "255.255.255.255"],
    ["v6 unspecified", "::"],
    ["v6 loopback", "::1"],
    ["v6 unique-local", "fd00::1"],
    ["v6 link-local", "fe80::1"],
    ["v6 multicast", "ff02::1"],
    ["v6 documentation", "2001:db8::1"],
    ["v4-mapped loopback", "::ffff:127.0.0.1"],
    ["v4-mapped metadata", "::ffff:169.254.169.254"],
    ["v4-mapped private", "::ffff:10.0.0.1"],
    ["NAT64 of a private address", "64:ff9b::a00:1"],
    ["not an address", "bsky.social"],
  ])("refuses %s (%s)", (_label, address) => expect(isPublicAddress(address)).toBe(false));
});

describe("checkedAddress", () => {
  const lookupOf =
    (...addresses: Array<[string, 4 | 6]>): Lookup =>
    async () =>
      addresses.map(([address, family]) => ({address, family}));

  it("returns an address that was checked, preferring IPv4", async () => {
    const result = await checkedAddress(
      "bsky.social",
      lookupOf(["2606:2800:220:1:248:1893:25c8:1946", 6], ["93.184.216.34", 4]),
    );

    expect(result).toEqual({address: "93.184.216.34", family: 4});
  });

  it("refuses a name that resolves to a private address", async () => {
    await expect(checkedAddress("evil.example", lookupOf(["10.0.0.5", 4]))).rejects.toThrow(GuardError);
  });

  it("refuses a name that resolves to the cloud metadata address", async () => {
    await expect(checkedAddress("evil.example", lookupOf(["169.254.169.254", 4]))).rejects.toThrow(GuardError);
  });

  it("refuses when ANY resolved address is not public, so a mixed answer cannot slip one through", async () => {
    await expect(
      checkedAddress("evil.example", lookupOf(["93.184.216.34", 4], ["127.0.0.1", 4])),
    ).rejects.toThrow(GuardError);
  });

  it("refuses a name that does not resolve", async () => {
    await expect(checkedAddress("nowhere.example", lookupOf())).rejects.toThrow(GuardError);
    await expect(
      checkedAddress("nowhere.example", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toThrow(GuardError);
  });
});
