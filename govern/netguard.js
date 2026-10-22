// Outbound-request guard for webhook deliveries.
//
// A tenant chooses its own webhook URL, so in a shared (cloud) deployment that
// URL is attacker-controlled input to a request our server makes. Without a
// guard, a tenant admin could point it at 169.254.169.254 or an internal
// service and use SpendVeto as a proxy into our network.
//
// The check runs on the RESOLVED address, inside the socket's own DNS lookup,
// so a hostname that resolves publicly at configuration time and privately at
// delivery time (DNS rebinding) is still refused. Redirects are never followed.
//
// In self_hosted mode the guard is off: delivering to an internal service
// (e.g. http://backend:8000 in the same compose network) is the whole point.
import dns from "node:dns";
import net from "node:net";

// Two separate lists on purpose: net.BlockList matches an IPv4 address against
// IPv4-mapped IPv6 rules, so putting ::ffff:0:0/96 in the same list as the
// IPv4 rules would block every public IPv4 address too.
const blockedV4 = new net.BlockList();
const blockedV6 = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blockedV4.addSubnet(addr, prefix, "ipv4");
// IPv6 ranges that are either internal or TRANSLATE to an IPv4 address. The
// translating ones are refused outright rather than decoded: no legitimate
// webhook receiver needs to be addressed through NAT64, 6to4, Teredo or an
// IPv4-compatible/-mapped form, and decoding them correctly in every spelling
// (dotted, hex, compressed) is exactly where guards get bypassed.
for (const [addr, prefix] of [
  ["::", 96],             // unspecified, loopback and IPv4-compatible (::a.b.c.d)
  ["::ffff:0:0", 96],     // IPv4-mapped
  ["64:ff9b::", 96],      // NAT64 well-known prefix
  ["64:ff9b:1::", 48],    // NAT64 local-use prefix
  ["2002::", 16],         // 6to4
  ["2001::", 32],         // Teredo
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32], ["100::", 64],
]) blockedV6.addSubnet(addr, prefix, "ipv6");

function embeddedV4(ip) {
  // Dotted spellings (::ffff:a.b.c.d, 64:ff9b::a.b.c.d) are judged by the
  // IPv4 host they reach, in case BlockList parses them differently.
  const m = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1] : null;
}

export function isBlockedAddress(ip) {
  const bare = String(ip).replace(/^\[|\]$/g, "").replace(/%.*$/, ""); // strip brackets and zone id
  const v4 = net.isIPv4(bare) ? bare : embeddedV4(bare);
  if (v4 && blockedV4.check(v4, "ipv4")) return true;
  if (net.isIPv4(bare)) return false;
  if (net.isIPv6(bare)) return blockedV6.check(bare, "ipv6");
  return true; // not an IP at all — refuse
}

export function guardEnabled() {
  return (process.env.SPENDVETO_DEPLOYMENT || "cloud") !== "self_hosted";
}

// Validates the URL's shape. Address checks happen at connect time (below).
export function assertWebhookUrlShape(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("webhook url is not a valid URL");
  }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("webhook url must be http or https");
  if (u.username || u.password) throw new Error("webhook url must not embed credentials");
  if (guardEnabled() && net.isIP(u.hostname.replace(/^\[|\]$/g, "")) && isBlockedAddress(u.hostname.replace(/^\[|\]$/g, ""))) {
    throw new Error("webhook url points at a private, loopback or reserved address");
  }
  return u;
}

// Resolves at config time too, so an obviously internal hostname is refused
// up front rather than failing silently on every delivery.
export async function assertWebhookUrlAllowed(raw) {
  const u = assertWebhookUrlShape(raw);
  if (!guardEnabled()) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.promises.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isBlockedAddress(a.address))) {
    throw new Error(`webhook host ${host} resolves to a private, loopback or reserved address`);
  }
  return u;
}

// A dns.lookup replacement for http(s).request: refuses blocked addresses at
// the moment the socket is about to connect.
export function guardedLookup(hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
    if (guardEnabled() && list.some((a) => isBlockedAddress(a.address))) {
      const e = new Error(`refused: ${hostname} resolves to a private, loopback or reserved address`);
      e.code = "ESPENDVETO_SSRF";
      return callback(e);
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}
