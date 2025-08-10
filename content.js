// content.js

/*
    Module: Content Script

    Purpose
    Add a checkmark icon next to the channel-name text link on YouTube surfaces when subscribed.

    Approach
    Collect candidate anchors across light and shadow DOM, gate to channel-name links only, extract a robust channel
    reference, batch query the background for membership, and add one icon per passing anchor.

    Quota
    No direct network calls. All checks are batched through the background worker.

    Logging
    Structured logger with level control and periodic heartbeats.

    Formatting
    Four spaces indentation and block comments only.
*/

/*
    Section: Logger
*/
function makeLogger(prefix, level = "info", heartbeatMs = 2500) {
    const rank = { error: 0, warn: 1, info: 2, debug: 3 };
    const min = rank[level] ?? 2;
    const last = new Map();
    function emit(tag, args) {
        const r = rank[tag] ?? 3;
        if (r > min) return;
        const fn = console[tag] || console.log;
        fn(prefix, ...args);
    }
    function heartbeat(tag, argsFactory) {
        const now = Date.now();
        const prev = last.get(tag) || 0;
        if (now - prev >= heartbeatMs) {
            last.set(tag, now);
            try { emit("info", argsFactory()); } catch {}
        }
    }
    return {
        error: (...a) => emit("error", a),
        warn: (...a) => emit("warn", a),
        info: (...a) => emit("info", a),
        debug: (...a) => emit("debug", a),
        heartbeat
    };
}

const logger = makeLogger("[YTSM/CS]", "info", 3000);

/*
    Section: Timing and Queues
*/
const BULK_INTERVAL_MS = 800;
const MAX_IDS_PER_BULK = 200;

let observer = null;
let pollTimer = null;
let pendingRefs = new Set();
let lastBulkAt = 0;

/*
    Section: Selectors

    Purpose
    Broad patterns to scoop up channel-name anchors across YouTube surfaces. Gating is applied later.
*/
const SELECTOR_LIST = [
    'a[href^="/@"]',
    'a[href^="/channel/UC"]',
    'a[href^="/c/"]',
    'a[href^="/user/"]',
    'a[href^="https://www.youtube.com/@"]',
    'a[href^="https://www.youtube.com/channel/UC"]',
    'a[href^="https://www.youtube.com/c/"]',
    'a[href^="https://www.youtube.com/user/"]',
    "ytd-channel-name a",
    "#channel-name a",
    "ytd-video-owner-renderer #channel-name a",
    "ytd-video-owner-renderer ytd-channel-name a",
    "ytd-rich-grid-media #channel-info a",
    "ytd-rich-item-renderer ytd-channel-name a",
    "ytd-compact-video-renderer ytd-channel-name a",
    "ytd-grid-video-renderer ytd-channel-name a",
    "ytd-search ytd-channel-name a",
    "ytd-reel-player-overlay-renderer a[href*='/@']",
    "ytd-mini-channel-renderer a"
];

/*
    Section: Exclusions

    Purpose
    Containers and text to avoid to prevent false positives on subscribe UI and counts.
*/
const EXCLUDE_CONTAINERS = [
    "#owner-sub-count",
    "ytd-subscribe-button-renderer",
    "ytd-sentiment-bar-renderer",
    "ytd-video-owner-renderer #owner-sub-count"
];

const EXCLUDE_TEXT_REGEX = /\bsubscribe|subscribers?\b/i;

/*
    Section: Messaging

    Purpose
    Guarded bridge to background messaging to avoid context errors.

    Parameters
    message: any

    Returns
    Promise<any|null>
*/
function safeSendMessage(message) {
    return new Promise(resolve => {
        try {
            if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) {
                return resolve(null);
            }
            chrome.runtime.sendMessage(message, response => {
                const err = chrome.runtime.lastError;
                if (err) {
                    logger.warn("sendMessage error", err.message, message && message.type ? message.type : "");
                    return resolve(null);
                }
                resolve(response ?? null);
            });
        } catch (e) {
            logger.warn("sendMessage threw", e && e.message ? e.message : String(e));
            resolve(null);
        }
    });
}

/*
    Section: Shadow DOM Traversal

    Purpose
    Collect matching anchors across light DOM and open shadow roots.

    Parameters
    root: Node
    selectors: string[]

    Returns
    Element[]
*/
function queryAllDeep(root, selectors) {
    const results = [];
    const selector = selectors.join(",");
    const visited = new WeakSet();
    function scan(node) {
        try {
            const found = node.querySelectorAll(selector);
            for (const el of found) results.push(el);
        } catch {}
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT, null);
        let cur = walker.currentNode;
        while (cur) {
            const sr = cur.shadowRoot;
            if (sr && !visited.has(sr)) {
                visited.add(sr);
                scan(sr);
            }
            cur = walker.nextNode();
        }
    }
    scan(root);
    return results;
}

/*
    Section: Closest Across Shadows

    Purpose
    Element.closest replacement that climbs out of shadow roots through hosts.

    Parameters
    startEl: Element
    selector: string

    Returns
    Element | null
*/
function closestDeep(startEl, selector) {
    if (!startEl) return null;
    function matches(el, sel) {
        try { return el instanceof Element && el.matches(sel); } catch { return false; }
    }
    let el = startEl;
    while (el) {
        if (matches(el, selector)) return el;
        let parent = el.parentNode;
        if (!parent && el.getRootNode) {
            const rn = el.getRootNode();
            if (rn && rn instanceof ShadowRoot) parent = rn.host;
        }
        if (!parent && el instanceof ShadowRoot) parent = el.host;
        el = parent;
    }
    return null;
}

/*
    Section: Gates

    Purpose
    Validate anchors as channel-name links only.

    Parameters
    a: HTMLAnchorElement

    Returns
    boolean
*/
function isChannelHref(a) {
    const href = a.getAttribute("href") || "";
    if (href.startsWith("/@") || href.startsWith("/channel/UC") || href.startsWith("/c/") || href.startsWith("/user/")) return true;
    if (/^https:\/\/(www\.|m\.)?youtube\.com\//.test(href)) return true;
    return false;
}

function isChannelNameAnchor(a) {
    if (!isChannelHref(a)) return false;
    try {
        if (a.querySelector("img, yt-img-shadow")) return false;
    } catch {}
    for (const sel of EXCLUDE_CONTAINERS) {
        if (closestDeep(a, sel)) return false;
    }
    const txt = (a.textContent || "").trim();
    if (EXCLUDE_TEXT_REGEX.test(txt)) return false;
    const inOwner = !!closestDeep(a, "ytd-video-owner-renderer");
    if (inOwner && !closestDeep(a, "ytd-video-owner-renderer #channel-name")) return false;
    return true;
}

/*
    Section: Reference Extraction

    Purpose
    Extract a robust reference token to send to background. Handles UC ids, @handles, /c names, /user names, and full URLs.

    Parameters
    a: HTMLAnchorElement

    Returns
    string | null
*/
function extractRef(a) {
    try {
        const raw = (a.getAttribute("href") || "").trim();
        if (!raw) return null;
        const mUC = raw.match(/\/channel\/(UC[0-9A-Za-z_-]{22})/);
        if (mUC) return mUC[1];
        const mAt = raw.match(/\/@([^/?#]+)/);
        if (mAt) return "@" + decodeURIComponent(mAt[1].toLowerCase());
        if (raw.startsWith("/c/") || raw.startsWith("/user/")) return raw;
        if (/^https?:\/\//i.test(raw)) {
            try {
                const u = new URL(raw);
                if (u.hostname.endsWith("youtube.com")) {
                    if (/^\/channel\/(UC[0-9A-Za-z_-]{22})/.test(u.pathname)) return u.pathname.split("/")[2];
                    if (/^\/@/.test(u.pathname)) return "@" + u.pathname.split("/")[1].slice(1).toLowerCase();
                    if (/^\/c\//.test(u.pathname) || /^\/user\//.test(u.pathname)) return u.pathname;
                }
            } catch {}
            return raw;
        }
        try {
            const abs = new URL(raw, location.href).toString();
            return abs;
        } catch {
            return raw;
        }
    } catch {
        return null;
    }
}

/*
    Section: Marker

    Purpose
    Append one small icon to the anchor to indicate subscription.

    Parameters
    a: HTMLAnchorElement

    Returns
    void
*/
function addMarker(a) {
    if (a.querySelector(".subscription-marker")) return;
    const img = document.createElement("img");
    try {
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) {
            img.src = chrome.runtime.getURL("icon.png");
        } else {
            return;
        }
    } catch { return; }
    img.className = "subscription-marker";
    img.style.marginLeft = "5px";
    img.style.width = "16px";
    img.style.height = "16px";
    img.alt = "subscribed";
    img.title = "You are subscribed";
    a.appendChild(img);
}

/*
    Section: Scanner

    Purpose
    Traverse DOM and queue references for anchors that pass gates and lack a marker.

    Parameters
    none

    Returns
    void
*/
function queueRefsFromDom() {
    const anchors = queryAllDeep(document, SELECTOR_LIST);
    let seen = 0;
    let eligible = 0;
    let extracted = 0;
    let added = 0;
    for (const a of anchors) {
        seen += 1;
        if (!isChannelNameAnchor(a)) continue;
        eligible += 1;
        if (a.querySelector(".subscription-marker")) continue;
        const ref = extractRef(a);
        if (!ref) continue;
        extracted += 1;
        pendingRefs.add(ref);
        added += 1;
    }
    logger.heartbeat("scan", () => ["scan", "anchors", seen, "eligible", eligible, "extracted", extracted, "queued", added, "pending", pendingRefs.size]);
    if (pendingRefs.size && Date.now() - lastBulkAt >= BULK_INTERVAL_MS) {
        void flushBulk();
    }
}

/*
    Section: Batch Apply

    Purpose
    Send a batch to background, then mark passing anchors.

    Parameters
    none

    Returns
    Promise<void>
*/
async function flushBulk() {
    if (!pendingRefs.size) return;
    const now = Date.now();
    if (now - lastBulkAt < BULK_INTERVAL_MS) return;
    lastBulkAt = now;
    const ids = [];
    for (const id of pendingRefs) {
        ids.push(id);
        if (ids.length >= MAX_IDS_PER_BULK) break;
    }
    for (const id of ids) pendingRefs.delete(id);
    logger.info("bulk request", ids.length);
    let response = null;
    try {
        response = await safeSendMessage({ type: "bulkCheckChannels", ids });
    } catch {
        response = null;
    }
    if (!response || !response.results) {
        logger.warn("bulk response missing; requeueing", ids.length);
        for (const id of ids) pendingRefs.add(id);
        return;
    }
    const results = response.results;
    const anchors = queryAllDeep(document, SELECTOR_LIST);
    let marked = 0;
    for (const a of anchors) {
        if (!isChannelNameAnchor(a)) continue;
        if (a.querySelector(".subscription-marker")) continue;
        const ref = extractRef(a);
        if (!ref) continue;
        if (results[ref] === true) {
            addMarker(a);
            marked += 1;
        }
    }
    if (marked > 0) logger.info("markers added", marked);
    if (pendingRefs.size) {
        setTimeout(flushBulk, BULK_INTERVAL_MS);
    }
}

/*
    Section: Debug Bridge

    Purpose
    Allow page-world scripts and the DevTools console to request a one-off resolve test without direct access to chrome.runtime.

    Invocation
    window.postMessage({ type: "YTSM_DEBUG_RESOLVE", ref: "/@handle" })

    Response
    Posts back a message with type "YTSM_DEBUG_RESULT" carrying { ref, norm, resolvedUc, inIndex, final }
*/
window.addEventListener("message", evt => {
    try {
        const data = evt && evt.data;
        if (!data) return;
        if (data.type === "YTSM_DEBUG_RESOLVE") {
            const ref = String(data.ref || "");
            safeSendMessage({ type: "debugResolve", ref })
                .then(result => { try { window.postMessage({ type: "YTSM_DEBUG_RESULT", payload: result }, "*"); } catch {} })
                .catch(err => { try { window.postMessage({ type: "YTSM_DEBUG_RESULT", error: err && err.message ? err.message : String(err) }, "*"); } catch {} });
        }
    } catch {}
});

/*
    Section: Debug Identity Bridge

    Purpose
    Request the current authenticated YouTube channel identity and echo it back to the page console.

    Invocation
    window.postMessage({ type: "YTSM_WHOAMI" })

    Response
    YTSM_WHOAMI_RESULT with { ok, identity }
*/
window.addEventListener("message", evt => {
    try {
        const data = evt && evt.data;
        if (!data) return;
        if (data.type === "YTSM_WHOAMI") {
            safeSendMessage({ type: "whoami" })
                .then(result => { try { window.postMessage({ type: "YTSM_WHOAMI_RESULT", payload: result }, "*"); } catch {} })
                .catch(err => { try { window.postMessage({ type: "YTSM_WHOAMI_RESULT", error: err && err.message ? err.message : String(err) }, "*"); } catch {} });
        }
    } catch {}
});

/*
    Section: Debug Account Control

    Purpose
    Allow logging out and reauth from the page console.

    Invocations
    window.postMessage({ type: "YTSM_LOGOUT" })
    window.postMessage({ type: "YTSM_REAUTH" })

    Responses
    YTSM_LOGOUT_RESULT with { ok }
    YTSM_REAUTH_RESULT with { ok, total }
*/
window.addEventListener("message", evt => {
    try {
        const data = evt && evt.data;
        if (!data) return;
        if (data.type === "YTSM_LOGOUT") {
            safeSendMessage({ type: "logout" })
                .then(result => { try { window.postMessage({ type: "YTSM_LOGOUT_RESULT", payload: result }, "*"); } catch {} })
                .catch(err => { try { window.postMessage({ type: "YTSM_LOGOUT_RESULT", error: err && err.message ? err.message : String(err) }, "*"); } catch {} });
        }
        if (data.type === "YTSM_REAUTH") {
            safeSendMessage({ type: "reauth" })
                .then(result => { try { window.postMessage({ type: "YTSM_REAUTH_RESULT", payload: result }, "*"); } catch {} })
                .catch(err => { try { window.postMessage({ type: "YTSM_REAUTH_RESULT", error: err && err.message ? err.message : String(err) }, "*"); } catch {} });
        }
    } catch {}
});

/*
    Section: Debug Invalidate Bridge

    Purpose
    Allow page-world to invalidate a cached handle/url mapping in the background so the next check re-resolves.

    Invocation
    window.postMessage({ type: "YTSM_INVALIDATE", ref: "@handle" })

    Response
    YTSM_INVALIDATE_RESULT with { ok }
*/
window.addEventListener("message", evt => {
    try {
        const d = evt && evt.data;
        if (!d || d.type !== "YTSM_INVALIDATE") return;
        const ref = String(d.ref || "");
        const key = ref.startsWith("@") || ref.startsWith("/") ? ref : "@" + ref;
        safeSendMessage({ type: "invalidateHandle", handle: key })
            .then(r => { try { window.postMessage({ type: "YTSM_INVALIDATE_RESULT", payload: r }, "*"); } catch {} })
            .catch(e => { try { window.postMessage({ type: "YTSM_INVALIDATE_RESULT", error: e && e.message ? e.message : String(e) }, "*"); } catch {} });
    } catch {}
});

/*
    Section: Hotkey

    Purpose
    Provide a quick way to test a reference without using the console.

    Hotkey
    Alt + Shift + Y
*/
document.addEventListener("keydown", e => {
    try {
        if (e.altKey && e.shiftKey && e.key && e.key.toLowerCase() === "y") {
            const ref = prompt("YTSM debugResolve: enter channel ref (@handle, /channel/UC..., /c/..., /user/..., or URL):", "/@dttodot");
            if (!ref) return;
            safeSendMessage({ type: "debugResolve", ref })
                .then(result => { try { window.postMessage({ type: "YTSM_DEBUG_RESULT", payload: result }, "*"); } catch {} })
                .catch(err => { try { window.postMessage({ type: "YTSM_DEBUG_RESULT", error: err && err.message ? err.message : String(err) }, "*"); } catch {} });
        }
    } catch {}
});

/*
    Section: Lifecycle

    Purpose
    Start DOM observation and periodic scans. Stop on pagehide and when tab is hidden.
*/
function start() {
    stop();
    observer = new MutationObserver(() => {
        queueMicrotask(queueRefsFromDom);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    pollTimer = setInterval(queueRefsFromDom, 1500);
    queueRefsFromDom();
    lastBulkAt = 0;
    setTimeout(() => void flushBulk(), 100);
    void safeSendMessage({ type: "refreshSubscriptions" });
}

function stop() {
    if (observer) { observer.disconnect(); observer = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    pendingRefs.clear();
}

window.addEventListener("pagehide", stop, { capture: true });
window.addEventListener("beforeunload", stop, { capture: true });
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
        stop();
    } else {
        setTimeout(start, 150);
    }
});

start();
