import net from "node:net";
import tls from "node:tls";

const DEFAULT_ENDPOINT = "https://ipinfo.io/json";
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_BODY = 64 * 1024;

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function bareHost(url) {
  const host = url.hostname;
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function resolveEndpoint(value) {
  const raw = value || process.env.MAGPIE_CLEAN_LOGIN_IP_ENDPOINT || DEFAULT_ENDPOINT;
  let url;
  try {
    url = raw instanceof URL ? new URL(raw.href) : new URL(String(raw));
  } catch {
    throw failure("invalid_endpoint", "The test endpoint is invalid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw failure("invalid_endpoint", "The test endpoint must use http or https.");
  }
  url.hash = "";
  return url;
}

function resolveTimeout(value, env) {
  const fromOptions = Number(value);
  if (Number.isFinite(fromOptions) && fromOptions > 0) {
    return Math.min(15_000, Math.max(50, Math.round(fromOptions)));
  }
  const fromEnv = Number((env || process.env).MAGPIE_CLEAN_LOGIN_PROXY_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.min(15_000, Math.max(1_000, Math.round(fromEnv)));
  }
  return DEFAULT_TIMEOUT_MS;
}

function proxyAuthorization(proxy) {
  if (!proxy.username && !proxy.password) return "";
  return `Basic ${Buffer.from(`${proxy.username || ""}:${proxy.password || ""}`).toString("base64")}`;
}

function track(socket, sockets) {
  sockets.add(socket);
  // Keep an error listener attached for the whole lifetime. The reader and
  // handshake promises also observe errors; this one only prevents an
  // unhandled error between two stages of the connection.
  socket.on("error", () => {});
  socket.once("close", () => sockets.delete(socket));
  return socket;
}

function connectTcp(host, port, sockets) {
  return new Promise((resolve, reject) => {
    const socket = track(net.connect({ host, port }), sockets);
    const onError = (error) => {
      socket.off("connect", onConnect);
      reject(error);
    };
    const onConnect = () => {
      socket.off("error", onError);
      resolve(socket);
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}

function upgradeTls(socket, host, sockets, options) {
  return new Promise((resolve, reject) => {
    const secure = track(
      tls.connect({
        socket,
        servername: net.isIP(host) ? undefined : host,
        rejectUnauthorized: options.tlsRejectUnauthorized !== false,
      }),
      sockets,
    );
    const onError = (error) => {
      secure.off("secureConnect", onSecure);
      reject(error);
    };
    const onSecure = () => {
      secure.off("error", onError);
      resolve(secure);
    };
    secure.once("error", onError);
    secure.once("secureConnect", onSecure);
  });
}

class BufferedReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.ended = false;
    this.failure = null;
    this.waiters = [];
    this.onData = (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.wake();
    };
    this.onEnd = () => {
      this.ended = true;
      this.wake();
    };
    this.onError = (error) => {
      this.failure = error;
      this.wake();
    };
    socket.on("data", this.onData);
    socket.on("end", this.onEnd);
    socket.on("close", this.onEnd);
    socket.on("error", this.onError);
  }

  wake() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  wait() {
    if (this.ended || this.failure) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async read(count) {
    while (this.buffer.length < count) {
      if (this.failure) throw this.failure;
      if (this.ended) throw failure("closed", "The connection closed before the proxy replied.");
      await this.wait();
    }
    const out = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return out;
  }

  async readUntil(marker) {
    const needle = Buffer.from(marker);
    while (true) {
      const index = this.buffer.indexOf(needle);
      if (index >= 0) {
        const out = this.buffer.subarray(0, index + needle.length);
        this.buffer = this.buffer.subarray(index + needle.length);
        return out;
      }
      if (this.failure) throw this.failure;
      if (this.ended) throw failure("closed", "The connection closed before the proxy replied.");
      await this.wait();
    }
  }

  async readToEnd() {
    while (!this.ended) {
      if (this.failure) throw this.failure;
      await this.wait();
    }
    if (this.failure) throw this.failure;
    if (this.buffer.length > MAX_BODY) throw failure("endpoint_json", "The test endpoint reply was too large.");
    const out = this.buffer;
    this.buffer = Buffer.alloc(0);
    return out;
  }

  detach() {
    this.socket.off("data", this.onData);
    this.socket.off("end", this.onEnd);
    this.socket.off("close", this.onEnd);
    this.socket.off("error", this.onError);
    const rest = this.buffer;
    this.buffer = Buffer.alloc(0);
    return rest;
  }
}

function parseStatusLine(line) {
  const match = /^HTTP\/1\.[01] (\d{3})/.exec(line);
  if (!match) throw failure("invalid_response", "The proxy returned an invalid HTTP response.");
  return Number(match[1]);
}

async function readChunked(reader) {
  const chunks = [];
  let total = 0;
  while (true) {
    const line = (await reader.readUntil("\r\n")).toString("latin1").replace(/\r\n$/, "");
    const size = Number.parseInt(line.split(";")[0], 16);
    if (!Number.isFinite(size) || size < 0) {
      throw failure("invalid_response", "The test endpoint returned an invalid reply.");
    }
    if (size === 0) {
      while (true) {
        const trailer = (await reader.readUntil("\r\n")).toString("latin1");
        if (trailer === "\r\n") break;
      }
      break;
    }
    if (total + size > MAX_BODY) throw failure("endpoint_json", "The test endpoint reply was too large.");
    chunks.push(await reader.read(size));
    await reader.read(2);
    total += size;
  }
  return Buffer.concat(chunks);
}

async function readHttpResponse(reader) {
  const head = (await reader.readUntil("\r\n\r\n")).toString("latin1");
  const lines = head.split("\r\n");
  const status = parseStatusLine(lines[0] || "");
  const headers = {};
  for (const line of lines.slice(1)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  if (status === 407) throw failure("proxy_auth", "Proxy authentication failed.");
  if (status < 200 || status >= 300) {
    throw failure(`http_${status}`, `The test endpoint returned HTTP ${status}.`);
  }
  const encoding = String(headers["transfer-encoding"] || "").toLowerCase();
  if (encoding.includes("chunked")) return readChunked(reader);
  if (headers["content-length"] !== undefined) {
    const length = Number.parseInt(headers["content-length"], 10);
    if (!Number.isFinite(length) || length < 0 || length > MAX_BODY) {
      throw failure("endpoint_json", "The test endpoint reply was too large.");
    }
    return reader.read(length);
  }
  return reader.readToEnd();
}

async function requestOverStream(stream, endpoint, { absolute = false, proxyAuth = "" } = {}) {
  const path = absolute
    ? `${endpoint.origin}${endpoint.pathname || "/"}${endpoint.search}`
    : `${endpoint.pathname || "/"}${endpoint.search}`;
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: ${endpoint.host}`,
    "Accept: application/json",
    "User-Agent: magpie-clean-login",
    "Connection: close",
  ];
  if (proxyAuth) lines.push(`Proxy-Authorization: ${proxyAuth}`);
  try {
    stream.write(`${lines.join("\r\n")}\r\n\r\n`);
  } catch (error) {
    throw failure("closed", "The connection closed before the proxy replied.");
  }
  return readHttpResponse(new BufferedReader(stream));
}

async function connectTunnel(endpoint, proxy, sockets, options) {
  const socket = await connectTcp(proxy.host, proxy.port, sockets);
  const port = endpoint.port || (endpoint.protocol === "https:" ? "443" : "80");
  const authority = `${endpoint.hostname}:${port}`;
  const auth = proxyAuthorization(proxy);
  const lines = [
    `CONNECT ${authority} HTTP/1.1`,
    `Host: ${authority}`,
  ];
  if (auth) lines.push(`Proxy-Authorization: ${auth}`);
  try {
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  } catch {
    throw failure("closed", "The connection closed before the proxy replied.");
  }
  const reader = new BufferedReader(socket);
  const head = (await reader.readUntil("\r\n\r\n")).toString("latin1");
  const status = parseStatusLine(head.split("\r\n")[0] || "");
  const rest = reader.detach();
  if (rest.length) socket.unshift(rest);
  if (status === 407) throw failure("proxy_auth", "Proxy authentication failed.");
  if (status !== 200) throw failure("proxy_tunnel", "The proxy refused the tunnel.");
  return upgradeTls(socket, bareHost(endpoint), sockets, options);
}

async function viaHttpProxy(endpoint, proxy, sockets, options) {
  if (endpoint.protocol === "http:") {
    const socket = await connectTcp(proxy.host, proxy.port, sockets);
    const body = await requestOverStream(socket, endpoint, {
      absolute: true,
      proxyAuth: proxyAuthorization(proxy),
    });
    return parseExit(body);
  }
  const tunnel = await connectTunnel(endpoint, proxy, sockets, options);
  const body = await requestOverStream(tunnel, endpoint);
  return parseExit(body);
}

function ipv6Groups(input) {
  let address = input;
  const zone = address.indexOf("%");
  if (zone >= 0) address = address.slice(0, zone);
  const expand = (parts) => {
    const out = [];
    for (const part of parts) {
      if (part.includes(".")) {
        const v4 = part.split(".").map(Number);
        out.push(((v4[0] << 8) | v4[1]).toString(16), ((v4[2] << 8) | v4[3]).toString(16));
      } else {
        out.push(part);
      }
    }
    return out;
  };
  if (address.includes("::")) {
    const [left, right] = address.split("::");
    const leftParts = expand(left ? left.split(":") : []);
    const rightParts = expand(right ? right.split(":") : []);
    const missing = 8 - leftParts.length - rightParts.length;
    if (missing < 0) throw failure("socks_address", "The proxy target address is invalid.");
    return [...leftParts, ...Array(missing).fill("0"), ...rightParts];
  }
  return expand(address.split(":"));
}

function ipv6Bytes(address) {
  const groups = ipv6Groups(address);
  if (groups.length !== 8) throw failure("socks_address", "The proxy target address is invalid.");
  const bytes = [];
  for (const group of groups) {
    const value = Number.parseInt(group || "0", 16);
    if (!Number.isFinite(value) || value < 0 || value > 0xffff) {
      throw failure("socks_address", "The proxy target address is invalid.");
    }
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return Buffer.from(bytes);
}

function socksReplyError(code) {
  if (code === 0x02) return failure("socks_auth", "SOCKS5 authentication failed.");
  if (code === 0x03) return failure("socks_general", "The SOCKS5 proxy could not connect.");
  if (code === 0x04) return failure("socks_host", "The SOCKS5 proxy could not reach the test endpoint.");
  if (code === 0x05) return failure("socks_refused", "The SOCKS5 proxy refused the connection.");
  if (code === 0x06) return failure("socks_general", "The SOCKS5 proxy could not connect.");
  if (code === 0x07) return failure("socks_general", "The SOCKS5 proxy does not support this request.");
  if (code === 0x08) return failure("socks_address", "The SOCKS5 proxy does not support this address type.");
  return failure("socks_general", "The SOCKS5 proxy could not connect.");
}

async function viaSocks5(endpoint, proxy, sockets, options) {
  const socket = await connectTcp(proxy.host, proxy.port, sockets);
  const reader = new BufferedReader(socket);
  const username = Buffer.from(proxy.username || "", "utf8");
  const password = Buffer.from(proxy.password || "", "utf8");
  if (username.length > 255 || password.length > 255) {
    throw failure("socks_auth", "SOCKS5 credentials are too long.");
  }
  const methods = username.length || password.length ? [0x00, 0x02] : [0x00];
  socket.write(Buffer.from([0x05, methods.length, ...methods]));
  const greeting = await reader.read(2);
  if (greeting[0] !== 0x05) throw failure("socks_version", "The SOCKS5 proxy returned an invalid reply.");
  const method = greeting[1];
  if (method === 0xff) {
    throw failure("socks_method", "The SOCKS5 proxy did not accept the offered authentication.");
  }
  if (method === 0x02) {
    socket.write(
      Buffer.concat([
        Buffer.from([0x01, username.length]),
        username,
        Buffer.from([password.length]),
        password,
      ]),
    );
    const auth = await reader.read(2);
    if (auth[0] !== 0x01 || auth[1] !== 0x00) {
      throw failure("socks_auth", "SOCKS5 authentication failed.");
    }
  } else if (method !== 0x00) {
    throw failure("socks_method", "The SOCKS5 proxy did not accept the offered authentication.");
  }

  const host = bareHost(endpoint);
  const port = Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80));
  const ipVersion = net.isIP(host);
  let address;
  if (ipVersion === 4) {
    address = Buffer.from([0x01, ...host.split(".").map(Number)]);
  } else if (ipVersion === 6) {
    address = Buffer.concat([Buffer.from([0x04]), ipv6Bytes(host)]);
  } else {
    const name = Buffer.from(host, "utf8");
    if (!name.length || name.length > 255) {
      throw failure("socks_address", "The proxy target address is invalid.");
    }
    address = Buffer.concat([Buffer.from([0x03, name.length]), name]);
  }
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), address, portBytes]));
  const reply = await reader.read(4);
  if (reply[0] !== 0x05) throw failure("socks_version", "The SOCKS5 proxy returned an invalid reply.");
  if (reply[1] !== 0x00) throw socksReplyError(reply[1]);
  const atyp = reply[3];
  if (atyp === 0x01) {
    await reader.read(4);
  } else if (atyp === 0x04) {
    await reader.read(16);
  } else if (atyp === 0x03) {
    const length = (await reader.read(1))[0];
    await reader.read(length);
  } else {
    throw failure("socks_address", "The SOCKS5 proxy returned an invalid address.");
  }
  await reader.read(2);
  const rest = reader.detach();
  if (rest.length) socket.unshift(rest);
  let stream = socket;
  if (endpoint.protocol === "https:") {
    stream = await upgradeTls(socket, host, sockets, options);
  }
  const body = await requestOverStream(stream, endpoint);
  return parseExit(body);
}

function firstString(values, max) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      const text = value.trim();
      return text.length > max ? text.slice(0, max) : text;
    }
  }
  return "";
}

const COUNTRY_MAP = {
  HK: "中国/香港",
  MO: "中国/澳门",
  TW: "中国/台湾",
  CN: "中国",
  SG: "新加坡",
  JP: "日本",
  KR: "韩国",
  US: "美国",
  GB: "英国",
  UK: "英国",
  DE: "德国",
  FR: "法国",
  CA: "加拿大",
  AU: "澳大利亚",
  RU: "俄罗斯",
  MY: "马来西亚",
  TH: "泰国",
  VN: "越南",
  PH: "菲律宾",
  IN: "印度",
  NL: "荷兰",
};

const SUBREGION_MAP = {
  // China provinces / municipalities
  Guangdong: "广东",
  Zhejiang: "浙江",
  Jiangsu: "江苏",
  Shanghai: "上海",
  Beijing: "北京",
  Sichuan: "四川",
  Shandong: "山东",
  Fujian: "福建",
  Hubei: "湖北",
  Hunan: "湖南",
  Henan: "河南",
  Hebei: "河北",
  Shaanxi: "陕西",
  Chongqing: "重庆",
  Tianjin: "天津",
  // US states
  California: "加利福尼亚",
  Texas: "得克萨斯",
  "New York": "纽约",
  Washington: "华盛顿",
  Virginia: "弗吉尼亚",
  Illinois: "伊利诺伊",
  Florida: "佛罗里达",
  // JP prefectures
  Tokyo: "东京",
  Osaka: "大阪",
  Kanagawa: "神奈川",
  Aichi: "爱知",
  // KR cities
  Seoul: "首尔",
  Incheon: "仁川",
  Busan: "釜山",
  // UK
  England: "英格兰",
  London: "伦敦",
  Scotland: "苏格兰",
  // DE
  Hesse: "黑森",
  Bavaria: "巴伐利亚",
  Berlin: "柏林",
  Frankfurt: "法兰克福",
};

export function formatExitRegion({ country, region, city } = {}) {
  const c = String(country || "").trim().toUpperCase();
  const rawR = String(region || "").trim();
  const rawCi = String(city || "").trim();

  // Greater China special administrative regions and Taiwan
  const lowerR = rawR.toLowerCase();
  const lowerCi = rawCi.toLowerCase();
  if (c === "HK" || lowerR === "hong kong" || lowerCi === "hong kong" || c === "HONG KONG") {
    return "中国/香港";
  }
  if (c === "MO" || lowerR === "macau" || lowerR === "macao" || lowerCi === "macau" || lowerCi === "macao") {
    return "中国/澳门";
  }
  if (c === "TW" || lowerR === "taiwan" || lowerCi === "taiwan") {
    return "中国/台湾";
  }

  // City-state: Singapore
  if (c === "SG" || lowerR === "singapore" || lowerCi === "singapore") {
    return "新加坡";
  }

  // Country resolution
  let countryName = COUNTRY_MAP[c];
  if (!countryName && c.length === 2) {
    try {
      const dn = new Intl.DisplayNames(["zh-CN"], { type: "region" });
      countryName = dn.of(c);
    } catch {}
  }
  if (!countryName) countryName = country || "";

  // Subregion resolution
  let sub = SUBREGION_MAP[rawR] || rawR;
  if (!sub || (sub.toLowerCase() === countryName.toLowerCase() || sub.toLowerCase() === c.toLowerCase())) {
    sub = SUBREGION_MAP[rawCi] || rawCi;
  }

  if (countryName && sub && sub.toLowerCase() !== countryName.toLowerCase() && sub.toLowerCase() !== c.toLowerCase()) {
    return `${countryName}/${sub}`;
  }
  return countryName || sub || "";
}

function parseExit(body) {
  let data;
  try {
    data = JSON.parse(body.toString("utf8"));
  } catch {
    throw failure("endpoint_json", "The test endpoint did not return JSON.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw failure("endpoint_json", "The test endpoint did not return JSON.");
  }
  const exitIp = firstString(
    [data.ip, data.query, data.ip_addr, data.ipAddress, data.address, data.IPv4],
    80,
  );
  const country = firstString(
    [data.country, data.countryCode, data.country_code, data.country_name, data.location?.country],
    80,
  );
  const regionRaw = firstString(
    [data.region_name, data.regionName, data.region, data.location?.region],
    80,
  );
  const city = firstString([data.city, data.location?.city], 80);

  let region = formatExitRegion({ country, region: regionRaw, city });
  if (!region) {
    region = firstString([regionRaw, country, city], 120);
  }
  if (region.length > 120) region = region.slice(0, 120);

  if (!exitIp) {
    throw failure("endpoint_json", "The test endpoint did not return an exit IP.");
  }
  return { exitIp, region };
}

function describeError(error) {
  const code = String(error?.code || "");
  if (code === "timeout" || code === "ETIMEDOUT") {
    return { code: "timeout", message: "Connection timed out." };
  }
  if (code === "ECONNREFUSED") {
    return { code: "refused", message: "The proxy refused the connection." };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return { code: "dns", message: "The proxy host could not be resolved." };
  }
  if (code === "ECONNRESET" || code === "EPIPE" || code === "closed") {
    return { code: "reset", message: "The proxy closed the connection." };
  }
  if (code === "proxy_auth" || code === "http_407") {
    return { code: "proxy_auth", message: "Proxy authentication failed." };
  }
  if (code === "proxy_tunnel") {
    return { code: "proxy_tunnel", message: "The proxy refused the tunnel." };
  }
  if (code.startsWith("http_")) {
    return {
      code: "endpoint_http",
      message: `The test endpoint returned HTTP ${code.slice(5)}.`,
    };
  }
  if (code === "endpoint_json" || code === "invalid_response") {
    return { code: "endpoint_json", message: "The test endpoint did not return usable JSON." };
  }
  if (code === "invalid_endpoint") {
    return { code: "invalid_endpoint", message: "The test endpoint is invalid." };
  }
  if (code === "socks_auth" || code === "socks_method") {
    return { code: "socks_auth", message: "SOCKS5 authentication failed." };
  }
  if (code === "socks_refused") {
    return { code: "socks_refused", message: "The SOCKS5 proxy refused the connection." };
  }
  if (code === "socks_host") {
    return { code: "socks_host", message: "The SOCKS5 proxy could not reach the test endpoint." };
  }
  if (code === "socks_general" || code === "socks_version" || code === "socks_address") {
    return { code: "socks_general", message: "The SOCKS5 proxy could not connect." };
  }
  if (/CERT|TLS|SSL/i.test(String(error?.message || "")) || code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return { code: "tls", message: "Secure connection to the test endpoint failed." };
  }
  return { code: "unknown", message: "Could not reach the test endpoint through this proxy." };
}

export function proxyTestEndpoint(env = process.env) {
  return resolveEndpoint(env.MAGPIE_CLEAN_LOGIN_IP_ENDPOINT);
}

export async function testProxy(proxy, options = {}) {
  const started = Date.now();
  const sockets = new Set();
  const env = options.env || process.env;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = failure("timeout", "Connection timed out.");
      for (const socket of sockets) socket.destroy(error);
      reject(error);
    }, resolveTimeout(options.timeoutMs, env));
  });
  try {
    const endpoint = resolveEndpoint(options.endpoint || env.MAGPIE_CLEAN_LOGIN_IP_ENDPOINT);
    const result = proxy.type === "socks5"
      ? await Promise.race([viaSocks5(endpoint, proxy, sockets, options), deadline])
      : await Promise.race([viaHttpProxy(endpoint, proxy, sockets, options), deadline]);
    return {
      ok: true,
      exitIp: result.exitIp,
      region: result.region,
      latency: Math.max(0, Date.now() - started),
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    const safe = describeError(error);
    return {
      ok: false,
      error: safe.message,
      errorCode: safe.code,
      latency: null,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
  }
}
