// content.js

/*
    Module: Content Script

    Purpose
    Append a small "subscribed" icon next to the channel-name text link on YouTube surfaces
    when the logged-in user is subscribed.
*/

/*
    Code Block: Debug Flag

    Purpose
    Runtime control over verbosity and interactive debug features from chrome.storage.local.

    Inputs
    - storage key "ytsm_debug" (boolean)

    Outputs
    - DEBUG boolean
*/
const DEBUG_DEFAULT = false;
let DEBUG = DEBUG_DEFAULT;
try {
    chrome?.storage?.local?.get?.(["ytsm_debug"], s => {
        if (typeof s?.ytsm_debug === "boolean") DEBUG = s.ytsm_debug;
    });
} catch {}

/*
    Function: makeLogger

    Purpose
    Provide a structured logger with level control and throttled heartbeats for the content script.

    Inputs
    - prefix: string prefix for log lines
    - level: "error" | "warn" | "info" | "debug"
    - heartbeatMs: throttle window for heartbeat logs

    Outputs
    - An object with { error, warn, info, debug, heartbeat }
*/
function makeLogger(prefix, level = "info", heartbeatMs = 2500) {
    // Define rank thresholds and track last heartbeat per tag.
    const rank = { error: 0, warn: 1, info: 2, debug: 3 };
    const min = rank[level] ?? 2;
    const last = new Map();

    // Emit a log message if level passes threshold.
    function emit(tag, args) {
        const r = rank[tag] ?? 3;
        if (r > min) return;
        const fn = console[tag] || console.log;
        fn(prefix, ...args);
    }

    // Emit throttled heartbeat messages to avoid log spam.
    function heartbeat(tag, argsFactory) {
        const now = Date.now();
        const prev = last.get(tag) || 0;
        if (now - prev >= heartbeatMs) {
            last.set(tag, now);
            try { emit("info", argsFactory()); } catch {}
        }
    }

    // Return the structured logger API.
    return {
        error: (...a) => emit("error", a),
        warn: (...a) => emit("warn", a),
        info: (...a) => emit("info", a),
        debug: (...a) => emit("debug", a),
        heartbeat
    };
}

// Create a logger instance for the content script.
// In DEBUG: more verbose, faster heartbeat. Otherwise: warn-level, slower heartbeat.
const logger = makeLogger("[YTSM/CS]", DEBUG ? "info" : "warn", DEBUG ? 3000 : 30000);

// Bulk timing and queue sizing constants.
const BULK_INTERVAL_MS = 800;
const MAX_IDS_PER_BULK = 200;

// Mutable observation and batching state.
let observer = null;
let pollTimer = null;
let pendingRefs = new Set();
let lastBulkAt = 0;

/*
    Code Block: Candidate Anchor Selectors

    Purpose
    Broad patterns to collect potential channel-name anchors across YouTube surfaces.
    Gating functions will further narrow to only true channel-name links.
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
    Code Block: Exclusion Rules

    Purpose
    Exclude anchors that are part of subscribe UI, sentiment bars, shelf/tab titles, etc.,
    to avoid false positives like "Videos", "Posts", etc.
*/
const EXCLUDE_CONTAINERS = [
    "ytd-subscribe-button-renderer",
    "ytd-sentiment-bar-renderer",
    "yt-tab-shape",
    "tp-yt-paper-tab",
    "tp-yt-paper-tabs",
    "ytd-shelf-renderer #title"
];

// Simple text guard for subscribe wording.
const EXCLUDE_TEXT_REGEX = /\bsubscribe|subscribers?\b/i;

/*
    Function: safeSendMessage

    Purpose
    Send a message to the background script with guards for missing extension context.

    Inputs
    - message: any

    Outputs
    - Promise<any|null> response or null on failure
*/
function safeSendMessage(message) {
    // Wrap chrome.runtime.sendMessage and normalize errors to null.
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
    Function: queryAllDeep

    Purpose
    Collect matching elements across light DOM and open shadow roots.

    Inputs
    - root: Node to start the traversal
    - selectors: string[] list of selectors

    Outputs
    - Element[] matches
*/
function queryAllDeep(root, selectors) {
    // Combine selectors and track visited shadow roots to avoid cycles.
    const results = [];
    const selector = selectors.join(",");
    const visited = new WeakSet();

    // Recursive scan that enters open shadow roots.
    function scan(node) {
        // Collect matches at this level.
        try {
            const found = node.querySelectorAll(selector);
            for (const el of found) results.push(el);
        } catch {}

        // Walk the element tree and dive into shadow roots once.
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

    // Begin traversal and return all results.
    scan(root);
    return results;
}

/*
    Function: closestDeep

    Purpose
    Like Element.closest, but climbs through shadow roots via their hosts.

    Inputs
    - startEl: Element to begin search
    - selector: string CSS selector to match

    Outputs
    - Element|null closest match
*/
function closestDeep(startEl, selector) {
    // Safe matches helper to guard non-element nodes.
    function matches(el, sel) {
        try { return el instanceof Element && el.matches(sel); } catch { return false; }
    }

    // Climb parent chain and hop from shadow root to host.
    if (!startEl) return null;
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
    Function: parseChannelRefFromHref

    Purpose
    Parse an anchor's href and classify whether it is a channel ROOT or SUBPAGE reference.
    Only ROOT references are considered valid for adding the icon.

    Inputs
    - rawHref: string from the anchor's href attribute

    Outputs
    - { kind: "uc"|"handle"|"c"|"user", id: string, hasExtra: boolean } | null
*/
function parseChannelRefFromHref(rawHref) {
    // Normalize to absolute URL and extract pathname.
    try {
        const href = String(rawHref || "");
        if (!href) return null;
        const u = /^https?:\/\//i.test(href) ? new URL(href) : new URL(href, location.origin);
        const path = u.pathname || "";
        let m;

        // Recognize /channel/UC... with optional trailing segment.
        m = path.match(/^\/channel\/(UC[0-9A-Za-z_-]{22})(?:\/(.*))?$/);
        if (m) return { kind: "uc", id: m[1], hasExtra: !!(m[2] && m[2].length) };

        // Recognize /@handle with optional trailing segment.
        m = path.match(/^\/@([^/]+)(?:\/(.*))?$/);
        if (m) return { kind: "handle", id: "@" + m[1].toLowerCase(), hasExtra: !!(m[2] && m[2].length) };

        // Recognize /c/name with optional trailing segment.
        m = path.match(/^\/c\/([^/]+)(?:\/(.*))?$/);
        if (m) return { kind: "c", id: "/c/" + m[1], hasExtra: !!(m[2] && m[2].length) };

        // Recognize /user/name with optional trailing segment.
        m = path.match(/^\/user\/([^/]+)(?:\/(.*))?$/);
        if (m) return { kind: "user", id: "/user/" + m[1], hasExtra: !!(m[2] && m[2].length) };

        // Not a supported channel reference.
        return null;
    } catch {
        // Parsing error treated as non-channel ref.
        return null;
    }
}

/*
    Function: isChannelHref

    Purpose
    Quick gate to check if an anchor's href looks like a channel reference.

    Inputs
    - a: HTMLAnchorElement

    Outputs
    - boolean
*/
function isChannelHref(a) {
    // Delegate to the parser and coerce to boolean.
    const info = parseChannelRefFromHref(a.getAttribute("href") || "");
    return !!info;
}

/*
    Function: isChannelNameAnchor

    Purpose
    Determine if an anchor represents a channel-name text link pointing to the channel ROOT.

    Inputs
    - a: HTMLAnchorElement

    Outputs
    - boolean
*/
function isChannelNameAnchor(a) {
    // Require a recognizable channel reference.
    if (!isChannelHref(a)) return false;

    // Exclude anchors wrapping images/avatars; only text names should get the icon.
    try {
        if (a.querySelector("img, yt-img-shadow")) return false;
    } catch {}

    // Exclude anchors in known containers (subscribe buttons, tabs, shelf titles).
    for (const sel of EXCLUDE_CONTAINERS) {
        if (closestDeep(a, sel)) return false;
    }

    // Exclude anchors whose visible text is subscribe-related.
    const txt = (a.textContent || "").trim();
    if (EXCLUDE_TEXT_REGEX.test(txt)) return false;

    // Exclude channel page navigation tabs by role.
    const role = (a.getAttribute("role") || "").toLowerCase();
    if (role === "tab") return false;

    // Accept only ROOT links; reject if there are trailing segments like /videos.
    const info = parseChannelRefFromHref(a.getAttribute("href") || "");
    if (!info || info.hasExtra) return false;

    // On video pages, only accept the dedicated #channel-name link.
    const inOwner = !!closestDeep(a, "ytd-video-owner-renderer");
    if (inOwner && !closestDeep(a, "ytd-video-owner-renderer #channel-name")) return false;

    // Passed all gates.
    return true;
}

/*
    Function: extractRef

    Purpose
    Produce a robust reference token for background checks, preferring UC or handle, else path.

    Inputs
    - a: HTMLAnchorElement

    Outputs
    - string | null reference token
*/
function extractRef(a) {
    // Read raw href and use parsed info when possible for consistency.
    try {
        const raw = (a.getAttribute("href") || "").trim();
        if (!raw) return null;

        const info = parseChannelRefFromHref(raw);
        if (info) {
            if (info.kind === "uc") return info.id;
            if (info.kind === "handle") return info.id;
            return raw.startsWith("/") ? raw : new URL(raw, location.href).pathname;
        }

        // Fallback patterns for robustness in edge cases.
        const mUC = raw.match(/\/channel\/(UC[0-9A-Za-z_-]{22})/);
        if (mUC) return mUC[1];
        const mAt = raw.match(/\/@([^/?#]+)/);
        if (mAt) return "@" + decodeURIComponent(mAt[1].toLowerCase());

        // If absolute URL, check for youtube host-specific forms.
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

        // Resolve relative paths as a last resort.
        try {
            return new URL(raw, location.href).toString();
        } catch {
            return raw;
        }
    } catch {
        // Extraction failure yields null.
        return null;
    }
}

/*
    Function: addMarker

    Purpose
    Append the subscription marker icon image to a channel-name anchor.

    Inputs
    - a: HTMLAnchorElement target

    Outputs
    - void
*/
function addMarker(a) {
    // Avoid duplicate markers on the same anchor.
    if (a.querySelector(".subscription-marker")) return;

    // Create image element and set source from extension assets.
    const img = document.createElement("img");
    try {
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) {
            img.src = chrome.runtime.getURL("icon.png");
        } else {
            return;
        }
    } catch { return; }

    // Style and annotate the marker, then append.
    img.className = "subscription-marker";
    img.style.marginLeft = "5px";
    img.style.width = "16px";
    img.style.height = "16px";
    img.alt = "subscribed";
    img.title = "You are subscribed";
    a.appendChild(img);
}

/*
    Function: queueRefsFromDom

    Purpose
    Scan the DOM for candidate anchors, gate them, extract references, and queue for bulk checks.

    Inputs
    - None

    Outputs
    - void
*/
function queueRefsFromDom() {
    // Collect potential anchors across light/shadow DOM.
    const anchors = queryAllDeep(document, SELECTOR_LIST);

    // Track counts for heartbeat visibility.
    let seen = 0;
    let eligible = 0;
    let extracted = 0;
    let added = 0;

    // Gate and queue each anchor reference for background checks.
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

    // Emit a periodic scan summary.
    logger.heartbeat("scan", () => ["scan", "anchors", seen, "eligible", eligible, "extracted", extracted, "queued", added, "pending", pendingRefs.size]);

    // If the bulk interval has elapsed, trigger a flush.
    if (pendingRefs.size && Date.now() - lastBulkAt >= BULK_INTERVAL_MS) {
        void flushBulk();
    }
}

/*
    Function: flushBulk

    Purpose
    Send a batch of pending references to the background and append markers for positive results.

    Inputs
    - None

    Outputs
    - Promise<void>
*/
async function flushBulk() {
    // Respect interval and skip when nothing is queued.
    if (!pendingRefs.size) return;
    const now = Date.now();
    if (now - lastBulkAt < BULK_INTERVAL_MS) return;
    lastBulkAt = now;

    // Drain up to MAX_IDS_PER_BULK items into an array.
    const ids = [];
    for (const id of pendingRefs) {
        ids.push(id);
        if (ids.length >= MAX_IDS_PER_BULK) break;
    }
    for (const id of ids) pendingRefs.delete(id);

    // Request results from background script.
    logger.info("bulk request", ids.length);
    let response = null;
    try {
        response = await safeSendMessage({ type: "bulkCheckChannels", ids });
    } catch {
        response = null;
    }

    // On failure, requeue to try again later.
    if (!response || !response.results) {
        logger.warn("bulk response missing; requeueing", ids.length);
        for (const id of ids) pendingRefs.add(id);
        return;
    }

    // Re-scan current DOM snapshot and mark passing anchors.
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

    // Log how many markers were added this pass.
    if (marked > 0) logger.info("markers added", marked);

    // If work remains, schedule another flush.
    if (pendingRefs.size) {
        setTimeout(flushBulk, BULK_INTERVAL_MS);
    }
}

/*
    Code Block: Debug Bridges (Resolve / Identity / Account / Invalidate)

    Purpose
    Expose optional test hooks via window.postMessage. Gated behind DEBUG to reduce surface area and noise.

    Inputs
    - Messages: YTSM_DEBUG_RESOLVE, YTSM_WHOAMI, YTSM_LOGOUT, YTSM_REAUTH, YTSM_INVALIDATE

    Outputs
    - Matching *_RESULT messages posted back to window
*/
if (DEBUG) {
    // Resolve test bridge.
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

    // Identity bridge.
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

    // Account control bridges (logout, reauth).
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

    // Invalidate handle/url cache bridge.
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
}

/*
    Function: start

    Purpose
    Begin observing mutations and periodic scans, and trigger an initial background refresh.

    Inputs
    - None

    Outputs
    - void
*/
function start() {
    // Ensure clean state by stopping any prior observers/timers.
    stop();

    // Observe DOM mutations and schedule scans on microtasks.
    observer = new MutationObserver(() => {
        queueMicrotask(queueRefsFromDom);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // Periodic scan to catch changes missed by mutations.
    pollTimer = setInterval(queueRefsFromDom, 1500);

    // Initial scan and early bulk flush.
    queueRefsFromDom();
    lastBulkAt = 0;
    setTimeout(() => void flushBulk(), 100);

    // Opportunistic subscriptions refresh.
    void safeSendMessage({ type: "refreshSubscriptions" });
}

/*
    Function: stop

    Purpose
    Disconnect observers and timers, and clear any pending queue.

    Inputs
    - None

    Outputs
    - void
*/
function stop() {
    // Disconnect mutation observer.
    if (observer) { observer.disconnect(); observer = null; }

    // Clear periodic polling timer.
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }

    // Empty any queued references.
    pendingRefs.clear();
}

/*
    Code Block: Lifecycle Hooks

    Purpose
    Tie start/stop to page and tab visibility lifecycle to avoid wasted work.

    Inputs
    - pagehide, beforeunload, visibilitychange events

    Outputs
    - None
*/
window.addEventListener("pagehide", stop, { capture: true });
window.addEventListener("beforeunload", stop, { capture: true });
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
        stop();
    } else {
        setTimeout(start, 150);
    }
});

/*
    Code Block: Script Entry

    Purpose
    Kick off the content script logic.

    Inputs
    - None

    Outputs
    - None
*/
start();
