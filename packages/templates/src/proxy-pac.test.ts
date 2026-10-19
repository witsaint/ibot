import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { buildProxyPac, CN_DIRECT_DOMAINS, CN_DIRECT_TLDS, proxyPacDataUrl } from "./proxy-pac.js";

/**
 * Execute the PAC the way a browser would: load it into a fresh context that provides the PAC
 * builtins we use, then call FindProxyForURL. The builtins are the netscape-spec ones (Chrome's
 * implementations behave the same for these inputs). `dnsResolve` is deliberately a trap: if the
 * script ever calls it we want the test to fail loudly, because a resolve per request would leak
 * proxied hostnames to the box's own resolver.
 */
function loadPac(pac: string): (url: string, host: string) => string {
  const ip4 = (s: string): number[] | null => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
    return m ? m.slice(1).map(Number) : null;
  };
  const ctx = {
    isPlainHostName: (h: string) => !h.includes("."),
    dnsDomainIs: (h: string, d: string) => h.endsWith(d),
    isInNet: (h: string, pattern: string, mask: string) => {
      const a = ip4(h);
      const p = ip4(pattern);
      const m = ip4(mask);
      if (!a) throw new Error(`isInNet on a hostname (${h}) would resolve DNS`);
      if (!p || !m) return false;
      return a.every((o, i) => (o & m[i]!) === (p[i]! & m[i]!));
    },
    dnsResolve: (h: string): never => {
      throw new Error(`PAC called dnsResolve(${h}) — hostname leak`);
    },
  };
  runInNewContext(pac, ctx);
  const fn = (ctx as unknown as { FindProxyForURL: (u: string, h: string) => string })
    .FindProxyForURL;
  return (url, host) => fn(url, host);
}

const OPTS = { socksHost: "127.0.0.1", socksPort: 40000 };
/** Default is FAIL CLOSED: no `; DIRECT` tail, so a down tunnel errors instead of leaking a dirty IP. */
const PROXY = "SOCKS5 127.0.0.1:40000";

describe("buildProxyPac", () => {
  const route = loadPac(buildProxyPac(OPTS));

  it("routes .cn (and multi-label .com.cn/.gov.cn) DIRECT by TLD alone", () => {
    for (const h of ["baidu.cn", "www.gov.cn", "shop.example.com.cn", "xn--fiqs8s"]) {
      expect(route(`https://${h}/`, h)).toBe("DIRECT");
    }
  });

  it("routes whitelisted CN services and ALL their subdomains DIRECT", () => {
    for (const h of [
      "qq.com",
      "wx.qq.com",
      "res.wx.qq.com",
      "login.taobao.com",
      "g.alicdn.com",
      "api.bilibili.com",
      "Upos-Sz-Mirrorcos.BILIVIDEO.com", // case-insensitive
    ]) {
      expect(route(`https://${h}/`, h)).toBe("DIRECT");
    }
  });

  it("sends everything else through WARP's SOCKS5, with NO direct fallback", () => {
    for (const h of [
      "nowsecure.nl",
      "novita.ai",
      "github.com",
      "www.cloudflare.com",
      "qq.com.evil.example", // suffix match must anchor on label boundaries
      "notqq.com",
    ]) {
      expect(route(`https://${h}/`, h)).toBe(PROXY);
    }
  });

  it("keeps plain names, localhost and private IP literals DIRECT (management plane + in-box services)", () => {
    for (const h of [
      "localhost",
      "envd",
      "foo.localhost",
      "127.0.0.1",
      "10.64.136.14", // the PPIO edge relay
      "169.254.0.22", // metadata/default gw
      "172.31.255.1",
      "192.168.1.1",
      "100.64.0.1",
      "::1",
    ]) {
      expect(route(`http://${h}/`, h)).toBe("DIRECT");
    }
  });

  it("proxies PUBLIC IP literals without any DNS lookup (isInNet only ever sees literals)", () => {
    expect(route("http://1.1.1.1/", "1.1.1.1")).toBe(PROXY);
    expect(route("http://8.8.8.8/", "8.8.8.8")).toBe(PROXY);
    expect(route("http://[2606:4700::1111]/", "2606:4700::1111")).toBe(PROXY);
  });

  it("extraDirectDomains extends the whitelist and normalises entries", () => {
    const r = loadPac(
      buildProxyPac({ ...OPTS, extraDirectDomains: [" .Corp.Example. ", "", "x.io"] }),
    );
    expect(r("https://corp.example/", "corp.example")).toBe("DIRECT");
    expect(r("https://a.corp.example/", "a.corp.example")).toBe("DIRECT");
    expect(r("https://x.io/", "x.io")).toBe("DIRECT");
    expect(r("https://github.com/", "github.com")).toBe(PROXY);
  });

  it("is ES5 + ASCII and never references dnsResolve (no per-request local DNS)", () => {
    const pac = buildProxyPac(OPTS);
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7f]/.test(pac)).toBe(false);
    expect(pac).not.toContain("dnsResolve");
    expect(pac).not.toMatch(/\b(let|const|=>)\b/);
  });

  // ---- fail-closed: the reversal that makes a broken tunnel visible -------------------------
  // This is the single most important assertion in the file. With `; DIRECT` appended, a WARP that
  // is down doesn't break anything — it silently serves pages from the box's datacenter IP, which is
  // exactly the state a CF-walled site scores as a bot before rendering anything. Measured live: a
  // box sat that way for a day, pages loading at 71 KB/s, and the only visible symptom was a
  // Turnstile widget that never appeared.
  it("emits NO direct fallback by default, so a down tunnel fails loudly", () => {
    const pac = buildProxyPac(OPTS);
    expect(pac).not.toContain("; DIRECT");
    expect(pac).toContain('"SOCKS5 127.0.0.1:40000"');
    // DIRECT still exists as a routing DECISION for CN/private hosts — what's gone is the fallback.
    expect(pac).toContain('return "DIRECT"');
  });

  it("restores the fallback only when explicitly asked", () => {
    const r = loadPac(buildProxyPac({ ...OPTS, fallbackDirect: true }));
    expect(r("https://github.com/", "github.com")).toBe("SOCKS5 127.0.0.1:40000; DIRECT");
  });

  it("routes CN and private hosts identically either way (the switch touches only the fallback)", () => {
    // A box opting into the fallback must not silently get different split routing.
    const closed = loadPac(buildProxyPac(OPTS));
    const open = loadPac(buildProxyPac({ ...OPTS, fallbackDirect: true }));
    for (const h of ["baidu.cn", "wx.qq.com", "127.0.0.1", "10.64.136.14", "localhost"]) {
      expect(closed(`https://${h}/`, h)).toBe("DIRECT");
      expect(open(`https://${h}/`, h)).toBe("DIRECT");
    }
  });

  it("says which mode it is in, in the PAC's own first line", () => {
    // The readable copy at /opt/ibot-proxy.pac is what someone greps at 2am.
    expect(buildProxyPac(OPTS)).toContain("NO direct fallback (fail closed)");
    expect(buildProxyPac({ ...OPTS, fallbackDirect: true })).toContain("with DIRECT fallback");
  });

  it("whitelist data is tidy: lowercase, no leading dots, no duplicates, no bare TLDs", () => {
    const seen = new Set<string>();
    for (const d of CN_DIRECT_DOMAINS) {
      expect(d).toBe(d.toLowerCase().trim());
      expect(d.startsWith(".")).toBe(false);
      expect(d.includes(".")).toBe(true);
      expect(seen.has(d)).toBe(false);
      seen.add(d);
    }
    expect(CN_DIRECT_TLDS).toContain("cn");
  });
});

describe("proxyPacDataUrl", () => {
  it("wraps the PAC as a base64 data: URL Chrome accepts for --proxy-pac-url", () => {
    const pac = buildProxyPac(OPTS);
    const url = proxyPacDataUrl(pac);
    expect(url.startsWith("data:application/x-ns-proxy-autoconfig;base64,")).toBe(true);
    const b64 = url.slice(url.indexOf(",") + 1);
    expect(Buffer.from(b64, "base64").toString("ascii")).toBe(pac);
    // shell-safe inside single quotes and comfortably under Chrome's argv budget.
    expect(b64).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(url.length).toBeLessThan(64 * 1024);
  });

  it("refuses non-ASCII (would corrupt the data: URL)", () => {
    expect(() => proxyPacDataUrl("// 中文")).toThrow(/ASCII/);
  });
});
