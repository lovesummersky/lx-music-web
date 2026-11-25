/**
 * 洛雪音源脚本隔离 Worker（经典 Worker，无 DOM、无 localStorage、无 Cookie）。
 *
 * 洛雪脚本运行时期望宿主注入 `globalThis.lx`：
 *   const { EVENT_NAMES, request, on, send, utils, env, version } = globalThis.lx;
 * 脚本只上报 `musicUrl` 动作，收到请求后返回一个可播地址字符串。
 * 本 Worker 只提供这套最小 shim，并把脚本的网络请求全部经由同源
 * `/proxy-fetch` 转发（避免 CORS，也避免脚本直接拿到页面凭证）。
 * 直接 fetch 被替换为抛错函数：脚本只能走 shim 请求，不能绕过代理；
 * shim 内部转发用的原生 fetch 在文件顶部已捕获，不受此替换影响。
 *
 * 安全边界（必须在界面上如实说明）：Worker 隔离的是 DOM/凭证，不是代码
 * 本身——脚本仍可在 Worker 内执行任意计算并通过它自己的上游请求发包。
 * 只添加信任来源的脚本。
 */
"use strict";

/* 在替换全局 fetch 之前先捕获原生 fetch：doProxyRequest 必须用它走
 * /proxy-fetch，脚本自己调 fetch 时才走下面的抛错 stub。之前这里直接
 * 在 doProxyRequest 里调 fetch()，结果调到的是 stub，全部上游请求都
 * 以 "direct fetch is disabled" 失败，这是本次修复的 bug。 */
const nativeFetch = typeof fetch === "function" ? fetch.bind(globalThis) : null;

let requestHandler = null;
let initedConfig = null;

const EVENT_NAMES = { request: "lx:request", inited: "lx:inited" };

function postMessageToMain(type, payload) {
    self.postMessage(Object.assign({ type }, payload || {}));
}

/* ---- utils.buffer：脚本里只用到 from + bufToString（base64 编码 token） ---- */
function bufferFrom(input, encoding) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (Array.isArray(input)) return Uint8Array.from(input);
    if (typeof input === "string") {
        if ((encoding || "utf-8").toLowerCase() === "base64") {
            const binary = atob(input.replace(/\s/g, ""));
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return bytes;
        }
        return new TextEncoder().encode(input);
    }
    return new TextEncoder().encode(String(input == null ? "" : input));
}

function bufferToString(buf, encoding) {
    const bytes = buf instanceof Uint8Array ? buf : bufferFrom(buf);
    const enc = String(encoding || "utf-8").toLowerCase();
    if (enc === "base64") {
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }
    if (enc === "hex") {
        return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    }
    return new TextDecoder("utf-8").decode(bytes);
}

/* ---- lx.request：Node 回调风格 (err, res)，res.body 保持字符串 ---- */
async function doProxyRequest(url, options) {
    if (!nativeFetch) {
        throw new Error("Worker 内没有可用的 fetch，无法转发请求");
    }
    const opts = options || {};
    const timeoutMs = Math.min(Math.max(Number(opts.timeout) || 8000, 1000), 30000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await nativeFetch("/proxy-fetch?url=" + encodeURIComponent(String(url)), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                url: String(url),
                method: opts.method || "GET",
                headers: opts.headers || {},
                body: opts.body != null ? opts.body : (opts.data != null ? opts.data : null),
                timeoutMs,
            }),
            signal: controller.signal,
        });
        const rawText = await response.text().catch(() => "");
        let envelope = null;
        try { envelope = JSON.parse(rawText); } catch (_) { /* 非 JSON 时按格式错误处理 */ }
        if (!envelope || typeof envelope.statusCode !== "number") {
            throw new Error("proxy-fetch 返回格式错误 (HTTP " + response.status + "): " + rawText.slice(0, 200));
        }
        return {
            statusCode: envelope.statusCode,
            headers: envelope.headers || {},
            body: typeof envelope.body === "string" ? envelope.body : "",
            url: envelope.url || String(url),
        };
    } finally {
        clearTimeout(timer);
    }
}

function lxRequest(url, options, callback) {
    if (typeof options === "function") {
        callback = options;
        options = {};
    }
    doProxyRequest(url, options || {})
        .then((res) => callback(null, res))
        .catch((err) => callback(err));
}

const lx = {
    EVENT_NAMES,
    version: "2.0.0",
    env: {},
    utils: { buffer: { from: bufferFrom, bufToString: bufferToString } },
    request: lxRequest,
    on(event, handler) {
        if (event === EVENT_NAMES.request && typeof handler === "function") {
            requestHandler = handler;
        }
    },
    send(event, payload) {
        if (event === EVENT_NAMES.inited) {
            initedConfig = payload || null;
            postMessageToMain("inited", { config: initedConfig });
        }
    },
};

self.lx = lx;
globalThis.lx = lx;
// 脚本内部用裸 `request(...)` 调用宿主请求，同样挂到全局。
globalThis.request = lxRequest;

try {
    // 禁止脚本绕过 /proxy-fetch 直接 fetch（Worker 内本无 XHR/DOM）。
    self.fetch = function () {
        return Promise.reject(new Error("direct fetch is disabled inside the lx worker; use lx.request"));
    };
} catch (_) { /* 忽略：某些环境下 fetch 不可写，shim 仍可用 */ }

self.onmessage = async function (event) {
    const data = event.data || {};
    if (data.type === "load") {
        try {
            // 间接 eval：在 Worker 全局作用域执行脚本；脚本顶层的 on/send
            // 调用在执行期间完成注册，setTimeout 回调持有 eval 作用域闭包。
            (0, eval)(String(data.code || ""));
            postMessageToMain("loaded", { hasHandler: Boolean(requestHandler), config: initedConfig });
        } catch (err) {
            postMessageToMain("load-error", { message: String((err && err.message) || err) });
        }
        return;
    }
    if (data.type === "ping") {
        postMessageToMain("pong", {});
        return;
    }
    if (data.type === "request") {
        if (!requestHandler) {
            postMessageToMain("request-error", { id: data.id, message: "音源脚本没有注册 musicUrl 处理函数" });
            return;
        }
        try {
            const result = await requestHandler({ action: data.action, source: data.source, info: data.info });
            const url = typeof result === "string" ? result : String(result == null ? "" : result);
            postMessageToMain("request-result", { id: data.id, result: url });
        } catch (err) {
            postMessageToMain("request-error", { id: data.id, message: String((err && err.message) || err) });
        }
    }
};
