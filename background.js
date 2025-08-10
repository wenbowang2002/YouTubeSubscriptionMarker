// background.js

import config from "./config.js";

/*
    Configuration
*/
const LOG_PREFIX = "[YTSM/BG]";
const CLIENT_ID = config.CLIENT_ID;
const REDIRECT_URI = `https://${chrome.runtime.id}.chromiumapp.org/`;
const SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"];
const TOKEN_KEY = "oauth_token";
const SEARCH_API_KEY = config.SEARCH_API_KEY;

/*
    Caches and TTLs
*/
const ONE_HOUR_MS = 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const HANDLE_RESOLVE_TIMEOUT_MS = 8000;

/*
    Subscription list sync
*/
const SUB_LIST_TTL_MS = 12 * 60 * 60 * 1000;
const SUB_LIST_BATCH = 50;
const SUBS_INDEX_KEY = "subscriptionsIndex";

/*
    Warm-start per-channel budget
*/
const PC_BUDGET_MAX = 20;
const PC_BUDGET_REFILL_MS = 60_000;
let pcTokens = PC_BUDGET_MAX;
let pcLastRefill = Date.now();

/*
    Negative verification safety net
    Used when subs index says "not subscribed", to spot-check a few per minute
*/
const VERIFY_BUDGET_MAX = 10;
const VERIFY_BUDGET_REFILL_MS = 60_000;
let verifyTokens = VERIFY_BUDGET_MAX;
let verifyLastRefill = Date.now();
const VERIFY_NEG_TTL_MS = 6 * 60 * 60 * 1000;

/*
    In-memory mirrors
*/
let cache = {};
let handleToChannelCache = {};
let subsIndex = { updatedAt: 0, ids: [] };
let syncing = false;

/*
    Tracks last negative verification time per channel to avoid repeats
*/
let lastNegativeVerifyAt = {};

/*
    Bootstrap caches from storage
*/
chrome.storage.local.get(
    ["subscriptionCache", "handleChannelCache", SUBS_INDEX_KEY],
    data => {
        if (data.subscriptionCache && typeof data.subscriptionCache === "object") {
            cache = data.subscriptionCache;
            console.log(LOG_PREFIX, "loaded subscription cache:", Object.keys(cache).length);
        } else {
            console.log(LOG_PREFIX, "no subscription cache found");
        }

        if (data.handleChannelCache && typeof data.handleChannelCache === "object") {
            handleToChannelCache = data.handleChannelCache;
            console.log(LOG_PREFIX, "loaded handle cache:", Object.keys(handleToChannelCache).length);
        } else {
            console.log(LOG_PREFIX, "no handle cache found");
        }

        if (data[SUBS_INDEX_KEY] && Array.isArray(data[SUBS_INDEX_KEY].ids)) {
            subsIndex = data[SUBS_INDEX_KEY];
            console.log(
                LOG_PREFIX,
                "loaded subs index size:",
                subsIndex.ids.length,
                "updatedAt:",
                new Date(subsIndex.updatedAt).toISOString()
            );
        } else {
            console.log(LOG_PREFIX, "no subs index found");
        }

        getValidToken().then(tok => {
            if (tok && isSubsIndexStale()) {
                console.log(LOG_PREFIX, "subs index stale, starting background sync");
                void ensureSubsIndexFresh(false);
            }
        });
    }
);

/*
    Storage save
*/
async function saveCachesToStorage() {
    return new Promise(resolve => {
        chrome.storage.local.set(
            {
                subscriptionCache: cache,
                handleChannelCache: handleToChannelCache,
                [SUBS_INDEX_KEY]: subsIndex
            },
            () => {
                console.log(LOG_PREFIX, "caches saved to storage");
                resolve();
            }
        );
    });
}

/*
    Helpers
*/
function isSubsIndexStale() {
    return !subsIndex.updatedAt || (Date.now() - subsIndex.updatedAt) > SUB_LIST_TTL_MS;
}

function setSubsIndex(ids) {
    subsIndex = { updatedAt: Date.now(), ids: Array.from(new Set(ids)) };
    return saveCachesToStorage();
}

function subsSet() {
    return new Set(subsIndex.ids);
}

function refillPcTokens() {
    const now = Date.now();
    if (now - pcLastRefill >= PC_BUDGET_REFILL_MS) {
        pcTokens = PC_BUDGET_MAX;
        pcLastRefill = now;
        console.log(LOG_PREFIX, "warm-start per-channel tokens refilled to", pcTokens);
    }
}

function consumePcToken() {
    refillPcTokens();
    if (pcTokens > 0) {
        pcTokens -= 1;
        console.log(LOG_PREFIX, "warm-start token consumed, remaining:", pcTokens);
        return true;
    }
    return false;
}

function refillVerifyTokens() {
    const now = Date.now();
    if (now - verifyLastRefill >= VERIFY_BUDGET_REFILL_MS) {
        verifyTokens = VERIFY_BUDGET_MAX;
        verifyLastRefill = now;
        console.log(LOG_PREFIX, "verify tokens refilled to", verifyTokens);
    }
}

function consumeVerifyToken() {
    refillVerifyTokens();
    if (verifyTokens > 0) {
        verifyTokens -= 1;
        console.log(LOG_PREFIX, "verify token consumed, remaining:", verifyTokens);
        return true;
    }
    return false;
}

function findKeyInObject(obj, keyToFind, validateFn) {
    if (typeof obj !== "object" || obj === null) return null;
    for (const key in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
        const value = obj[key];
        if (key === keyToFind && typeof value === "string" && (!validateFn || validateFn(value))) {
            return value;
        }
        if (typeof value === "object" && value !== null) {
            const result = findKeyInObject(value, keyToFind, validateFn);
            if (result) return result;
        }
    }
    return null;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = HANDLE_RESOLVE_TIMEOUT_MS) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...opts, signal: controller.signal, redirect: "follow" });
    } finally {
        clearTimeout(id);
    }
}

/*
    OAuth
*/
async function getTokenFromStorage() {
    return new Promise(resolve => {
        chrome.storage.local.get([TOKEN_KEY], data => resolve(data[TOKEN_KEY] || null));
    });
}

async function setTokenInStorage(token) {
    return new Promise(resolve => chrome.storage.local.set({ [TOKEN_KEY]: token }, () => resolve()));
}

async function clearToken() {
    return new Promise(resolve => chrome.storage.local.remove([TOKEN_KEY], () => resolve()));
}

function buildAuthUrl(promptType) {
    const params = new URLSearchParams({
        response_type: "token",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: SCOPES.join(" ")
    });
    if (promptType) params.set("prompt", promptType);
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function fetchToken(interactive, promptType) {
    const authUrl = buildAuthUrl(promptType);
    return new Promise((resolve, reject) => {
        chrome.identity.launchWebAuthFlow({ url: authUrl, interactive }, async redirectUrl => {
            if (chrome.runtime.lastError || !redirectUrl) {
                return reject(chrome.runtime.lastError || new Error("no redirect url"));
            }
            const fragments = redirectUrl.split("#")[1];
            if (!fragments) return reject(new Error("no fragment in redirect url"));
            const params = new URLSearchParams(fragments);
            const access_token = params.get("access_token");
            const expires_in = parseInt(params.get("expires_in"), 10);
            if (!access_token) return reject(new Error("no access token found"));
            const tokenObj = { access_token, expiry_date: Date.now() + expires_in * 1000 };
            await setTokenInStorage(tokenObj);
            resolve(tokenObj);
        });
    });
}

async function getValidToken() {
    const token = await getTokenFromStorage();
    if (token && token.expiry_date > Date.now()) return token;
    return null;
}

/*
    Full subscriptions sync
*/
async function ensureSubsIndexFresh(force = false) {
    if (syncing) {
        console.log(LOG_PREFIX, "subs sync already running");
        return false;
    }
    if (!force && !isSubsIndexStale()) {
        console.log(LOG_PREFIX, "subs index fresh, skipping sync");
        return false;
    }

    const token = await getValidToken();
    if (!token) {
        console.log(LOG_PREFIX, "no valid token, cannot sync subs");
        return false;
    }

    syncing = true;
    console.log(LOG_PREFIX, "starting subscriptions sync");

    try {
        const allIds = [];
        let pageToken = "";
        const fields = "nextPageToken,items(snippet/resourceId/channelId)";
        const base =
            `https://www.googleapis.com/youtube/v3/subscriptions?part=snippet&mine=true&maxResults=${SUB_LIST_BATCH}&fields=${encodeURIComponent(fields)}`;

        while (true) {
            const url = pageToken ? `${base}&pageToken=${pageToken}` : base;
            const resp = await fetchWithTimeout(
                url,
                { headers: { Authorization: `Bearer ${token.access_token}` } },
                15000
            );
            if (!resp.ok) {
                if (resp.status === 401) {
                    await clearToken();
                    throw new Error("token expired, please authenticate again.");
                }
                throw new Error(`subscriptions sync api error: ${resp.status} ${resp.statusText}`);
            }
            const data = await resp.json();
            if (Array.isArray(data.items)) {
                for (const it of data.items) {
                    const id = it?.snippet?.resourceId?.channelId;
                    if (id && id.startsWith("UC")) allIds.push(id);
                }
            }
            if (data.nextPageToken) {
                pageToken = data.nextPageToken;
            } else {
                break;
            }
        }

        await setSubsIndex(allIds);
        console.log(LOG_PREFIX, "subscriptions synced, total:", allIds.length);
        return true;
    } catch (e) {
        console.warn(LOG_PREFIX, "subscriptions sync failed:", e?.message || e);
        return false;
    } finally {
        syncing = false;
    }
}

/*
    Handle resolution
*/
function extractChannelIdFromHtml(html) {
    const direct = html.match(/"channelId"\s*:\s*"(UC[0-9A-Za-z_-]{22})"/);
    if (direct) return direct[1];

    const path = html.match(/\/channel\/(UC[0-9A-Za-z_-]{22})/);
    if (path) return path[1];

    const initial =
        html.match(/ytInitialData\s*=\s*({.*?});\s*<\/script>/s) ||
        html.match(/ytInitialData\s*=\s*({.*?});/s);
    if (initial) {
        try {
            const j = JSON.parse(initial[1]);
            const found = findKeyInObject(j, "channelId", v => v.startsWith("UC"));
            if (found) return found;
            const meta = j?.metadata?.channelMetadataRenderer?.channelId;
            if (meta) return meta;
            const canon = j?.microformat?.microformatDataRenderer?.urlCanonical;
            const m = canon && canon.match(/\/channel\/(UC[0-9A-Za-z_-]{22})/);
            if (m) return m[1];
        } catch {
        }
    }

    const ytcfgMatch = html.match(/ytcfg\.set\(\s*({.*?})\s*\);/s);
    if (ytcfgMatch) {
        try {
            const cfg = JSON.parse(ytcfgMatch[1]);
            const found = findKeyInObject(cfg, "channelId", v => v.startsWith("UC"));
            if (found) return found;
        } catch {
        }
    }

    return null;
}

async function fetchChannelIdFromHandlePage(handle) {
    const clean = handle.startsWith("@") ? handle.slice(1) : handle;
    const paths = [
        `https://www.youtube.com/@${clean}`,
        `https://www.youtube.com/@${clean}/about`,
        `https://www.youtube.com/@${clean}/featured`
    ];

    for (const url of paths) {
        try {
            const resp = await fetchWithTimeout(url, {}, HANDLE_RESOLVE_TIMEOUT_MS);
            if (!resp.ok) continue;
            const html = await resp.text();
            const id = extractChannelIdFromHtml(html);
            if (id) return id;
        } catch {
        }
    }
    return null;
}

async function getChannelIdFromApi(handle) {
    const qRaw = handle.startsWith("@") ? handle.slice(1) : handle;
    const queries = [`@${qRaw}`, qRaw];

    for (const query of queries) {
        const url =
            `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=5&q=${encodeURIComponent(query)}&key=${SEARCH_API_KEY}`;
        const resp = await fetchWithTimeout(url, {}, 7000);
        if (!resp.ok) continue;

        const data = await resp.json();
        if (!data.items || data.items.length === 0) continue;

        let best = null;
        let bestScore = -1;
        const qNorm = qRaw.toLowerCase();

        for (const item of data.items) {
            const id = item?.id?.channelId;
            const sn = item?.snippet || {};
            const title = (sn.channelTitle || "").toLowerCase();
            const customUrl = (sn.customUrl || "").toLowerCase();
            let score = 0;
            if (customUrl === qNorm) score += 100;
            if (title === qNorm) score += 60;
            if (customUrl.includes(qNorm)) score += 25;
            if (title.includes(qNorm)) score += 15;
            if (id && score > bestScore) {
                best = id;
                bestScore = score;
            }
        }

        if (best) return best;
    }

    return null;
}

async function resolveHandleToChannelId(handle) {
    if (handleToChannelCache[handle] !== undefined && handleToChannelCache[handle] !== null) {
        const cached = handleToChannelCache[handle];
        if (typeof cached === "object" && cached._neg) {
            const stale = Date.now() - cached.ts > NEGATIVE_CACHE_TTL_MS;
            if (!stale) {
                console.log(LOG_PREFIX, "handle negative-cached", handle);
                return null;
            }
        } else {
            console.log(LOG_PREFIX, "handle cached", handle, "=>", cached);
            return cached;
        }
    }

    let rawHandle = handle;
    if (rawHandle.includes("%")) {
        try {
            const part = rawHandle.startsWith("@") ? rawHandle.slice(1) : rawHandle;
            const decodedPart = decodeURIComponent(part);
            rawHandle = rawHandle.startsWith("@") ? "@" + decodedPart : decodedPart;
        } catch {
            rawHandle = handle;
        }
    }

    console.log(LOG_PREFIX, "resolving handle", rawHandle);

    let channelId = await fetchChannelIdFromHandlePage(rawHandle);
    if (!channelId) {
        channelId = await getChannelIdFromApi(rawHandle);
    }

    if (!channelId) {
        handleToChannelCache[handle] = { _neg: true, ts: Date.now() };
        console.warn(LOG_PREFIX, "handle resolve failed", handle);
    } else {
        handleToChannelCache[handle] = channelId;
        console.log(LOG_PREFIX, "handle resolved", handle, "=>", channelId);
    }

    await saveCachesToStorage();
    return channelId || null;
}

/*
    Per-channel subscription check
*/
async function checkSubscribedPerChannel(channelId) {
    const token = await getValidToken();
    if (!token) return false;

    const url =
        `https://www.googleapis.com/youtube/v3/subscriptions?part=subscriberSnippet&mine=true&forChannelId=${channelId}`;
    const resp = await fetchWithTimeout(
        url,
        { headers: { Authorization: `Bearer ${token.access_token}` } },
        10000
    );
    if (!resp.ok) {
        if (resp.status === 401) {
            await clearToken();
            console.warn(LOG_PREFIX, "token expired during per-channel check");
            return false;
        }
        console.warn(LOG_PREFIX, "per-channel check api non-ok", resp.status, resp.statusText);
        return false;
    }

    const data = await resp.json();
    const subscribed = !!(data.items && data.items.length > 0);

    cache[channelId] = { status: subscribed, updatedAt: Date.now() };
    await saveCachesToStorage();

    console.log(LOG_PREFIX, "per-channel result", channelId, "=>", subscribed);
    return subscribed;
}

/*
    Main check with hybrid safety nets
*/
async function isUserSubscribedLocal(idOrHandle) {
    let channelId = idOrHandle;

    if (channelId.startsWith("@")) {
        const real = await resolveHandleToChannelId(channelId);
        if (!real) return false;
        channelId = real;
    }

    if (subsIndex.ids && subsIndex.ids.length) {
        const inSet = subsSet().has(channelId);
        console.log(LOG_PREFIX, "local subs check", channelId, "=>", inSet);

        if (inSet) {
            return true;
        }

        const lastNeg = lastNegativeVerifyAt[channelId] || 0;
        const negFresh = Date.now() - lastNeg < VERIFY_NEG_TTL_MS;

        if (!negFresh && consumeVerifyToken()) {
            console.log(LOG_PREFIX, "negative verification for", channelId);
            const verified = await checkSubscribedPerChannel(channelId);
            lastNegativeVerifyAt[channelId] = Date.now();

            if (verified && !subsSet().has(channelId)) {
                subsIndex.ids.push(channelId);
                await saveCachesToStorage();
                console.log(LOG_PREFIX, "negative verify found new subscription, updating subs index");
            }
            return verified;
        }

        return false;
    }

    if (isSubsIndexStale() && consumePcToken()) {
        try {
            return await checkSubscribedPerChannel(channelId);
        } catch {
            return false;
        }
    }

    const c = cache[channelId];
    if (c && (Date.now() - c.updatedAt) < ONE_HOUR_MS) {
        console.log(LOG_PREFIX, "legacy cache check", channelId, "=>", c.status);
        return !!c.status;
    }

    return false;
}

/*
    Messaging
*/
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "bulkCheckChannels") {
        const ids = Array.isArray(message.ids) ? message.ids.slice(0, 100) : [];
        const results = {};
        const promises = ids.map(async id => {
            try {
                results[id] = await isUserSubscribedLocal(id);
            } catch {
                results[id] = false;
            }
        });
        Promise.all(promises).then(() => {
            sendResponse({ results, stale: isSubsIndexStale(), syncing });
        });
        return true;
    }

    if (message.type === "checkChannel") {
        const { channelId } = message;
        isUserSubscribedLocal(channelId)
            .then(subscribed => sendResponse({ subscribed }))
            .catch(() => sendResponse({ subscribed: false }));
        return true;
    }

    if (message.type === "getCachedStatus") {
        const { channelId } = message;
        if (cache[channelId] !== undefined && cache[channelId] !== null) {
            const cachedEntry = cache[channelId];
            sendResponse({ status: !!cachedEntry?.status });
        } else {
            sendResponse({});
        }
        return true;
    }

    if (message.type === "checkAuth") {
        getValidToken().then(token => sendResponse({ authenticated: !!token }));
        return true;
    }

    if (message.type === "refreshSubscriptions") {
        ensureSubsIndexFresh(true).then(updated => {
            sendResponse({ ok: updated, total: subsIndex.ids.length, updatedAt: subsIndex.updatedAt });
        });
        return true;
    }

    if (message.type === "invalidateHandle") {
        const { handle } = message;
        if (handle && handleToChannelCache[handle] !== undefined) {
            delete handleToChannelCache[handle];
            saveCachesToStorage().then(() => sendResponse({ ok: true }));
            return true;
        }
        sendResponse({ ok: false });
        return true;
    }

    return false;
});

/*
    Click action: authenticate and force subs sync
*/
chrome.action.onClicked.addListener(async () => {
    try {
        await fetchToken(true, "consent");
        console.log(LOG_PREFIX, "authenticated, starting forced subscriptions sync");
        await ensureSubsIndexFresh(true);
        console.log(LOG_PREFIX, "subscriptions ready:", subsIndex.ids.length);
    } catch (e) {
        console.error(LOG_PREFIX, "auth/sync failed:", e?.message || e);
    }
});
