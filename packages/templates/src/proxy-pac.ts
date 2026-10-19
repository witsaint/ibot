/**
 * Split-routing for the desktop browser: a PAC (proxy auto-config) script that sends domestic (CN)
 * traffic DIRECT and everything else through the WARP SOCKS5 proxy on loopback. Pure data + string
 * builder, no I/O — `provision.ts` embeds the result in Chrome's launch flags.
 *
 * Why a PAC instead of a flat `--proxy-server`: WARP's free node is a Cloudflare anycast IP that
 * reads as "overseas" to many CN sites (geo-walls, login SMS gates, slow trans-border hops), while
 * the box's own egress IS domestic and reaches them fast. A flat proxy flag forces both worlds down
 * the same pipe; the PAC picks per-host at connect time.
 *
 * Delivery: Chrome accepts `--proxy-pac-url` with http(s)/data: schemes ONLY — `file://` PAC URLs
 * were removed (net::PacFileFetcherImpl rejects them), so we pass the script as a base64 `data:`
 * URL. A readable copy is still written to /opt/ibot-proxy.pac for on-box debugging.
 *
 * Matching: suffix-walk over the host's labels against a lookup table (O(labels), not O(list)),
 * so the whitelist can grow without slowing every request. No `dnsResolve`/`isInNet` on hostnames —
 * those force a LOCAL DNS lookup per request, leaking proxied hostnames to the box's resolver and
 * adding latency. Private-range checks run only on hosts that are already IP literals.
 *
 * Fallback: FAIL CLOSED by default (`fallbackDirect: false` → proxied hosts get `SOCKS5 …` with no
 * `; DIRECT` tail). This reverses an earlier choice, and the reversal is the whole point:
 *
 * The `; DIRECT` tail reads as graceful degradation, and it is the exact mechanism by which this
 * silently stopped working. Measured on a live box 2026-09-23: WARP sat `Disconnected` for a day, the
 * SOCKS5 port was not even listening, so every request took the tail and egressed from the Tencent
 * datacenter IP. Pages loaded fine at 71 KB/s. Nothing looked broken anywhere — and Cloudflare simply
 * never rendered the Turnstile widget, because a datacenter ASN is pre-scored. The reported symptom
 * ("人机验证都出不来了") was the fallback working as designed.
 *
 * Failing closed converts that into `ERR_PROXY_CONNECTION_FAILED` — an obvious, attributable error on
 * the very first request, which the keeper then heals within ~30s (see `warp-keeper.sh`). The trade is
 * deliberate and it is the right way round: a visible failure that self-heals in half a minute beats
 * an invisible one that quietly produces wrong results for a day. "Degraded but working" is not a
 * state this system can have, because the degraded egress is precisely what the task needed clean.
 *
 * `fallbackDirect: true` restores the old behaviour for a box that only needs a clean IP
 * opportunistically (scraping non-walled sites, where any egress beats none).
 */

/**
 * Top-level domains that are domestic by definition. Matched as label suffixes, so `.com.cn`,
 * `.gov.cn` etc. are covered by `cn`. `xn--fiqs8s` / `xn--fiqz9s` are the punycode forms of
 * `.中国` / `.中國`.
 */
export const CN_DIRECT_TLDS = ["cn", "xn--fiqs8s", "xn--fiqz9s"] as const;

/**
 * Domestic services that live on non-.cn domains (the whitelist the PAC routes DIRECT). Grouped by
 * operator; each entry matches itself and every subdomain. Keep this to services that are actually
 * hosted in-country — an overseas domain here just loses the clean egress it needs. Sites that are
 * geo-blocked for CN (google.com, t.co, …) stay OFF this list: neither path reaches them, and
 * listing them would only hide that fact.
 */
export const CN_DIRECT_DOMAINS: readonly string[] = [
  // Baidu
  "baidu.com",
  "bdstatic.com",
  "bdimg.com",
  "baidupcs.com",
  "baiduyun.com",
  "hao123.com",
  // Tencent / WeChat / QQ
  "qq.com",
  "weixin.com",
  "wechat.com",
  "weixinbridge.com",
  "tencent.com",
  "tencent-cloud.com",
  "tencentcloudapi.com",
  "tencentcs.com",
  "myqcloud.com",
  "qpic.cn",
  "gtimg.com",
  "qlogo.cn",
  "idqqimg.com",
  "url.cn",
  // Alibaba / Aliyun / Alipay / Taobao / Tmall
  "alibaba.com",
  "alibaba-inc.com",
  "alibabacloud.com",
  "aliyun.com",
  "aliyuncs.com",
  "alicdn.com",
  "alipay.com",
  "alipayobjects.com",
  "taobao.com",
  "tmall.com",
  "tmall.hk",
  "1688.com",
  "mmstat.com",
  "alimama.com",
  "aliexpress.com",
  "dingtalk.com",
  "youku.com",
  "ykimg.com",
  "amap.com",
  "autonavi.com",
  "ele.me",
  "fliggy.com",
  "cainiao.com",
  "xiami.com",
  "uc.cn",
  // ByteDance
  "bytedance.com",
  "byteimg.com",
  "bytecdn.com",
  "douyin.com",
  "douyinpic.com",
  "douyinstatic.com",
  "toutiao.com",
  "toutiaoimg.com",
  "pstatp.com",
  "snssdk.com",
  "ixigua.com",
  "feishu.cn",
  "feishu.net",
  "larksuite.com",
  "volcengine.com",
  "volccdn.com",
  "volces.com",
  // JD
  "jd.com",
  "jd.hk",
  "360buyimg.com",
  "jdcloud.com",
  "jcloud.com",
  // Meituan / Dianping
  "meituan.com",
  "meituan.net",
  "dianping.com",
  "dpfile.com",
  // Bilibili
  "bilibili.com",
  "bilivideo.com",
  "hdslb.com",
  "biliapi.com",
  "biliapi.net",
  "acg.tv",
  "b23.tv",
  // Sina / Weibo
  "sina.com",
  "sina.com.cn",
  "sinaimg.cn",
  "weibo.com",
  "weibo.cn",
  "weibocdn.com",
  // NetEase
  "163.com",
  "126.com",
  "126.net",
  "127.net",
  "netease.com",
  "yeah.net",
  "lofter.com",
  "youdao.com",
  // Sohu / Sogou
  "sohu.com",
  "sogou.com",
  "sogoucdn.com",
  // Xiaomi / Huawei / OPPO / vivo
  "mi.com",
  "xiaomi.com",
  "xiaomi.net",
  "miui.com",
  "huawei.com",
  "huaweicloud.com",
  "hicloud.com",
  "vmall.com",
  "dbankcloud.com",
  "oppo.com",
  "heytapmobi.com",
  "vivo.com",
  // Kuaishou / Xiaohongshu / Zhihu / Douban
  "kuaishou.com",
  "kuaishoupay.com",
  "kwimgs.com",
  "yximgs.com",
  "xiaohongshu.com",
  "xhscdn.com",
  "zhihu.com",
  "zhimg.com",
  "douban.com",
  "doubanio.com",
  // Pinduoduo
  "pinduoduo.com",
  "pddpic.com",
  "yangkeduo.com",
  // Ctrip / Didi / Qunar
  "ctrip.com",
  "c-ctrip.com",
  "didiglobal.com",
  "didistatic.com",
  "xiaojukeji.com",
  "qunar.com",
  "qunarzz.com",
  // iQIYI / Tencent Video / Mango / Migu
  "iqiyi.com",
  "iqiyipic.com",
  "qy.net",
  "mgtv.com",
  "hitv.com",
  "migu.cn",
  "cmvideo.cn",
  // Dev / cloud tooling hosted in-country
  "gitee.com",
  "gitee.io",
  "coding.net",
  "csdn.net",
  "csdnimg.cn",
  "oschina.net",
  "npmmirror.com",
  "npm.taobao.org",
  "cnpmjs.org",
  "ustc.edu.cn",
  "tuna.tsinghua.edu.cn",
  "bootcdn.net",
  "staticfile.org",
  "qiniu.com",
  "qiniucdn.com",
  "qnssl.com",
  "clouddn.com",
  "upyun.com",
  "upaiyun.com",
  "ksyun.com",
  "kingsoft.com",
  "wps.cn",
  "wps.com",
  "ucloud.cn",
  // Other large domestic sites
  "58.com",
  "58cdn.com.cn",
  "anjuke.com",
  "autohome.com.cn",
  "ke.com",
  "lianjia.com",
  "ganji.com",
  "suning.com",
  "vip.com",
  "vipstatic.com",
  "gome.com.cn",
  "dangdang.com",
  "smzdm.com",
  "hupu.com",
  "tianyancha.com",
  "qichacha.com",
  "12306.cn",
  "boc.cn",
  "icbc.com.cn",
  "ccb.com",
  "abchina.com",
  "cmbchina.com",
  "unionpay.com",
  "95516.com",
  // Chinese-hosted AI vendors
  "deepseek.com",
  "moonshot.cn",
  "kimi.com",
  "zhipuai.cn",
  "bigmodel.cn",
  "minimax.chat",
  "minimaxi.com",
  "baichuan-ai.com",
  "qwen.ai",
];

/** Loopback / RFC1918 / link-local / CGNAT — never leaves the box, so never enters the proxy. */
const PRIVATE_V4_RANGES: ReadonlyArray<readonly [string, string]> = [
  ["127.0.0.0", "255.0.0.0"],
  ["10.0.0.0", "255.0.0.0"],
  ["172.16.0.0", "255.240.0.0"],
  ["192.168.0.0", "255.255.0.0"],
  ["169.254.0.0", "255.255.0.0"],
  ["100.64.0.0", "255.192.0.0"],
];

export interface ProxyPacOptions {
  /** SOCKS5 host:port the non-whitelisted traffic goes through. */
  socksHost: string;
  socksPort: number;
  /** Extra domains to route DIRECT on top of the built-in CN list (per-box additions). */
  extraDirectDomains?: readonly string[];
  /**
   * Append `; DIRECT` to the proxy result, letting Chrome fall back to the box's own (dirty) egress
   * when WARP is unreachable. Default **false** — see the fail-closed rationale in the module doc.
   * Only turn this on for a box whose clean IP is nice-to-have rather than the point.
   */
  fallbackDirect?: boolean;
}

/** Lower-case, strip a leading dot and any trailing dot, drop empties/dupes — a stable lookup key. */
function normaliseDomain(d: string): string {
  return d.trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
}

/**
 * Build the PAC source. Plain ES5 (PAC engines are old-school; Chrome's is V8 but the spec
 * functions are the only thing guaranteed) and ASCII-only so the base64 data: URL is trivially
 * correct. The domain table is emitted as an object literal used as a set.
 */
export function buildProxyPac(opts: ProxyPacOptions): string {
  const direct = new Set<string>();
  for (const d of [...CN_DIRECT_DOMAINS, ...(opts.extraDirectDomains ?? [])]) {
    const n = normaliseDomain(d);
    if (n) direct.add(n);
  }
  const tlds = new Set<string>(CN_DIRECT_TLDS.map(normaliseDomain));
  // No `; DIRECT` tail unless asked: a proxy that is down must produce an error, not a dirty IP.
  const proxy =
    `SOCKS5 ${opts.socksHost}:${opts.socksPort}` + (opts.fallbackDirect ? "; DIRECT" : "");
  const table = (s: Set<string>) =>
    "{" +
    [...s]
      .sort()
      .map((k) => `${JSON.stringify(k)}:1`)
      .join(",") +
    "}";
  const v4 = PRIVATE_V4_RANGES.map(([n, m]) => `isInNet(host, "${n}", "${m}")`).join(" || ");

  return (
    `// i-bot split routing: CN direct, rest via WARP (SOCKS5)` +
    // ASCII only: this string ends up in a base64 data: URL, and proxyPacDataUrl refuses non-ASCII.
    `${opts.fallbackDirect ? " with DIRECT fallback" : ", NO direct fallback (fail closed)"}.\n` +
    `var DIRECT_TLDS = ${table(tlds)};\n` +
    `var DIRECT_DOMAINS = ${table(direct)};\n` +
    `var PROXY = ${JSON.stringify(proxy)};\n` +
    `function FindProxyForURL(url, host) {\n` +
    `  host = host.toLowerCase();\n` +
    // IPv6 literal first: it has no dots, so isPlainHostName would otherwise claim it as a LAN name.
    `  if (host.indexOf(":") !== -1) return host === "::1" || host === "[::1]" ? "DIRECT" : PROXY;\n` +
    `  if (isPlainHostName(host) || host === "localhost" || dnsDomainIs(host, ".localhost")) return "DIRECT";\n` +
    // IPv4 literal: private ranges direct, public IPs proxied. isInNet only runs on literals so it
    // never triggers a DNS lookup here (on a hostname it would resolve locally — leaking the name).
    `  if (/^\\d{1,3}(\\.\\d{1,3}){3}$/.test(host)) {\n` +
    `    if (${v4}) return "DIRECT";\n` +
    `    return PROXY;\n` +
    `  }\n` +
    `  var labels = host.split(".");\n` +
    `  if (DIRECT_TLDS[labels[labels.length - 1]] === 1) return "DIRECT";\n` +
    // suffix walk: a.b.example.com → a.b.example.com, b.example.com, example.com, com
    `  for (var i = 0; i < labels.length; i++) {\n` +
    `    if (DIRECT_DOMAINS[labels.slice(i).join(".")] === 1) return "DIRECT";\n` +
    `  }\n` +
    `  return PROXY;\n` +
    `}\n`
  );
}

/**
 * The PAC as a `data:` URL for `--proxy-pac-url`. Chrome refuses `file://` here, and a loopback
 * HTTP server would be one more process to babysit; a data: URL is read once at startup and can't
 * be unreachable. Kept well under the ~128 KiB argv limit (the full list is ~7 KiB encoded).
 */
export function proxyPacDataUrl(pac: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(pac)) throw new Error("PAC must be ASCII-only for a data: URL");
  return `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pac, "ascii").toString("base64")}`;
}
