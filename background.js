// background.js

import config from "./config.js";

/*
    Module: Service Worker (Background)

    Purpose
    Own OAuth, YouTube Data API access, channel reference resolution, and persistent caching. Provide low-quota,
    O(1) membership checks to the content script through a locally maintained subscriptions index.

    Quota Strategy
    Prefer a local subscriptions index for membership decisions. Resolve channel references to UC ids by HTML parsing with
    short timeouts and host variants. Use the Search API only as a minimal fallback. Persist negative results to avoid
    repeated work. Occasionally re-verify negative answers under a small budget.

    Logging
    Structured logger with levels and throttled heartbeats for stage checks without log spam.

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

const logger = makeLogger("[YTSM/BG]", "info", 3000);

/*
    Section: Configuration and State
*/
const CLIENT_ID = config.CLIENT_ID;
const SEARCH_API_KEY = config.SEARCH_API_KEY;
const REDIRECT_URI = `https://${chrome.runtime.id}.chromiumapp.org/`;
const SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"];
const TOKEN_KEY = "oauth_token";

const ONE_HOUR_MS = 60 * 60 * 1000;
const SUB_LIST_TTL_MS = 12 * 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const HANDLE_RESOLVE_TIMEOUT_MS = 8000;

const SUB_LIST_BATCH = 50;
const SUBS_INDEX_KEY = "subscriptionsIndex";

const PC_BUDGET_MAX = 20;
const PC_BUDGET_REFILL_MS = 60_000;
let pcTokens = PC_BUDGET_MAX;
let pcLastRefill = Date.now();

const VERIFY_BUDGET_MAX = 10;
const VERIFY_BUDGET_REFILL_MS = 60_000;
const VERIFY_NEG_TTL_MS = 6 * 60 * 60 * 1000;
let verifyTokens = VERIFY_BUDGET_MAX;
let verifyLastRefill = Date.now();

let cache = {};
let handleToChannelCache = {};
let subsIndex = { updatedAt: 0, ids: [] };
let lastNegativeVerifyAt = {};
let syncing = false;

/*
    Section: Startup Cache Hydration

    Purpose
    Load caches from storage and kick a background subscriptions refresh if stale.
*/
chrome.storage.local.get(
    ["subscriptionCache", "handleChannelCache", SUBS_INDEX_KEY],
    data => {
        if (data.subscriptionCache && typeof data.subscriptionCache === "object") {
            cache = data.subscriptionCache;
            logger.info("per-channel cache entries", Object.keys(cache).length);
        } else {
            logger.info("no legacy per-channel cache");
        }
        if (data.handleChannelCache && typeof data.handleChannelCache === "object") {
            handleToChannelCache = data.handleChannelCache;
            logger.info("handle/url cache entries", Object.keys(handleToChannelCache).length);
        } else {
            logger.info("no handle/url cache");
        }
        if (data[SUBS_INDEX_KEY] && Array.isArray(data[SUBS_INDEX_KEY].ids)) {
            subsIndex = data[SUBS_INDEX_KEY];
            logger.info("subscriptions index", subsIndex.ids.length, new Date(subsIndex.updatedAt).toISOString());
        } else {
            logger.info("no subscriptions index");
        }
        getValidToken().then(tok => {
            if (tok && isSubsIndexStale()) {
                logger.info("subscriptions index stale; starting refresh");
                void ensureSubsIndexFresh(false);
            }
        });
    }
);

/*
    Function: saveCachesToStorage

    Purpose
    Persist all caches atomically to chrome.storage.local.

    Parameters
    none

    Returns
    Promise<void>
*/
async function saveCachesToStorage() {
    return new Promise(resolve => {
        chrome.storage.local.set(
            {
                subscriptionCache: cache,
                handleChannelCache: handleToChannelCache,
                [SUBS_INDEX_KEY]: subsIndex
            },
            () => resolve()
        );
    });
}

/*
    Function: isSubsIndexStale

    Purpose
    Determine whether the subscriptions index has exceeded its TTL.

    Parameters
    none

    Returns
    boolean
*/
function isSubsIndexStale() {
    return !subsIndex.updatedAt || Date.now() - subsIndex.updatedAt > SUB_LIST_TTL_MS;
}

/*
    Function: setSubsIndex

    Purpose
    Replace the subscriptions index with a de-duplicated array and persist it.

    Parameters
    ids: string[]

    Returns
    Promise<void>
*/
function setSubsIndex(ids) {
    subsIndex = { updatedAt: Date.now(), ids: Array.from(new Set(ids)) };
    return saveCachesToStorage();
}

/*
    Function: subsSet

    Purpose
    Provide a Set view of the current subscriptions index for O(1) lookups.

    Parameters
    none

    Returns
    Set<string>
*/
function subsSet() {
    return new Set(subsIndex.ids);
}

/*
    Function: refillPcTokens

    Purpose
    Refill the per-channel warm-start token bucket when its interval elapses.

    Parameters
    none

    Returns
    void
*/
function refillPcTokens() {
    const now = Date.now();
    if (now - pcLastRefill >= PC_BUDGET_REFILL_MS) {
        pcTokens = PC_BUDGET_MAX;
        pcLastRefill = now;
    }
}

/*
    Function: consumePcToken

    Purpose
    Consume a warm-start token if available.

    Parameters
    none

    Returns
    boolean
*/
function consumePcToken() {
    refillPcTokens();
    if (pcTokens > 0) {
        pcTokens -= 1;
        return true;
    }
    return false;
}

/*
    Function: refillVerifyTokens

    Purpose
    Refill the negative-verification token bucket when its interval elapses.

    Parameters
    none

    Returns
    void
*/
function refillVerifyTokens() {
    const now = Date.now();
    if (now - verifyLastRefill >= VERIFY_BUDGET_REFILL_MS) {
        verifyTokens = VERIFY_BUDGET_MAX;
        verifyLastRefill = now;
    }
}

/*
    Function: consumeVerifyToken

    Purpose
    Consume a negative-verification token if available.

    Parameters
    none

    Returns
    boolean
*/
function consumeVerifyToken() {
    refillVerifyTokens();
    if (verifyTokens > 0) {
        verifyTokens -= 1;
        return true;
    }
    return false;
}

/*
    Function: fetchWithTimeout

    Purpose
    Perform a fetch with an AbortController timeout.

    Parameters
    url: string
    opts: RequestInit
    timeoutMs: number

    Returns
    Promise<Response>
*/
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
    Function: getTokenFromStorage

    Purpose
    Read the persisted OAuth token from chrome.storage.local.

    Parameters
    none

    Returns
    Promise<object|null>
*/
async function getTokenFromStorage() {
    return new Promise(resolve => {
        chrome.storage.local.get([TOKEN_KEY], data => resolve(data[TOKEN_KEY] || null));
    });
}

/*
    Function: setTokenInStorage

    Purpose
    Persist the OAuth token to chrome.storage.local.

    Parameters
    token: object

    Returns
    Promise<void>
*/
async function setTokenInStorage(token) {
    return new Promise(resolve => chrome.storage.local.set({ [TOKEN_KEY]: token }, () => resolve()));
}

/*
    Function: clearToken

    Purpose
    Remove the OAuth token from storage.

    Parameters
    none

    Returns
    Promise<void>
*/
async function clearToken() {
    return new Promise(resolve => chrome.storage.local.remove([TOKEN_KEY], () => resolve()));
}

/*
    Function: buildAuthUrl

    Purpose
    Construct the Google OAuth implicit flow URL for this extension.

    Parameters
    promptType: string | undefined

    Returns
    string
*/
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

/*
    Function: fetchToken

    Purpose
    Launch the OAuth flow and persist the returned token.

    Parameters
    interactive: boolean
    promptType: string | undefined

    Returns
    Promise<object>
*/
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

/*
    Function: getValidToken

    Purpose
    Return a cached token if not expired.

    Parameters
    none

    Returns
    Promise<object|null>
*/
async function getValidToken() {
    const token = await getTokenFromStorage();
    if (token && token.expiry_date > Date.now()) return token;
    return null;
}

/*
    Function: ensureSubsIndexFresh

    Purpose
    Retrieve the user's subscriptions and persist them as a de-duplicated list of UC ids.

    Parameters
    force: boolean

    Returns
    Promise<boolean>

    Quota
    Uses YouTube Data API only on TTL expiry or explicit refresh.
*/
async function ensureSubsIndexFresh(force = false) {
    if (syncing) {
        logger.info("subscriptions refresh already running");
        return false;
    }
    if (!force && !isSubsIndexStale()) {
        logger.debug("subscriptions index fresh");
        return false;
    }
    const token = await getValidToken();
    if (!token) {
        logger.warn("no valid token; sign in to load subscriptions");
        return false;
    }
    syncing = true;
    logger.info("subscriptions refresh started");
    try {
        const allIds = [];
        let pageToken = "";
        let pages = 0;
        const fields = "nextPageToken,items(snippet/resourceId/channelId)";
        const base = `https://www.googleapis.com/youtube/v3/subscriptions?part=snippet&mine=true&maxResults=${SUB_LIST_BATCH}&fields=${encodeURIComponent(fields)}`;
        while (true) {
            const url = pageToken ? `${base}&pageToken=${pageToken}` : base;
            const resp = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token.access_token}` } }, 15000);
            if (!resp.ok) {
                if (resp.status === 401) {
                    await clearToken();
                    throw new Error("token expired");
                }
                throw new Error(`subscriptions api ${resp.status} ${resp.statusText}`);
            }
            const data = await resp.json();
            pages += 1;
            if (Array.isArray(data.items)) {
                for (const it of data.items) {
                    const id = it?.snippet?.resourceId?.channelId;
                    if (id && id.startsWith("UC")) allIds.push(id);
                }
            }
            logger.heartbeat("subs-progress", () => ["pages", pages, "accum", allIds.length]);
            if (data.nextPageToken) {
                pageToken = data.nextPageToken;
            } else {
                break;
            }
        }
        await setSubsIndex(allIds);
        logger.info("subscriptions synced", allIds.length);
        return true;
    } catch (e) {
        logger.error("subscriptions refresh failed", e?.message || e);
        return false;
    } finally {
        syncing = false;
    }
}

/*
    Function: findKeyInObject

    Purpose
    Recursively search an object graph for a string value under a given key name, validated by a predicate.

    Parameters
    obj: object
    keyToFind: string
    validateFn: function

    Returns
    string | null
*/
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

/*
    Function: extractChannelIdFromHtml

    Purpose
    Extract the canonical UC id from a YouTube channel page with a strict priority order that avoids
    accidental matches from nested JSON objects.

    Priority
    1) metadata.channelMetadataRenderer.channelId
    2) microformat.microformatDataRenderer.urlCanonical containing /channel/UC...
    3) <link rel="canonical" href=".../channel/UC..."> or <meta property="og:url" ...>
    4) explicit path occurrences of /channel/UC...
    5) ytcfg.set(...) objects containing a channelId
    6) deep graph search for "channelId" keys as a last resort

    Parameters
    html: string

    Returns
    string | null
*/
function extractChannelIdFromHtml(html) {
    try {
        const initialMatch = html.match(/ytInitialData\s*=\s*({.*?});/s);
        if (initialMatch) {
            const j = JSON.parse(initialMatch[1]);
            const meta = j && j.metadata && j.metadata.channelMetadataRenderer && j.metadata.channelMetadataRenderer.channelId;
            if (typeof meta === "string" && /^UC[0-9A-Za-z_-]{22}$/.test(meta)) return meta;
            const canon = j && j.microformat && j.microformat.microformatDataRenderer && j.microformat.microformatDataRenderer.urlCanonical;
            if (typeof canon === "string") {
                const m = canon.match(/\/channel\/(UC[0-9A-Za-z_-]{22})/);
                if (m) return m[1];
            }
        }
    } catch {}
    try {
        const linkCanon = html.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i);
        if (linkCanon && linkCanon[1]) {
            const m = linkCanon[1].match(/\/channel\/(UC[0-9A-Za-z_-]{22})/);
            if (m) return m[1];
        }
        const ogUrl = html.match(/<meta\s+property=["']og:url["']\s+content=["']([^"']+)["']/i);
        if (ogUrl && ogUrl[1]) {
            const m = ogUrl[1].match(/\/channel\/(UC[0-9A-Za-z_-]{22})/);
            if (m) return m[1];
        }
    } catch {}
    const path = html.match(/\/channel\/(UC[0-9A-Za-z_-]{22})/);
    if (path) return path[1];
    try {
        const cfgMatch = html.match(/ytcfg\.set\(\s*({.*?})\s*\);/s);
        if (cfgMatch) {
            const cfg = JSON.parse(cfgMatch[1]);
            const strict = findKeyInObject(cfg, "channelId", v => /^UC[0-9A-Za-z_-]{22}$/.test(v));
            if (strict) return strict;
        }
    } catch {}
    try {
        const anyMatch = html.match(/"channelId"\s*:\s*"(UC[0-9A-Za-z_-]{22})"/);
        if (anyMatch) return anyMatch[1];
    } catch {}
    try {
        const initialMatch2 = html.match(/ytInitialData\s*=\s*({.*?});/s);
        if (initialMatch2) {
            const j2 = JSON.parse(initialMatch2[1]);
            const deep = findKeyInObject(j2, "channelId", v => /^UC[0-9A-Za-z_-]{22}$/.test(v));
            if (deep) return deep;
        }
    } catch {}
    return null;
}

/*
    Function: normalizeRef

    Purpose
    Normalize any channel reference and produce robust candidate URLs, including consent and mobile hosts.

    Parameters
    ref: string

    Returns
    { kind, value, urlCandidates[] }
*/
function normalizeRef(ref) {
    let r = (ref || "").trim();
    if (!r) return { kind: "unknown", value: "", urlCandidates: [] };
    if (r.startsWith("UC") && r.length === 24) {
        return { kind: "uc", value: r, urlCandidates: [] };
    }
    if (r.startsWith("@")) {
        const clean = r.slice(1);
        const base = `https://www.youtube.com/@${clean}`;
        const mob = `https://m.youtube.com/@${clean}`;
        const con = `https://consent.youtube.com/m?continue=${encodeURIComponent(base)}`;
        return {
            kind: "handle",
            value: "@" + clean.toLowerCase(),
            urlCandidates: [base, `${base}/about`, `${base}/featured`, mob, `${mob}/about`, con]
        };
    }
    try {
        if (!/^https?:\/\//i.test(r)) {
            r = `https://www.youtube.com${r.startsWith("/") ? "" : "/"}${r}`;
        }
        const u = new URL(r);
        const host = u.hostname.replace(/^m\./, "www.");
        const path = u.pathname;
        if (/^\/channel\/(UC[0-9A-Za-z_-]{22})/.test(path)) {
            const m = path.match(/^\/channel\/(UC[0-9A-Za-z_-]{22})/);
            if (m) return { kind: "uc", value: m[1], urlCandidates: [] };
        }
        if (/^\/@[^/]+/.test(path)) {
            const h = path.split("/")[1];
            const clean = h.slice(1);
            const base = `https://${host}/@${clean}`;
            const mob = `https://m.youtube.com/@${clean}`;
            const con = `https://consent.youtube.com/m?continue=${encodeURIComponent(base)}`;
            return { kind: "handle", value: "@" + clean.toLowerCase(), urlCandidates: [base, `${base}/about`, `${base}/featured`, mob, `${mob}/about`, con] };
        }
        if (/^\/c\/[^/]+/.test(path)) {
            const name = path.split("/")[2];
            const base = `https://${host}/c/${name}`;
            const mob = `https://m.youtube.com/c/${name}`;
            const con = `https://consent.youtube.com/m?continue=${encodeURIComponent(base)}`;
            return { kind: "c", value: name, urlCandidates: [base, `${base}/about`, `${base}/featured`, mob, `${mob}/about`, con] };
        }
        if (/^\/user\/[^/]+/.test(path)) {
            const name = path.split("/")[2];
            const base = `https://${host}/user/${name}`;
            const mob = `https://m.youtube.com/user/${name}`;
            const con = `https://consent.youtube.com/m?continue=${encodeURIComponent(base)}`;
            return { kind: "user", value: name, urlCandidates: [base, `${base}/about`, `${base}/featured`, mob, `${mob}/about`, con] };
        }
        return { kind: "url", value: r, urlCandidates: [r] };
    } catch {
        return { kind: "unknown", value: r, urlCandidates: [] };
    }
}

/*
    Function: resolveUcFromHtmlCandidates

    Purpose
    Probe multiple candidates and also follow simple consent redirects where the UC id is embedded.

    Parameters
    urlCandidates: string[]

    Returns
    string|null
*/
async function resolveUcFromHtmlCandidates(urlCandidates) {
    for (const url of urlCandidates) {
        try {
            const resp = await fetchWithTimeout(url, {}, HANDLE_RESOLVE_TIMEOUT_MS);
            if (!resp.ok) continue;
            const html = await resp.text();
            const id = extractChannelIdFromHtml(html);
            if (id) return id;
            const cont = html.match(/href="(https?:\/\/www\.youtube\.com\/[^"]+)"/);
            if (cont && cont[1]) {
                const r2 = await fetchWithTimeout(cont[1], {}, HANDLE_RESOLVE_TIMEOUT_MS);
                if (r2.ok) {
                    const html2 = await r2.text();
                    const id2 = extractChannelIdFromHtml(html2);
                    if (id2) return id2;
                }
            }
        } catch {}
    }
    return null;
}

/*
    Function: searchChannelIdFallback

    Purpose
    Query YouTube Search API to get a channel id when HTML parsing fails.

    Parameters
    tokens: object returned by normalizeRef
    apiKey: string

    Returns
    string UC id or null

    Quota
    Uses search.list with type=channel and maxResults=5 under strict budget.
*/
async function searchChannelIdFallback(tokens, apiKey) {
    const candidates = [];
    if (tokens.kind === "handle") candidates.push(tokens.value);
    if (tokens.kind === "c") candidates.push(tokens.value, "@" + tokens.value);
    if (tokens.kind === "user") candidates.push(tokens.value, "@" + tokens.value);
    for (const q of candidates) {
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=5&q=${encodeURIComponent(q)}&key=${apiKey}`;
        try {
            const resp = await fetchWithTimeout(url, {}, 7000);
            if (!resp.ok) continue;
            const data = await resp.json();
            if (!data.items || !Array.isArray(data.items)) continue;
            let best = null;
            let bestScore = -1;
            const qn = q.toLowerCase();
            for (const it of data.items) {
                const id = it?.id?.channelId;
                const sn = it?.snippet || {};
                const title = (sn.channelTitle || "").toLowerCase();
                const customUrl = (sn.customUrl || "").toLowerCase();
                let score = 0;
                if (customUrl === qn) score += 100;
                if (title === qn) score += 60;
                if (customUrl.includes(qn)) score += 25;
                if (title.includes(qn)) score += 15;
                if (id && score > bestScore) {
                    best = id;
                    bestScore = score;
                }
            }
            if (best) return best;
        } catch {}
    }
    return null;
}

/*
    Function: resolveRefToUc

    Purpose
    Resolve any channel reference to a UC id using layered fallbacks and negative caching.

    Parameters
    ref: string

    Returns
    Promise<string|null>

    Side Effects
    Updates handleToChannelCache and persists caches.
*/
async function resolveRefToUc(ref) {
    const norm = normalizeRef(ref);
    const key = `${norm.kind}:${norm.value}`.toLowerCase();
    if (norm.kind === "uc") return norm.value;
    if (handleToChannelCache[key] !== undefined && handleToChannelCache[key] !== null) {
        const cached = handleToChannelCache[key];
        if (typeof cached === "object" && cached._neg) {
            const stale = Date.now() - cached.ts > NEGATIVE_CACHE_TTL_MS;
            if (!stale) {
                logger.debug("negative-cached", key);
                return null;
            }
        } else {
            logger.debug("cached", key, "=>", cached);
            return cached;
        }
    }
    logger.info("resolving", key);
    let channelId = await resolveUcFromHtmlCandidates(norm.urlCandidates);
    if (!channelId && SEARCH_API_KEY) {
        channelId = await searchChannelIdFallback(norm, SEARCH_API_KEY);
    }
    if (!channelId) {
        handleToChannelCache[key] = { _neg: true, ts: Date.now() };
        await saveCachesToStorage();
        logger.warn("resolve failed", key);
        return null;
    }
    handleToChannelCache[key] = channelId;
    await saveCachesToStorage();
    logger.info("resolved", key, "=>", channelId);
    return channelId;
}

/*
    Function: checkSubscribedPerChannel

    Purpose
    Perform a direct per-channel membership check using the YouTube Data API.

    Parameters
    channelId: string

    Returns
    Promise<boolean>
*/
async function checkSubscribedPerChannel(channelId) {
    const token = await getValidToken();
    if (!token) return false;
    const url = `https://www.googleapis.com/youtube/v3/subscriptions?part=subscriberSnippet&mine=true&forChannelId=${channelId}`;
    const resp = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token.access_token}` } }, 10000);
    if (!resp.ok) {
        if (resp.status === 401) {
            await clearToken();
            logger.warn("token expired during per-channel check");
            return false;
        }
        logger.warn("per-channel api non-ok", resp.status, resp.statusText);
        return false;
    }
    const data = await resp.json();
    const subscribed = !!(data.items && data.items.length > 0);
    cache[channelId] = { status: subscribed, updatedAt: Date.now() };
    await saveCachesToStorage();
    logger.debug("per-channel result", channelId, subscribed);
    return subscribed;
}

/*
    Function: isUserSubscribedLocal

    Purpose
    Decide membership for a given reference using the subscriptions index, with safety nets.

    Parameters
    idOrRef: string

    Returns
    Promise<boolean>
*/
async function isUserSubscribedLocal(idOrRef) {
    let channelId = idOrRef;
    if (!channelId.startsWith("UC")) {
        const resolved = await resolveRefToUc(channelId);
        if (!resolved) return false;
        channelId = resolved;
    }
    if (subsIndex.ids && subsIndex.ids.length) {
        const inSet = subsSet().has(channelId);
        logger.debug("local subs check", channelId, inSet);
        if (inSet) return true;
        const lastNeg = lastNegativeVerifyAt[channelId] || 0;
        const fresh = Date.now() - lastNeg < VERIFY_NEG_TTL_MS;
        if (!fresh && consumeVerifyToken()) {
            logger.info("negative verification", channelId);
            const verified = await checkSubscribedPerChannel(channelId);
            lastNegativeVerifyAt[channelId] = Date.now();
            if (verified && !subsSet().has(channelId)) {
                subsIndex.ids.push(channelId);
                await saveCachesToStorage();
                logger.info("negative verify found subscription; index updated");
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
    if (c && Date.now() - c.updatedAt < ONE_HOUR_MS) {
        logger.debug("legacy cache check", channelId, c.status);
        return !!c.status;
    }
    return false;
}

/*
    Function: getCurrentIdentity

    Purpose
    Return the YouTube channel id and title associated with the current token.

    Parameters
    none

    Returns
    Promise<{ channelId: string, title: string } | null>
*/
async function getCurrentIdentity() {
    const token = await getValidToken();
    if (!token) return null;
    const fields = "items(id,snippet/title)";
    const url = `https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&fields=${encodeURIComponent(fields)}`;
    const resp = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token.access_token}` } }, 10000);
    if (!resp.ok) return null;
    const data = await resp.json();
    const it = Array.isArray(data.items) && data.items[0] ? data.items[0] : null;
    if (!it || !it.id) return null;
    const title = it.snippet && it.snippet.title ? it.snippet.title : "";
    return { channelId: it.id, title };
}

/*
    Section: Message Bus

    Purpose
    Handle all content-script requests in a finite, idempotent manner.
*/
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "bulkCheckChannels") {
        const ids = Array.isArray(message.ids) ? message.ids.slice(0, 200) : [];
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
        const raw = String(message.handle || "").trim();
        const norm = normalizeRef(raw.startsWith("@") || raw.startsWith("/") ? raw : "@" + raw);
        const k1 = `${norm.kind}:${norm.value}`.toLowerCase();
        let ok = false;
        if (handleToChannelCache[k1] !== undefined) {
            delete handleToChannelCache[k1];
            ok = true;
        }
        if (handleToChannelCache[raw.toLowerCase()] !== undefined) {
            delete handleToChannelCache[raw.toLowerCase()];
            ok = true;
        }
        saveCachesToStorage().then(() => sendResponse({ ok }));
        return true;
    }
    if (message.type === "debugResolve") {
        const ref = String(message.ref || "");
        (async () => {
            const norm = normalizeRef(ref);
            let resolvedUc = null;
            if (norm.kind === "uc") {
                resolvedUc = norm.value;
            } else {
                resolvedUc = await resolveUcFromHtmlCandidates(norm.urlCandidates);
                if (!resolvedUc && SEARCH_API_KEY) {
                    resolvedUc = await searchChannelIdFallback(norm, SEARCH_API_KEY);
                }
            }
            const set = subsSet();
            const inIndex = !!(resolvedUc && set.has(resolvedUc));
            const final = resolvedUc ? (inIndex ? true : await checkSubscribedPerChannel(resolvedUc)) : false;
            sendResponse({ ref, norm, resolvedUc, inIndex, final });
        })();
        return true;
    }
    if (message.type === "whoami") {
        getCurrentIdentity().then(identity => {
            sendResponse({ ok: !!identity, identity });
        });
        return true;
    }
    if (message.type === "logout") {
        clearToken().then(() => sendResponse({ ok: true }));
        return true;
    }
    if (message.type === "reauth") {
        (async () => {
            try {
                await fetchToken(true, "select_account consent");
                const updated = await ensureSubsIndexFresh(true);
                sendResponse({ ok: updated, total: subsIndex.ids.length });
            } catch {
                sendResponse({ ok: false });
            }
        })();
        return true;
    }
    return false;
});

/*
    Section: Toolbar

    Purpose
    Authenticate with explicit account selection and force a subscriptions sync.
*/
chrome.action.onClicked.addListener(async () => {
    try {
        await fetchToken(true, "select_account consent");
        logger.info("authenticated; syncing subscriptions");
        await ensureSubsIndexFresh(true);
        logger.info("subscriptions ready", subsIndex.ids.length);
    } catch (e) {
        logger.error("auth/sync failed", e?.message || e);
    }
});
