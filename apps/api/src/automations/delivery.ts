import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { signWebhook } from "./protocol.js";

const privateV4 = new BlockList();
const privateV6 = new BlockList();
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [ip, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  privateV4.addSubnet(ip, bits, "ipv4");
for (const [ip, bits] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  privateV6.addSubnet(ip, bits, "ipv6");
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return (
    family !== 0 &&
    !(family === 6
      ? !globalV6.check(address, "ipv6") || privateV6.check(address, "ipv6")
      : privateV4.check(address, "ipv4"))
  );
}
/** Resolve once, reject any private answer, pin the connection to that IP. No redirects. */
export async function sendCallback(
  url: string,
  secret: string,
  eventId: string,
  body: string,
): Promise<void> {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.username || target.password || target.hash)
    throw new Error("回调地址必须是 HTTPS");
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const answers = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookupWithTimeout(hostname);
  if (!answers.length || answers.some((a) => !isPublicAddress(a.address)))
    throw new Error("回调地址不能指向内部网络");
  const address = answers[0]!;
  const timestamp = String(Math.floor(Date.now() / 1000));
  await new Promise<void>((resolve, reject) => {
    const req = request(
      target,
      {
        method: "POST",
        lookup: (_host, options, cb) => {
          // Node's autoSelectFamily requests all addresses; preserve that callback shape.
          if (options.all) cb(null, [address]);
          else cb(null, address.address, address.family);
        },
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-ibot-event-id": eventId,
          "x-ibot-timestamp": timestamp,
          "x-ibot-signature": signWebhook(secret, eventId, timestamp, body),
        },
      },
      (res) => {
        const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300;
        res.destroy();
        if (ok) resolve();
        else reject(new Error(`回调返回 HTTP ${res.statusCode ?? "未知"}`));
      },
    );
    const timer = setTimeout(() => req.destroy(new Error("回调超时")), 5000);
    req.once("close", () => clearTimeout(timer));
    req.once("error", reject);
    req.end(body);
  });
}

async function lookupWithTimeout(hostname: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("回调 DNS 查询超时")), 5000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
