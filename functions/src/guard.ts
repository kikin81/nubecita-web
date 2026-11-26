import {lookup as dnsLookup} from "node:dns/promises";
import {BlockList, isIP} from "node:net";

/**
 * The backend makes outbound requests to servers named by a device. Every one
 * of them goes through this guard, so that it can only ever reach a public
 * https server and never anything inside Google Cloud or on a private network.
 */

/** Thrown when an issuer or address is not one the backend will contact. */
export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves a hostname to every address it has. Injected so tests need no DNS. */
export type Lookup = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemLookup: Lookup = async (hostname) => {
  const answers = await dnsLookup(hostname, {all: true});
  return answers.map(({address, family}) => ({address, family: family === 6 ? 6 : 4}));
};

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including the cloud metadata server
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including broadcast
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b::", 96], // NAT64: could map to any IPv4 address, private ones included
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique-local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

/** Whether an IP address is one on the public internet. Anything unparseable is not. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  // BlockList also matches an IPv4 rule against the IPv4-mapped IPv6 form.
  return !blocked.check(address, family === 6 ? "ipv6" : "ipv4");
}

/**
 * Validates an authorization server issuer supplied by a device and returns
 * it as a URL. AT Protocol issuers are bare https origins; anything else is
 * refused before any network activity.
 */
export function parseIssuer(issuer: string): URL {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new GuardError("issuer is not a URL");
  }
  if (url.protocol !== "https:") throw new GuardError("issuer must be https");
  if (url.username !== "" || url.password !== "") throw new GuardError("issuer must not carry credentials");
  if (url.port !== "") throw new GuardError("issuer must use the default port");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") throw new GuardError("issuer must be a bare origin");
  assertPublicHostname(url.hostname);
  return url;
}

/**
 * A hostname the backend is willing to resolve: a multi-label DNS name that
 * is not an IP address in any spelling and not a name reserved for local use.
 */
export function assertPublicHostname(hostname: string): void {
  // WHATWG URL already normalises decimal/hex/octal IPv4 spellings to dotted
  // form and brackets IPv6, so these two checks cover every literal.
  if (hostname.startsWith("[") || isIP(hostname) !== 0) throw new GuardError("host must be a DNS name, not an address");
  const labels = hostname.toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length < 2 || labels.some((label) => label === "")) throw new GuardError("host must be a full DNS name");
  const tld = labels[labels.length - 1];
  if (tld === "internal" || tld === "local" || tld === "localhost" || tld === "lan" || tld === "home" || tld === "arpa") {
    throw new GuardError("host is a local-use name");
  }
}

/**
 * Resolves `hostname` and returns one address to connect to, after checking
 * EVERY address it resolved to. The caller must connect to the returned
 * address and not resolve the name again: resolving twice is how a hostile
 * name answers "public" to the check and "private" to the connection.
 */
export async function checkedAddress(hostname: string, lookup: Lookup): Promise<ResolvedAddress> {
  let answers: ResolvedAddress[];
  try {
    answers = await lookup(hostname);
  } catch {
    throw new GuardError("host does not resolve");
  }
  const first = answers[0];
  if (first === undefined) throw new GuardError("host does not resolve");
  for (const answer of answers) {
    if (!isPublicAddress(answer.address)) throw new GuardError("host resolves to a non-public address");
  }
  return answers.find((answer) => answer.family === 4) ?? first;
}
