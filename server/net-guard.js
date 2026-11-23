import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

// Outbound HTTP for platform shops. A shop owner chooses their store address,
// and this server then makes authenticated requests to it, so a domain that
// resolves (or re-resolves, DNS rebinding) to a private, loopback, link-local
// or otherwise internal address must never be connected to. The check runs in
// the connection's own DNS lookup, so it also covers redirects and every retry.
// Separate lists: a BlockList also matches IPv4 addresses against IPv6
// (IPv4-mapped) rules, which would block every IPv4 address.
const blockedV4 = new net.BlockList();
const blockedV6 = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blockedV4.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blockedV6.addSubnet(network, prefix, 'ipv6');

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (!family) return false;
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) is judged as the IPv4 address it carries.
  const mapped = family === 6 && /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return !blockedV4.check(mapped[1], 'ipv4');
  if (family === 6 && /^::ffff:/i.test(address)) return false; // other mapped spellings: refuse
  return family === 4 ? !blockedV4.check(address, 'ipv4') : !blockedV6.check(address, 'ipv6');
}

export class BlockedAddressError extends Error {
  constructor(hostname) { super(`Refused to connect to ${hostname}: it points to a private or internal network address.`); this.code = 'EPRIVATEADDR'; }
}

export function guardedLookup(resolver = dns.lookup) {
  return (hostname, options, callback) => {
    resolver(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }];
      if (!list.length || list.some(entry => !isPublicAddress(entry.address))) return callback(new BlockedAddressError(hostname));
      if (options?.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

// A fetch() that only speaks HTTPS to public addresses. `resolver` is for tests.
export function createGuardedFetch({ resolver, connect = {} } = {}) {
  const agent = new Agent({ connect: { ...connect, lookup: guardedLookup(resolver) }, connectTimeout: 10000 });
  const guarded = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.protocol !== 'https:') throw new TypeError('Only HTTPS store addresses are allowed.');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // IP literals skip DNS lookup entirely, so they are judged here.
    if (net.isIP(host) && !isPublicAddress(host)) throw new BlockedAddressError(host);
    if (net.isIP(host)) throw new TypeError('Use the store\'s domain name, not an IP address.');
    return undiciFetch(url, { ...init, dispatcher: agent });
  };
  guarded.close = () => agent.close();
  return guarded;
}
