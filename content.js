// content.js

/*
    Developer notes

    This script runs in the context of YouTube pages. It never calls network APIs.
    Its role is to detect channel anchors as the page updates, extract either a UC
    channelId or an @handle, and ask the background service to determine membership.

    The selector set intentionally covers multiple surfaces. A guard function is used
    to avoid placing markers in unintended areas such as subscriber-count elements.
*/

const DEBUG = true;
const LOG_PREFIX = "[YTSM/CS]";

/*
    Bulk and polling configuration

    Bulk messages reduce chatter to the background without delaying the UI.
    A MutationObserver plus a light polling loop catches SPA updates and lazy loads.
*/
const BULK_INTERVAL_MS = 1000;
const MAX_IDS_PER_BULK = 100;
let observer = null;
let pollTimer = null;
let pendingIds = new Set();
let lastBulkAt = 0;

/*
    Logging helper guarded by DEBUG
*/
function log(...args) {
    if (DEBUG) console.log(LOG_PREFIX, ...args);
}

/*
    Safe wrapper around sendMessage

    Handles cases where the extension context is not ready or becomes invalidated
    during YouTube SPA navigations. Always resolves to a response or null.
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
    Extract either a UC channelId or a normalized @handle from an anchor element

    The function tolerates both absolute and relative hrefs and normalizes handles
    to lowercase for stable cache keys.
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
    Insert a checkmark icon adjacent to a channel anchor

    The marker is idempotent per anchor to prevent duplicates during repeated scans.
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
    Heuristic gate to ensure we only mark the channel name anchor

    This prevents adding a marker next to subscriber-count elements or other
    secondary anchors on the Watch page and similar surfaces.
*/
function isChannelNameAnchor(a) {
    if (a.closest("#owner-sub-count")) return false;
    if (/\bsubscribers?\b/i.test(a.textContent || "")) return false;

    if (a.closest("ytd-channel-name")) return true;
    if (a.closest("#channel-name")) return true;

    return false;
}

/*
    Anchor selector set

    This gathers anchors from several common components. Additional selectors
    can be added as YouTube evolves, while the isChannelNameAnchor gate
    protects against false positives.
*/
function getAnchors() {
    return document.querySelectorAll([
        "ytd-channel-name a",
        "ytd-video-owner-renderer ytd-channel-name a",
        "ytd-mini-channel-renderer a.yt-simple-endpoint",
        'a[href^="/@"]',
        'a[href^="/channel/UC"]'
    ].join(","));
}

/*
    Queue new IDs found on the page

    Each anchor maintains a tiny set of IDs it has already contributed to avoid
    re-queuing during repeated scans or SPA updates.
*/
function queueIdsFromDom() {
    const anchors = getAnchors();
    let added = 0;

    for (const a of anchors) {
        if (!isChannelNameAnchor(a)) continue;

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
    Bulk message to background for membership checks

    Results are applied idempotently by scanning anchors again. This tolerates
    DOM changes that occur while waiting for the background response.
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
        if (!isChannelNameAnchor(a)) continue;
        const id = extractIdOrHandle(a);
        if (!id) continue;
        if (results[id] === true) addMarker(a);
    }

    if (pendingIds.size) {
        setTimeout(flushBulk, BULK_INTERVAL_MS);
    }
}

/*
    Lifecycle management

    Uses a MutationObserver for micro-batch responsiveness and a slow poller
    as a belt-and-suspenders backup for missed mutations on heavy pages.
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

/*
    Handle SPA lifecycle transitions

    These events keep the scanner aligned with page visibility and navigation.
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

start();
