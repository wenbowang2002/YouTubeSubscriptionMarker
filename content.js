// content.js

/*
    Toggle debug logs
*/
const DEBUG = true;
const LOG_PREFIX = "[YTSM/CS]";

/*
    Bulk and polling configuration
*/
const BULK_INTERVAL_MS = 1000;
const MAX_IDS_PER_BULK = 100;
let observer = null;
let pollTimer = null;
let pendingIds = new Set();
let lastBulkAt = 0;

/*
    Utilities
*/
function log(...args) {
    if (DEBUG) console.log(LOG_PREFIX, ...args);
}

function safeSendMessage(message) {
    return new Promise(resolve => {
        try {
            if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) {
                return resolve(null);
            }
            chrome.runtime.sendMessage(message, response => {
                const err = chrome.runtime.lastError;
                if (err) {
                    if (DEBUG) console.warn(LOG_PREFIX, "sendMessage error:", err.message, "for", message?.type);
                    return resolve(null);
                }
                resolve(response ?? null);
            });
        } catch (e) {
            if (DEBUG) console.warn(LOG_PREFIX, "sendMessage threw:", e);
            resolve(null);
        }
    });
}

/*
    Extractor
*/
function extractIdOrHandle(a) {
    try {
        const raw = (a.getAttribute("href") || "").trim();
        if (!raw) return null;

        const mUC = raw.match(/\/channel\/(UC[0-9A-Za-z_-]{22})/);
        if (mUC) return mUC[1];

        const mAt = raw.match(/\/@([^/?#]+)/);
        if (mAt) return "@" + mAt[1].toLowerCase();

        const url = new URL(a.href, location.href);
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts[0] === "channel" && parts[1]) return parts[1];
        if (parts[0] && parts[0].startsWith("@")) return "@" + parts[0].slice(1).toLowerCase();

        return null;
    } catch {
        return null;
    }
}

/*
    Marker
*/
function addMarker(a) {
    if (a.querySelector(".subscription-marker")) return;
    const img = document.createElement("img");
    try {
        img.src = chrome.runtime.getURL("icon.png");
    } catch {
        return;
    }
    img.className = "subscription-marker";
    img.style.marginLeft = "5px";
    img.style.width = "16px";
    img.style.height = "16px";
    img.alt = "subscribed";
    img.title = "You are subscribed";
    a.appendChild(img);
}

/*
    Selector coverage
*/
function getAnchors() {
    return document.querySelectorAll([
        "ytd-channel-name a",
        "ytd-video-owner-renderer a.yt-simple-endpoint",
        "ytd-rich-grid-media a.yt-simple-endpoint",
        "ytd-compact-video-renderer a.yt-simple-endpoint",
        "ytd-playlist-video-renderer a.yt-simple-endpoint",
        "ytd-grid-video-renderer a.yt-simple-endpoint",
        "ytd-mini-channel-renderer a.yt-simple-endpoint",
        "a.yt-simple-endpoint.style-scope.yt-formatted-string",
        'a[href^="/@"]',
        'a[href^="/channel/UC"]'
    ].join(","));
}

/*
    Queue ids for bulk check
*/
function queueIdsFromDom() {
    const anchors = getAnchors();
    let added = 0;

    for (const a of anchors) {
        const id = extractIdOrHandle(a);
        if (!id) continue;

        if (a.querySelector(".subscription-marker")) continue;

        let list = a.__ytsmIds;
        if (!list) {
            list = new Set();
            Object.defineProperty(a, "__ytsmIds", { value: list, writable: false });
        }
        if (!list.has(id)) {
            list.add(id);
            pendingIds.add(id);
            added += 1;
        }
    }

    if (added > 0) log("queued", added, "ids; pending =", pendingIds.size);

    const now = Date.now();
    if (pendingIds.size && (now - lastBulkAt >= BULK_INTERVAL_MS)) {
        void flushBulk();
    }
}

/*
    Bulk check and apply markers
*/
async function flushBulk() {
    if (!pendingIds.size) return;

    const now = Date.now();
    if (now - lastBulkAt < BULK_INTERVAL_MS) return;
    lastBulkAt = now;

    const ids = [];
    for (const id of pendingIds) {
        ids.push(id);
        pendingIds.delete(id);
        if (ids.length >= MAX_IDS_PER_BULK) break;
    }

    log("sending bulk check:", ids.length, "ids");

    let response = null;
    try {
        response = await safeSendMessage({ type: "bulkCheckChannels", ids });
    } catch {
        response = null;
    }

    if (!response || !response.results) {
        log("bulk results missing or null; requeueing ids");
        for (const id of ids) pendingIds.add(id);
        return;
    }

    const results = response.results;
    log("bulk results received:", Object.keys(results).length, "stale:", response.stale, "syncing:", response.syncing);

    const anchors = getAnchors();
    for (const a of anchors) {
        const id = extractIdOrHandle(a);
        if (!id) continue;
        if (results[id] === true) addMarker(a);
    }

    if (pendingIds.size) {
        setTimeout(flushBulk, BULK_INTERVAL_MS);
    }
}

/*
    Lifecycle
*/
function start() {
    stop();

    observer = new MutationObserver(() => {
        queueMicrotask(queueIdsFromDom);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    pollTimer = setInterval(queueIdsFromDom, 1500);

    queueIdsFromDom();

    chrome.runtime.sendMessage({ type: "refreshSubscriptions" }, () => {});
}

function stop() {
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    pendingIds.clear();
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
