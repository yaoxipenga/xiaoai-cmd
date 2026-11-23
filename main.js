"use strict";

/* 小爱文字指令 · Songloft JS 插件后端
 *
 * 设计原则：与官方「远程呼唤 / 语音助手」插件一致，打开即用、零配置。
 *
 * 【凭据复用】零配置，与「远程呼唤」一样打开即用。
 *   主通道：宿主跨插件路由 GET /api/v1/jsplugin/miot/accounts 拿到已登录账号的
 *   passToken（官方接口只对 service_token / ssecurity 脱敏，passToken 完整返回），
 *   再用官方 MinaAuth 同构的 serviceLogin 流程向 account.xiaomi.com 换取
 *   micoapi / xiaomiio 的 serviceToken，缓存 30 分钟，过期自动重换。
 *   兼容通道：command.exec 读取 ../miot/data/accounts；共享 storage；手动导入。
 *   凭据只留在本机内存 / 本插件存储，不会发往任何第三方，只用于小米云 API。
 *
 * 【执行通道，按可靠性排序】
 *   1. MIoT 5-4 execute-text-directive  —— 官方 spec，等同对小爱说出这句话，
 *      支持静默执行（不语音回应）。需要 xiaomiio serviceToken + ssecurity + miotDID。
 *   2. 云端 mibrain / ai_service        —— /remote/ubus 把文本当一次语音指令。
 *      需要 micoapi serviceToken。
 *   3. 宿主 /mina/*                    —— 前置停止播放 / 降音量 / 播报，零凭据可用。
 */

var CFG_KEY = "xtc_config_v1";
var LOG_KEY = "xtc_logs_v1";
var UBUS_URL = "https://api2.mina.mi.com/remote/ubus";
var MIIO_URL = "https://api.io.mi.com/app/miotspec/action";
var UA = "Android-7.1.1-1.0.0-ONEPLUS A3010-136-XTCAPP01 APP/xiaomi.smarthome APPV/62830";
var MIIO_UA = "MICO/AndroidApp/@SHIP.TO.2A2FE0D7@/2.4.40";
var HOST_API = "/api/v1/jsplugin/miot";
var PASSPORT_DEVICE_ID = "XTCAPP01DEVICE01";

// ---------- 基础工具 ----------

function json(data, code) {
  return {
    statusCode: code || 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(data)
  };
}

function readText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  try {
    return new TextDecoder().decode(v);
  } catch (e) {
    try {
      return String.fromCharCode.apply(null, Array.from(v));
    } catch (e2) {
      return "";
    }
  }
}

function parseBody(req) {
  var s = readText(req.body);
  if (!s) return {};
  try { return JSON.parse(s); } catch (e) { return {}; }
}

function randId(n) {
  var chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  var s = "";
  for (var i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function randHex(n) {
  var chars = "0123456789abcdef";
  var s = "";
  for (var i = 0; i < n * 2; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
}

function nowStr() {
  var d = new Date();
  function p(x) { return x < 10 ? "0" + x : String(x); }
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

async function storageGet(key) {
  try { return await songloft.storage.get(key); } catch (e) { return null; }
}

async function storageSet(key, value) {
  try { await songloft.storage.set(key, value); } catch (e) {
    songloft.log.warn("[文字指令] 存储写入失败: " + String(e));
  }
}

function asObject(v) {
  if (!v) return null;
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch (e) { return null; }
  }
  if (typeof v === "object") return v;
  return null;
}

async function getConfig() {
  return asObject(await storageGet(CFG_KEY)) || {};
}

function mask(s) {
  if (!s) return "";
  s = String(s);
  if (s.length <= 8) return "****";
  return s.slice(0, 4) + "****" + s.slice(-4);
}

/** 递归扫描任意账号结构，收集 service_token / ssecurity / user_id */
function scanCreds(node, depth, parentUid, found) {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) {
    for (var i = 0; i < node.length; i++) scanCreds(node[i], depth + 1, parentUid, found);
    return;
  }
  if (typeof node !== "object") return;
  var uid = parentUid || node.user_id || node.userId || node.cUserId || node.id || node.account || "";
  var st = node.service_token || node.serviceToken;
  if (typeof st === "string" && st.length > 20) {
    found.push({
      user_id: String(uid || ""),
      service_token: st,
      ssecurity: String(node.ssecurity || ""),
      sid: String(node.sid || node.service_id || "")
    });
  }
  for (var k in node) {
    var v = node[k];
    if (v && typeof v === "object") scanCreds(v, depth + 1, uid, found);
  }
}

// ---------- 凭据：自动复用「智能音箱」插件已登录账号 ----------

/** 通过宿主 command.exec 读取 miot 插件落盘的 accounts 文件（无需用户操作） */
async function readMiotAccounts() {
  var cmds = [
    { program: "cmd", args: ["/c", "type \"..\\miot\\data\\accounts\" 2>nul"] },
    { program: "sh", args: ["-c", "cat ../miot/data/accounts 2>/dev/null"] },
    { program: "powershell", args: ["-NoProfile", "-Command", "Get-Content -Raw -LiteralPath '../miot/data/accounts' -ErrorAction SilentlyContinue"] },
    { program: "cmd", args: ["/c", "type \"..\\miot\\accounts\" 2>nul"] },
    { program: "sh", args: ["-c", "cat ../miot/accounts 2>/dev/null"] }
  ];
  for (var i = 0; i < cmds.length; i++) {
    try {
      if (!songloft.command || typeof songloft.command.exec !== "function") break;
      var r = await songloft.command.exec(cmds[i].program, cmds[i].args, { timeout: 6000 });
      var o = asObject(r) || r;
      var out = o && o.stdout ? String(o.stdout) : (typeof r === "string" ? r : "");
      if (!out) continue;
      var parsed = asObject(out.trim());
      if (parsed) return parsed;
    } catch (e) { /* 换下一种 shell */ }
  }
  return null;
}

/** 备用：宿主跨插件文件路由（部分宿主版本 / 权限配置下可用） */
async function readMiotAccountsViaHostFile() {
  try {
    var host = await songloft.plugin.getHostUrl();
    var token = await songloft.plugin.getToken();
    var resp = await fetch(host + "/api/v1/jsplugin/miot/files/data/accounts", {
      headers: { "Authorization": "Bearer " + token }
    });
    if (resp.status < 200 || resp.status >= 300) return null;
    var t = resp.text();
    if (t && typeof t.then === "function") t = await t;
    return asObject(String(t || "").trim());
  } catch (e) {
    return null;
  }
}

/** 把 miot 的 accounts 数组整理成本插件可用的凭据集 */
function normalizeAccounts(raw) {
  if (!raw) return [];
  var list = [];
  if (Array.isArray(raw)) list = raw;
  else if (Array.isArray(raw.data)) list = raw.data;
  else if (Array.isArray(raw.accounts)) list = raw.accounts;
  else list = [raw];

  var out = [];
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    if (!a || typeof a !== "object") continue;
    var uid = String(a.user_id || a.userId || a.id || "").trim();
    var services = a.services || a.token_info && a.token_info.services || {};
    var mico = services.micoapi || {};
    var io = services.xiaomiio || {};
    var micoToken = String(mico.service_token || mico.serviceToken || a.service_token || "").trim();
    var ioToken = String(io.service_token || io.serviceToken || "").trim();
    var ssecurity = String(io.ssecurity || "").trim();

    if (!micoToken && !ioToken) {
      var hits = [];
      scanCreds(a, 0, "", hits);
      if (hits.length > 0) {
        micoToken = hits[0].service_token;
        ssecurity = ssecurity || hits[0].ssecurity;
      }
    }
    if (!micoToken && !ioToken) continue;
    out.push({
      account_id: String(a.id || a.account || uid || ""),
      user_id: uid,
      micoapi_token: micoToken,
      xiaomiio_token: ioToken || micoToken,
      ssecurity: ssecurity,
      device_id: String(a.device_id || a.deviceId || PASSPORT_DEVICE_ID)
    });
  }
  return out;
}

var TOKEN_CACHE_KEY = "xtc_token_cache_v1";
var TOKEN_TTL_MS = 30 * 60 * 1000;

/** 宿主「智能音箱」插件的 /accounts 接口：passToken 未脱敏，可直接拿来换 serviceToken */
async function readHostAccounts() {
  try {
    var r = await hostRequest("GET", "/accounts", null);
    if (!r.ok || !r.data) return [];
    var list = r.data.data || r.data.accounts || r.data;
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function headerSetCookies(headers) {
  if (!headers) return [];
  try {
    if (typeof headers.getSetCookie === "function") {
      var a = headers.getSetCookie();
      if (a && a.length) return a;
    }
  } catch (e) {}
  try {
    var v = typeof headers.get === "function" ? headers.get("Set-Cookie") : "";
    if (v) return [v];
  } catch (e) {}
  return [];
}

function cookieValue(headers, name) {
  var list = headerSetCookies(headers);
  for (var i = 0; i < list.length; i++) {
    var parts = String(list[i]).split(";");
    for (var j = 0; j < parts.length; j++) {
      var p = parts[j].trim();
      var k = p.indexOf("=");
      if (k > 0 && p.slice(0, k).trim() === name) return p.slice(k + 1).trim();
    }
  }
  return "";
}

async function fetchRaw(url, headers) {
  var resp = await fetch(url, { method: "GET", headers: headers });
  var t = resp.text();
  if (t && typeof t.then === "function") t = await t;
  return { status: resp.status, headers: resp.headers, text: String(t || "") };
}

/**
 * passToken → serviceToken，与官方 MinaAuth.exchangeServiceToken 同构（已实机验证）：
 *   GET /pass/serviceLogin?sid=<sid>&_json=true  （Cookie 带 passToken / userId / deviceId）
 *   → location、ssecurity、nonce
 *   clientSign = base64(sha1("nonce=<nonce>&<ssecurity>"))
 *   GET location + _userIdNeedEncrypt=true + clientSign
 *   → 响应 Set-Cookie 里的 serviceToken
 */
async function exchangeServiceToken(passToken, userId, sid) {
  var dev = randId(16);
  var ua = "Android-7.1.1-1.0.0-ONEPLUS A3010-136-" + dev + " APP/xiaomi.smarthome APPV/62830";
  var cookie = "passToken=" + passToken + ";userId=" + userId + ";deviceId=" + dev + ";sdkVersion=3.8.6";
  var common = { "User-Agent": ua, "Cookie": cookie, "X-Fetch-No-Redirect": "1" };

  var r1 = await fetchRaw("https://account.xiaomi.com/pass/serviceLogin?sid=" + sid + "&_json=true", common);
  var raw = r1.text.replace(/&&&START&&&/g, "").trim();
  var d = asObject(raw);
  if (!d || String(d.code || "0") !== "0" || !d.location) return null;

  var ssec = String(d.ssecurity || "");
  var nm = raw.match(/"nonce"\s*:\s*(\d+)/);
  var nonce = nm ? nm[1] : String(d.nonce || "");
  var sign;
  try { sign = hexToB64(sha1Hex("nonce=" + nonce + "&" + ssec)); } catch (e) { return null; }

  var loc = String(d.location);
  var url = loc + (loc.indexOf("?") >= 0 ? "&" : "?") +
    "_userIdNeedEncrypt=true&clientSign=" + encodeURIComponent(sign);
  var r2 = await fetchRaw(url, common);
  var st = cookieValue(r2.headers, "serviceToken");
  if (!st) return null;
  return { service_token: st, ssecurity: ssec || cookieValue(r2.headers, "ssecurity") };
}

/** 自动发现：宿主 API + passToken 换取为主通道，带 30 分钟缓存 */
async function autoDiscover() {
  try {
    var list = await readHostAccounts();
    if (list.length > 0) {
      var cache = asObject(await storageGet(TOKEN_CACHE_KEY)) || {};
      var out = [];
      var changed = false;
      for (var i = 0; i < list.length; i++) {
        var a = list[i] || {};
        var uid = String(a.user_id || a.userId || a.id || "").trim();
        var pt = String(a.pass_token || a.passToken || "").trim();
        if (!uid || !pt) continue;

        var ck = cache[uid];
        var fresh = ck && ck.ts && (Date.now() - Number(ck.ts) < TOKEN_TTL_MS) && ck.mico;
        if (!fresh) {
          var mico = null, io = null;
          try { mico = await exchangeServiceToken(pt, uid, "micoapi"); } catch (e) {}
          try { io = await exchangeServiceToken(pt, uid, "xiaomiio"); } catch (e) {}
          if (mico && mico.service_token) {
            ck = {
              ts: Date.now(),
              mico: mico.service_token,
              io: (io && io.service_token) || mico.service_token,
              ssec: (io && io.ssecurity) || mico.ssecurity || ""
            };
            cache[uid] = ck;
            changed = true;
          }
        }
        if (ck && ck.mico) {
          out.push({
            account_id: String(a.id || a.account || uid || ""),
            user_id: uid,
            micoapi_token: ck.mico,
            xiaomiio_token: ck.io || ck.mico,
            ssecurity: ck.ssec || "",
            device_id: PASSPORT_DEVICE_ID
          });
        }
      }
      if (changed) await storageSet(TOKEN_CACHE_KEY, JSON.stringify(cache));
      if (out.length > 0) return out;
    }
  } catch (e) {}

  // 兼容旧宿主：读取 miot 落盘的 accounts 文件（command 权限可用时）
  try {
    var raw = await readMiotAccounts();
    if (!raw) raw = await readMiotAccountsViaHostFile();
    var accounts = normalizeAccounts(raw);
    if (accounts.length > 0) return accounts;
  } catch (e) {}

  // 兜底：老版本宿主把账号放在共享 storage（通常为空，保留兼容）
  try {
    var keys = await songloft.storage.keys();
    if (Array.isArray(keys)) {
      for (var k = 0; k < keys.length; k++) {
        var key = String(keys[k] || "");
        if (key.indexOf("xtc_") === 0) continue;
        if (!/account|token|mina|mico/i.test(key)) continue;
        var acc = normalizeAccounts(asObject(await storageGet(key)));
        if (acc.length > 0) return acc;
      }
    }
  } catch (e) {}
  return [];
}

/**
 * 解析最终凭据：优先复用宿主已登录账号，手动配置作为后备。
 * 返回 { source, accounts, primary, cookie, micoCookie }
 */
async function resolveAuth() {
  var cfg = await getConfig();
  var auto = await autoDiscover();
  var primary = null;
  var source = "none";

  if (auto.length > 0) {
    primary = auto[0];
    source = "auto";
  } else if (cfg.user_id && cfg.service_token) {
    primary = {
      account_id: cfg.default_account_id || "",
      user_id: cfg.user_id,
      micoapi_token: cfg.service_token,
      xiaomiio_token: cfg.xiaomiio_token || cfg.service_token,
      ssecurity: cfg.ssecurity || "",
      device_id: cfg.device_id || PASSPORT_DEVICE_ID
    };
    source = "manual";
  } else if (cfg.cookie && String(cfg.cookie).trim()) {
    var mt = String(cfg.cookie).match(/serviceToken\s*=\s*([^;\s]+)/i);
    var mu = String(cfg.cookie).match(/userId\s*=\s*([^;\s]+)/i);
    if (mt) {
      primary = {
        account_id: "", user_id: mu ? mu[1] : "",
        micoapi_token: mt[1], xiaomiio_token: mt[1], ssecurity: "",
        device_id: PASSPORT_DEVICE_ID
      };
      source = "cookie";
    }
  }

  var micoCookie = "";
  if (primary) {
    var parts = [];
    if (primary.user_id) parts.push("userId=" + primary.user_id);
    parts.push("serviceToken=" + primary.micoapi_token);
    parts.push("channel=MI_APP_STORE");
    // 自动复用的凭据始终用最新 serviceToken 组装，避免被旧的手工 Cookie 覆盖
    micoCookie = (source === "manual" || source === "cookie")
      ? (String(cfg.cookie || "").trim() || parts.join("; "))
      : parts.join("; ");
  }

  return {
    source: source,
    accounts: auto,
    primary: primary,
    micoCookie: micoCookie,
    has_credentials: !!primary,
    can_miot: !!(primary && primary.xiaomiio_token && primary.ssecurity),
    can_ubus: !!(primary && primary.micoapi_token)
  };
}

// ---------- 宿主「智能音箱」插件 API（零配置通道） ----------

async function hostRequest(method, path, payload) {
  var host = "";
  var token = "";
  try { host = await songloft.plugin.getHostUrl(); } catch (e) {}
  try { token = await songloft.plugin.getToken(); } catch (e) {}
  var headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = "Bearer " + token;
  var opt = { method: method, headers: headers };
  if (payload) opt.body = JSON.stringify(payload);
  var resp = await fetch(host + HOST_API + path, opt);
  var t = resp.text();
  if (t && typeof t.then === "function") t = await t;
  var data = null;
  try { data = JSON.parse(t); } catch (e) {}
  return {
    ok: resp.status >= 200 && resp.status < 300 && (!data || data.success !== false),
    status: resp.status, data: data, raw: String(t || "").slice(0, 300)
  };
}

/** 设备列表：与另外两个插件完全相同的来源，打开即可看到所有音箱 */
async function fetchDevices() {
  var r = await hostRequest("GET", "/mina/devices", null);
  var groups = (r.data && r.data.data) || [];
  var out = [];
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i] || {};
    var devs = g.devices || [];
    for (var j = 0; j < devs.length; j++) {
      var d = devs[j] || {};
      out.push({
        account_id: String(g.account_id || ""),
        account_name: String(g.account_name || ""),
        device_id: String(d.deviceID || d.device_id || d.deviceId || d.did || ""),
        name: String(d.name || d.alias || d.device_name || d.deviceID || "未命名音箱"),
        hardware: String(d.hardware || d.model || ""),
        miot_did: String(d.miotDID || d.miot_did || d.miotDid || d.did || ""),
        presence: String(d.presence || d.status || ""),
        managed: d.managed !== false
      });
    }
  }
  return { success: r.ok, devices: out, raw: r.ok ? "" : r.raw, status: r.status };
}

// ---------- 小米云 UBUS（备用通道） ----------

async function ubus(deviceId, method, path, message, cookie, timeoutMs) {
  var form = [
    "deviceId=" + encodeURIComponent(deviceId),
    "method=" + encodeURIComponent(method),
    "path=" + encodeURIComponent(path),
    "message=" + encodeURIComponent(JSON.stringify(message)),
    "requestId=" + encodeURIComponent("app_ios_" + randId(30))
  ].join("&");
  var resp = await fetch(UBUS_URL, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": cookie,
      "X-Fetch-Timeout-Ms": String(timeoutMs || 8000)
    },
    body: form
  });
  var t = resp.text();
  if (t && typeof t.then === "function") t = await t;
  var data = null;
  try { data = JSON.parse(t); } catch (e) {}
  return {
    status: resp.status,
    code: data ? data.code : null,
    message: data ? (data.message || "") : "",
    raw: String(t || "").slice(0, 400)
  };
}

function ubusOk(r) {
  return r && r.status >= 200 && r.status < 300 && (r.code === 0 || r.code === "0");
}

// ---------- MIoT 5-4 execute-text-directive（主通道） ----------
// 签名算法与官方「智能音箱」插件 MiIOClient 一致，使用宿主注入的 crypto 原语。

function hasMiotCrypto() {
  return typeof globalThis.__go_buffer_from === "function" &&
    typeof globalThis.__go_buffer_to_string === "function" &&
    typeof globalThis.__go_crypto_sha256_bytes === "function" &&
    typeof globalThis.__go_crypto_sha1 === "function" &&
    typeof globalThis.__go_crypto_rc4 === "function";
}

function b64ToHex(v) { return globalThis.__go_buffer_from(v, "base64"); }
function hexToB64(v) { return globalThis.__go_buffer_to_string(v, "base64"); }
function utf8ToHex(v) { return globalThis.__go_buffer_from(v, "utf8"); }
function hexToUtf8(v) { return globalThis.__go_buffer_to_string(v, "utf8"); }
function sha256Hex(hex) { return globalThis.__go_crypto_sha256_bytes(hex); }
function sha1Hex(s) { return globalThis.__go_crypto_sha1(s); }
function rc4Hex(keyHex, dataHex) { return globalThis.__go_crypto_rc4(keyHex, dataHex); }

function signNonce(ssecurity, nonce) {
  return hexToB64(sha256Hex(b64ToHex(ssecurity) + b64ToHex(nonce)));
}

function rc4Hash(method, uri, data, snonce) {
  var parts = [];
  if (method) parts.push(method.toUpperCase());
  if (uri) parts.push(uri);
  for (var k in data) parts.push(k + "=" + data[k]);
  parts.push(snonce);
  return hexToB64(sha1Hex(parts.join("&")));
}

function rc4Drop1024(keyHex, dataHex) {
  var drop = "";
  for (var i = 0; i < 1024; i++) drop += "00";
  return rc4Hex(keyHex, drop + dataHex).slice(drop.length);
}

function encodeForm(params) {
  var parts = [];
  for (var k in params) parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
  return parts.join("&");
}

/** 调用 MIoT action；aiid=4 即 execute-text-directive */
async function miotExec(auth, miotDid, text, silent) {
  if (!hasMiotCrypto()) return { ok: false, detail: "宿主未提供 MIoT 加密原语，跳过该通道" };
  if (!miotDid) return { ok: false, detail: "该设备没有 miotDID，无法走 MIoT 通道" };

  var svc = auth.primary;
  var uri = "/miotspec/action";
  var dataObj = {
    params: { did: miotDid, siid: 5, aiid: 4, "in": [text, silent ? 0 : 1] }
  };
  var nonce = hexToB64(randHex(12));
  var snonce = signNonce(svc.ssecurity, nonce);
  var plain = { data: JSON.stringify(dataObj) };
  plain.rc4_hash__ = rc4Hash("POST", uri, plain, snonce);

  var dataHex = utf8ToHex(plain.data);
  var hashHex = utf8ToHex(plain.rc4_hash__);
  var encHex = rc4Drop1024(b64ToHex(snonce), dataHex + hashHex);
  var enc = {
    data: hexToB64(encHex.slice(0, dataHex.length)),
    rc4_hash__: hexToB64(encHex.slice(dataHex.length))
  };
  enc.signature = rc4Hash("POST", uri, { data: enc.data, rc4_hash__: enc.rc4_hash__ }, snonce);
  // 服务端需要用 _nonce + ssecurity 派生 snonce 来验签，二者必须随表单一起提交
  // （与官方「智能音箱」插件 MiIOClient.encodeMiIOT 保持一致）。
  enc._nonce = nonce;
  enc.ssecurity = svc.ssecurity;

  var cookie = [
    "countryCode=CN", "locale=zh_CN", "timezone=GMT+08:00", "timezone_id=Asia/Shanghai",
    "userId=" + svc.user_id,
    "PassportDeviceId=" + svc.device_id,
    "serviceToken=" + svc.xiaomiio_token,
    "yetAnotherServiceToken=" + svc.xiaomiio_token
  ].join("; ");

  var resp = await fetch(MIIO_URL, {
    method: "POST",
    headers: {
      "User-Agent": MIIO_UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "x-xiaomi-protocal-flag-cli": "PROTOCAL-HTTP2",
      "miot-encrypt-algorithm": "ENCRYPT-RC4",
      "Cookie": cookie,
      "X-Fetch-Timeout-Ms": "8000"
    },
    body: encodeForm(enc)
  });
  var t = resp.text();
  if (t && typeof t.then === "function") t = await t;
  var body = String(t || "");

  var code = null;
  var decoded = "";
  try {
    var keyHex = b64ToHex(signNonce(svc.ssecurity, nonce));
    decoded = hexToUtf8(rc4Drop1024(keyHex, b64ToHex(body.trim())));
    var parsed = JSON.parse(decoded);
    code = parsed && parsed.code !== undefined ? parsed.code : null;
  } catch (e) {
    // 响应可能被 gzip 压缩；HTTP 200 仍视为云端已受理
    decoded = body.slice(0, 200);
  }

  var ok = resp.status >= 200 && resp.status < 300 && (code === null || code === 0 || code === "0");
  var assumed = code === null ? "（响应未解析出返回码，按 HTTP 200 视为已受理，请观察音箱是否执行）" : "";
  return {
    ok: ok,
    detail: "HTTP " + resp.status + " / code=" + String(code) + assumed + (ok ? "" : " / " + decoded.slice(0, 160))
  };
}

// ---------- 日志 ----------

async function appendLog(entry) {
  var logs = asObject(await storageGet(LOG_KEY));
  if (!Array.isArray(logs)) logs = [];
  logs.push(entry);
  if (logs.length > 120) logs = logs.slice(logs.length - 120);
  await storageSet(LOG_KEY, logs);
  try { songloft.log.info("[文字指令] " + JSON.stringify(entry)); } catch (e) {}
}

// ---------- 业务：下发文字指令 ----------

async function runCommand(req) {
  var b = parseBody(req);
  var text = String(b.text || "").trim();
  var deviceId = String(b.device_id || "").trim();
  var accountId = String(b.account_id || "").trim();
  var miotDid = String(b.miot_did || "").trim();
  var silent = !!b.silent;
  var preAction = String(b.pre_action || "none");
  var sayOnly = !!b.say_only;

  if (!text) return json({ success: false, error: "指令内容不能为空", steps: [] }, 400);
  if (!deviceId) return json({ success: false, error: "请先在页面选择一台音箱", steps: [] }, 400);

  var steps = [];
  var stamp = nowStr();

  // 1) 前置动作：音乐太吵时先停播 / 降音量（宿主通道，零配置）
  if (preAction === "stop" || preAction === "quiet") {
    var path = preAction === "stop" ? "/mina/stop" : "/mina/volume";
    var payload = preAction === "stop"
      ? { account_id: accountId, device_id: deviceId }
      : { account_id: accountId, device_id: deviceId, volume: Number(b.quiet_volume || 10) };
    try {
      var hr = await hostRequest("POST", path, payload);
      steps.push({
        channel: preAction === "stop" ? "宿主 / 停止播放" : "宿主 / 调低音量",
        ok: hr.ok, detail: hr.ok ? "已下发" : ("HTTP " + hr.status + " " + hr.raw)
      });
    } catch (e) {
      steps.push({ channel: "宿主前置动作", ok: false, detail: String(e) });
    }
  }

  // 2) 仅播报（不执行指令），零配置可用
  if (sayOnly) {
    try {
      var sr = await hostRequest("POST", "/mina/tts", { account_id: accountId, device_id: deviceId, text: text });
      steps.push({ channel: "宿主 / TTS 播报", ok: sr.ok, detail: "HTTP " + sr.status + "（仅朗读，不执行指令）" });
      await appendLog({ time: stamp, text: text, ok: sr.ok, channel: "host:/mina/tts", steps: steps });
      return json({ success: sr.ok, channel: "host:/mina/tts", steps: steps, note: "已朗读，仅播报，不会执行指令" });
    } catch (e) {
      return json({ success: false, error: String(e), steps: steps });
    }
  }

  // 3) 复用宿主「智能音箱」插件已登录的账号
  var auth = await resolveAuth();
  steps.push({
    channel: "登录态复用",
    ok: auth.has_credentials,
    detail: auth.has_credentials
      ? (auth.source === "auto"
          ? "已自动复用「智能音箱」插件的已登录账号（" + auth.accounts.length + " 组），无需再次登录"
          : "使用手动导入的凭据（来源 " + auth.source + "）")
      : "未能读取到「智能音箱」插件的登录态，请展开下方高级设置导入一次"
  });

  if (!auth.has_credentials) {
    await appendLog({ time: stamp, text: text, ok: false, channel: "none", steps: steps });
    return json({ success: false, error: "未找到已登录的小米账号凭据", need_import: true, steps: steps });
  }

  var success = false;
  var usedChannel = "none";
  var lastDetail = "";

  // 4) 主通道：MIoT 5-4 execute-text-directive（官方文本指令动作）
  if (auth.can_miot) {
    try {
      var mr = await miotExec(auth, miotDid, text, silent);
      steps.push({ channel: "MIoT 5-4 执行文本指令", ok: mr.ok, detail: mr.detail });
      lastDetail = mr.detail;
      if (mr.ok) { success = true; usedChannel = "miot:5-4"; }
    } catch (e) {
      steps.push({ channel: "MIoT 5-4 执行文本指令", ok: false, detail: "异常：" + String(e) });
    }
  } else {
    steps.push({
      channel: "MIoT 5-4 执行文本指令",
      ok: false,
      detail: !miotDid ? "设备缺少 miotDID，跳过" : "账号缺少 xiaomiio ssecurity，跳过"
    });
  }

  // 5) 备用通道：云端 mibrain / ai_service
  if (!success && auth.can_ubus) {
    var variants = [
      { label: "云端文字指令 mibrain/ai_service", message: { tts: silent ? 0 : 1, nlp: 1, nlp_text: text } },
      { label: "云端文字指令（精简参数）", message: { nlp: 1, nlp_text: text } }
    ];
    for (var i = 0; i < variants.length; i++) {
      try {
        var r = await ubus(deviceId, "ai_service", "mibrain", variants[i].message, auth.micoCookie, 8000);
        var ok = ubusOk(r);
        var detail = "HTTP " + r.status + " / code=" + String(r.code) +
          (r.message ? " / " + r.message : "") + (ok ? "" : " / " + r.raw);
        steps.push({ channel: variants[i].label, ok: ok, detail: detail });
        lastDetail = detail;
        if (ok) { success = true; usedChannel = "mibrain/ai_service"; break; }
        if (r.status === 401) {
          steps.push({ channel: "提示", ok: false, detail: "serviceToken 已失效，请在「智能音箱」插件里重新登录一次，本插件会自动同步" });
          break;
        }
      } catch (e) {
        steps.push({ channel: variants[i].label, ok: false, detail: "网络异常：" + String(e) });
        lastDetail = String(e);
      }
    }
  }

  if (!success) {
    steps.push({
      channel: "诊断建议",
      ok: false,
      detail: "两条云端指令通道都未受理。可先用「执行前停止播放」+「仅播报」过渡；日志里逐条列出了 HTTP 状态与云端返回码。"
    });
  }

  var result = {
    success: success, text: text, device_id: deviceId, channel: usedChannel,
    steps: steps, detail: lastDetail,
    note: success
      ? "云端已受理，音箱会像听到这句话一样处理（无需喊唤醒词）。"
      : "未能执行，请查看逐通道日志。"
  };
  await appendLog({ time: stamp, text: text, ok: success, channel: usedChannel, steps: steps });
  return json(result);
}

// ---------- 路由 ----------

var ROUTES = [];
function route(method, path, fn) { ROUTES.push({ method: method, path: path, fn: fn }); }

route("GET", "/health", async function () {
  var auth = await resolveAuth();
  var cfg = await getConfig();
  return json({
    ok: true,
    plugin: "小爱文字指令",
    has_credentials: auth.has_credentials,
    credential_source: auth.source,
    reused: auth.source === "auto",
    auto_accounts: auth.accounts.length,
    channels: { miot_5_4: auth.can_miot, cloud_nlp: auth.can_ubus, host_tts: true },
    has_manual: !!(cfg.user_id && cfg.service_token),
    time: nowStr()
  });
});

route("GET", "/config", async function () {
  var cfg = await getConfig();
  var auth = await resolveAuth();
  return json({
    config: {
      user_id: cfg.user_id || "",
      service_token: mask(cfg.service_token),
      cookie: mask(cfg.cookie),
      ssecurity: mask(cfg.ssecurity)
    },
    has_credentials: auth.has_credentials,
    credential_source: auth.source,
    auto_accounts: auth.accounts.map(function (a) {
      return { account_id: a.account_id, user_id: a.user_id, micoapi_token: mask(a.micoapi_token), xiaomiio_token: mask(a.xiaomiio_token) };
    })
  });
});

route("POST", "/config", async function (req) {
  var b = parseBody(req);
  var cfg = await getConfig();
  if (b.clear) {
    cfg.user_id = ""; cfg.service_token = ""; cfg.cookie = "";
    cfg.ssecurity = ""; cfg.xiaomiio_token = "";
  }
  if (String(b.user_id || "").trim()) cfg.user_id = String(b.user_id).trim();
  if (String(b.service_token || "").trim()) cfg.service_token = String(b.service_token).trim();
  if (String(b.ssecurity || "").trim()) cfg.ssecurity = String(b.ssecurity).trim();
  if (String(b.xiaomiio_token || "").trim()) cfg.xiaomiio_token = String(b.xiaomiio_token).trim();
  if (String(b.cookie || "").trim()) cfg.cookie = String(b.cookie).trim();
  if (String(b.default_account_id || "").trim()) cfg.default_account_id = String(b.default_account_id);
  if (String(b.default_device_id || "").trim()) cfg.default_device_id = String(b.default_device_id);

  var imported = false;
  var rawImport = String(b.import_json || "").trim();
  if (rawImport) {
    var obj = asObject(rawImport);
    var hits = [];
    if (obj) scanCreds(obj, 0, "", hits);
    if (hits.length > 0) {
      if (hits[0].user_id) cfg.user_id = hits[0].user_id;
      cfg.service_token = hits[0].service_token;
      if (hits[0].ssecurity) cfg.ssecurity = hits[0].ssecurity;
      imported = true;
    } else {
      var mu = rawImport.match(/userId\s*[=:]\s*["']?([^;,\s"']+)/i);
      var mt = rawImport.match(/serviceToken\s*[=:]\s*["']?([^;,\s"']+)/i);
      if (mt) {
        if (mu) cfg.user_id = mu[1];
        cfg.service_token = mt[1];
        imported = true;
      }
    }
  }

  await storageSet(CFG_KEY, cfg);
  await appendLog({ time: nowStr(), text: imported ? "(手动导入账号凭据)" : "(更新凭据配置)", ok: true, channel: "config", steps: [] });
  var auth = await resolveAuth();
  return json({
    success: true, imported: imported,
    has_credentials: auth.has_credentials,
    credential_source: auth.source,
    error: rawImport && !imported ? "未能识别出 serviceToken，请确认粘贴内容完整" : ""
  });
});

/** 手动触发一次重新读取宿主登录态 */
route("POST", "/redetect", async function () {
  var auth = await resolveAuth();
  return json({
    found: auth.accounts.length,
    reused: auth.source === "auto",
    has_credentials: auth.has_credentials,
    note: auth.source === "auto"
      ? "已复用「智能音箱」插件当前登录的小米账号，无需再次登录。"
      : "未能自动读取到宿主登录态，可展开高级设置手动导入一次。"
  });
});

route("GET", "/devices", async function () {
  try {
    return json(await fetchDevices());
  } catch (e) {
    return json({ success: false, error: String(e), devices: [] });
  }
});

route("POST", "/command", runCommand);

/** 凭据自检：查询播放状态，不产生任何动作 */
route("POST", "/test", async function (req) {
  var b = parseBody(req);
  var deviceId = String(b.device_id || "").trim();
  var auth = await resolveAuth();
  if (!deviceId) return json({ success: false, error: "请先选择音箱" }, 400);
  if (!auth.can_ubus) return json({ success: false, error: "尚未取得小米云凭据" }, 400);
  try {
    var r = await ubus(deviceId, "player_get_play_status", "mediaplayer", { media: "app_ios" }, auth.micoCookie, 8000);
    return json({
      success: ubusOk(r), status: r.status, code: r.code, raw: r.raw,
      note: ubusOk(r) ? "凭据有效，可以下发文字指令。" : (r.status === 401 ? "凭据已失效，请在「智能音箱」插件里重新登录后自动同步。" : "云端未受理，请检查 deviceId 与账号是否匹配。")
    });
  } catch (e) {
    return json({ success: false, error: String(e) });
  }
});

route("GET", "/logs", async function () {
  var logs = asObject(await storageGet(LOG_KEY));
  if (!Array.isArray(logs)) logs = [];
  return json({ logs: logs.slice(-40) });
});

route("POST", "/logs/clear", async function () {
  await storageSet(LOG_KEY, []);
  return json({ success: true });
});

// ---------- 生命周期 ----------

async function onInit() {
  songloft.log.info("[文字指令] 插件已启动：自动复用「智能音箱」登录态 + MIoT 5-4 / 云端 NLP / 宿主控制三通道");
  try {
    var a = await autoDiscover();
    songloft.log.info("[文字指令] 自动复用宿主已登录账号 " + a.length + " 组");
  } catch (e) {
    songloft.log.warn("[文字指令] 自动读取登录态失败（不影响宿主通道）: " + String(e));
  }
}

async function onDeinit() {
  songloft.log.info("[文字指令] 插件已停止");
}

async function onHTTPRequest(req) {
  var p = String(req.path || "/").split("?")[0];
  for (var i = 0; i < ROUTES.length; i++) {
    var r = ROUTES[i];
    if (r.method === req.method && r.path === p) {
      try {
        return await r.fn(req, p);
      } catch (e) {
        songloft.log.error("[文字指令] " + p + " 处理异常: " + String(e));
        return json({ success: false, error: String(e) }, 500);
      }
    }
  }
  return json({ error: "not found", path: p }, 404);
}

globalThis.onInit = onInit;
globalThis.onDeinit = onDeinit;
globalThis.onHTTPRequest = onHTTPRequest;
