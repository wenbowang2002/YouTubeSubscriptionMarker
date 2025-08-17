// background.js

// Import configuration for OAuth client id and API key.
import config from "./config.js";

/*
    Module: Service Worker (Background)

    Purpose
    Own OAuth, YouTube Data API access, channel reference resolution, and persistent caching. Provide low-quota,
    O(1) membership checks to the content script through a locally maintained subscriptions index.
*/

/*
    Code Block: Debug Flag

    Purpose
    Allow runtime control over verbosity and interactive debug features from chrome.storage.local.

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
    Provide a structured logger with level gating and throttled heartbeat messages.

    Inputs
    - prefix: string printed before each log line
    - level: "error" | "warn" | "info" | "debug"
    - heartbeatMs: minimum interval between heartbeat logs per tag in milliseconds

    Outputs
    - An object with { error, warn, info, debug, heartbeat } methods
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

// Create a logger instance for the background worker.
// In DEBUG: more verbose, faster heartbeat. Otherwise: warn-level, slower heartbeat.
const logger = makeLogger("[YTSM/BG]", DEBUG ? "info" : "warn", DEBUG ? 3000 : 30000);

// OAuth, API, and storage keys.
const CLIENT_ID = config.CLIENT_ID;
const SEARCH_API_KEY = config.SEARCH_API_KEY;
const REDIRECT_URI = `https://${chrome.runtime.id}.chromiumapp.org/`;
const SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"];
const TOKEN_KEY = "oauth_token";

// Time constants and TTLs.
const ONE_HOUR_MS = 60 * 60 * 1000;
const SUB_LIST_TTL_MS = 12 * 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const HANDLE_RESOLVE_TIMEOUT_MS = 8000;

// Subscriptions paging constants.
const SUB_LIST_BATCH = 50;
const SUBS_INDEX_KEY = "subscriptionsIndex";

// Token bucket budgets.
const PC_BUDGET_MAX = 20;
const PC_BUDGET_REFILL_MS = 60_000;
let pcTokens = PC_BUDGET_MAX;
let pcLastRefill = Date.now();

const VERIFY_BUDGET_MAX = 10;
const VERIFY_BUDGET_REFILL_MS = 60_000;
const VERIFY_NEG_TTL_MS = 6 * 60 * 60 * 1000;
let verifyTokens = VERIFY_BUDGET_MAX;
let verifyLastRefill = Date.now();

// In-memory caches and state flags.
let cache = {};
let handleToChannelCache = {};
let subsIndex = { updatedAt: 0, ids: [] };
let lastNegativeVerifyAt = {};
let syncing = false;

/*
    Code Block: Startup Cache Hydration

    Purpose
    Load caches from storage and, if authenticated and stale, start a background subscriptions refresh.

    Inputs
    - None (reads from chrome.storage.local)

    Outputs
    - Initializes in-memory caches and may trigger ensureSubsIndexFresh(false)
*/
chrome.storage.local.get(
    ["subscriptionCache", "handleChannelCache", SUBS_INDEX_KEY],
    data => {
        // Load legacy per-channel cache entries if present.
        if (data.subscriptionCache && typeof data.subscriptionCache === "object") {
            cache = data.subscriptionCache;
            logger.info("per-channel cache entries", Object.keys(cache).length);
        } else {
            logger.info("no legacy per-channel cache");
        }

        // Load handle/url resolution cache if present.
        if (data.handleChannelCache && typeof data.handleChannelCache === "object") {
            handleToChannelCache = data.handleChannelCache;
            logger.info("handle/url cache entries", Object.keys(handleToChannelCache).length);
        } else {
            logger.info("no handle/url cache");
        }

        // Load subscriptions index if present.
        if (data[SUBS_INDEX_KEY] && Array.isArray(data[SUBS_INDEX_KEY].ids)) {
            subsIndex = data[SUBS_INDEX_KEY];
            logger.info("subscriptions index", subsIndex.ids.length, new Date(subsIndex.updatedAt).toISOString());
        } else {
            logger.info("no subscriptions index");
        }

        // If token is valid and index is stale, trigger refresh.
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
    Persist caches atomically for consistency.

    Inputs
    - None (uses module-level caches)

    Outputs
    - Promise<void>
*/
async function saveCachesToStorage() {
    // Persist all caches under distinct keys.
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
    Determine if the subscriptions index TTL has expired.

    Inputs
    - None

    Outputs
    - boolean
*/
function isSubsIndexStale() {
    // Compare current time against last updated timestamp.
    return !subsIndex.updatedAt || Date.now() - subsIndex.updatedAt > SUB_LIST_TTL_MS;
}

/*
    Function: setSubsIndex

    Purpose
    Replace the subscriptions index with a de-duplicated list and timestamp.

    Inputs
    - ids: string[] of UC channel IDs

    Outputs
    - Promise<void>
*/
function setSubsIndex(ids) {
    // Stamp updated time and remove duplicates.
    subsIndex = { updatedAt: Date.now(), ids: Array.from(new Set(ids)) };
    return saveCachesToStorage();
}

/*
    Function: subsSet

    Purpose
    Expose a Set view of the current subscription IDs.

    Inputs
    - None

    Outputs
    - Set<string>
*/
function subsSet() {
    // Convert index array to a Set for O(1) lookups.
    return new Set(subsIndex.ids);
}

/*
    Function: refillPcTokens

    Purpose
    Refill the per-channel token bucket on interval.

    Inputs
    - None

    Outputs
    - void
*/
function refillPcTokens() {
    // If interval elapsed, refill and move the window.
    const now = Date.now();
    if (now - pcLastRefill >= PC_BUDGET_REFILL_MS) {
        pcTokens = PC_BUDGET_MAX;
        pcLastRefill = now;
    }
}

/*
    Function: consumePcToken

    Purpose
    Attempt to consume a per-channel token.

    Inputs
    - None

    Outputs
    - boolean
*/
function consumePcToken() {
    // Ensure tokens are current, then spend if available.
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
    Refill the negative-verification token bucket on interval.

    Inputs
    - None

    Outputs
    - void
*/
function refillVerifyTokens() {
    // If interval elapsed, refill and move the window.
    const now = Date.now();
    if (now - verifyLastRefill >= VERIFY_BUDGET_REFILL_MS) {
        verifyTokens = VERIFY_BUDGET_MAX;
        verifyLastRefill = now;
    }
}

/*
    Function: consumeVerifyToken

    Purpose
    Attempt to consume a verification token.

    Inputs
    - None

    Outputs
    - boolean
*/
function consumeVerifyToken() {
    // Ensure tokens are current, then spend if available.
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
    Perform a fetch with an abort controller timeout.

    Inputs
    - url: string
    - opts: RequestInit
    - timeoutMs: number

    Outputs
    - Promise<Response>
*/
async function fetchWithTimeout(url, opts = {}, timeoutMs = HANDLE_RESOLVE_TIMEOUT_MS) {
    // Create controller and program a timeout abort.
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);

    // Run fetch with signal and follow redirects; always clear timer.
    try {
        return await fetch(url, { ...opts, signal: controller.signal, redirect: "follow" });
    } finally {
        clearTimeout(id);
    }
}

/*
    Function: getTokenFromStorage

    Purpose
    Read OAuth token from chrome.storage.local.

    Inputs
    - None

    Outputs
    - Promise<object|null>
*/
async function getTokenFromStorage() {
    // Fetch the token record; default to null.
    return new Promise(resolve => {
        chrome.storage.local.get([TOKEN_KEY], data => resolve(data[TOKEN_KEY] || null));
    });
}

/*
    Function: setTokenInStorage

    Purpose
    Persist OAuth token object.

    Inputs
    - token: object with { access_token, expiry_date }

    Outputs
    - Promise<void>
*/
async function setTokenInStorage(token) {
    // Write token to storage under a single key.
    return new Promise(resolve => chrome.storage.local.set({ [TOKEN_KEY]: token }, () => resolve()));
}

/*
    Function: clearToken

    Purpose
    Remove the persisted OAuth token.

    Inputs
    - None

    Outputs
    - Promise<void>
*/
async function clearToken() {
    // Delete token key for a clean re-auth.
    return new Promise(resolve => chrome.storage.local.remove([TOKEN_KEY], () => resolve()));
}

/*
    Function: buildAuthUrl

    Purpose
    Construct the Google OAuth implicit flow URL.

    Inputs
    - promptType: optional prompt parameter (e.g., "consent")

    Outputs
    - string URL
*/
function buildAuthUrl(promptType) {
    // Encode OAuth params and append optional prompt.
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
    Launch OAuth flow, parse returned token, and persist it.

    Inputs
    - interactive: boolean to allow UI
    - promptType: string for prompt behavior

    Outputs
    - Promise<object> token object
*/
async function fetchToken(interactive, promptType) {
    // Build the auth URL once.
    const authUrl = buildAuthUrl(promptType);

    // Launch the flow and parse token from the redirect fragment.
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

            // Persist token with absolute expiry.
            const tokenObj = { access_token, expiry_date: Date.now() + expires_in * 1000 };
            await setTokenInStorage(tokenObj);
            resolve(tokenObj);
        });
    });
}

/*
    Function: getValidToken

    Purpose
    Return a non-expired token or null.

    Inputs
    - None

    Outputs
    - Promise<object|null>
*/
async function getValidToken() {
    // Read token and check expiry.
    const token = await getTokenFromStorage();
    if (token && token.expiry_date > Date.now()) return token;
    return null;
}

/*
    Function: ensureSubsIndexFresh

    Purpose
    Refresh the user's subscriptions index via YouTube Data API paging under TTL or force.

    Inputs
    - force: boolean to ignore TTL

    Outputs
    - Promise<boolean> true on successful refresh
*/
async function ensureSubsIndexFresh(force = false) {
    // Prevent concurrent runs and skip if fresh unless forced.
    if (syncing) {
        logger.info("subscriptions refresh already running");
        return false;
    }
    if (!force && !isSubsIndexStale()) {
        logger.debug("subscriptions index fresh");
        return false;
    }

    // Require a valid token to proceed.
    const token = await getValidToken();
    if (!token) {
        logger.warn("no valid token; sign in to load subscriptions");
        return false;
    }

    // Iterate over paginated results to collect all UC IDs.
    syncing = true;
    logger.info("subscriptions refresh started");
    try {
        const allIds = [];
        let pageToken = "";
        let pages = 0;
        const fields = "nextPageToken,items(snippet/resourceId/channelId)";
        const base = `https://www.googleapis.com/youtube/v3/subscriptions?part=snippet&mine=true&maxResults=${SUB_LIST_BATCH}&fields=${encodeURIComponent(fields)}`;

        while (true) {
            // Request next page and handle authorization problems.
            const url = pageToken ? `${base}&pageToken=${pageToken}` : base;
            const resp = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token.access_token}` } }, 15000);
            if (!resp.ok) {
                if (resp.status === 401) {
                    await clearToken();
                    throw new Error("token expired");
                }
                throw new Error(`subscriptions api ${resp.status} ${resp.statusText}`);
            }

            // Append channel IDs from this page.
            const data = await resp.json();
            pages += 1;
            if (Array.isArray(data.items)) {
                for (const it of data.items) {
                    const id = it?.snippet?.resourceId?.channelId;
                    if (id && id.startsWith("UC")) allIds.push(id);
                }
            }

            // Emit progress and continue if more pages exist.
            logger.heartbeat("subs-progress", () => ["pages", pages, "accum", allIds.length]);
            if (data.nextPageToken) {
                pageToken = data.nextPageToken;
            } else {
                break;
            }
        }

        // Deduplicate and persist the final index.
        await setSubsIndex(allIds);
        logger.info("subscriptions synced", allIds.length);
        return true;
    } catch (e) {
        // Surface failure without throwing through the bus.
        logger.error("subscriptions refresh failed", e?.message || e);
        return false;
    } finally {
        // Always clear the syncing flag.
        syncing = false;
    }
}

/*
    Function: findKeyInObject

    Purpose
    Recursively search an object graph for a key with a string value passing an optional validator.

    Inputs
    - obj: object to search
    - keyToFind: string key name
    - validateFn: function(string) => boolean (optional)

    Outputs
    - string|null value found
*/
function findKeyInObject(obj, keyToFind, validateFn) {
    // If not an object, stop search.
    if (typeof obj !== "object" || obj === null) return null;

    // Iterate own properties, check match or recurse into child objects.
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
    Extract the canonical UC channel id from raw YouTube channel HTML using layered heuristics.

    Inputs
    - html: string of HTML content

    Outputs
    - string|null UC id
*/
function extractChannelIdFromHtml(html) {
    // Preferred: ytInitialData metadata.channelMetadataRenderer.channelId.
    try {
        const initialMatch = html.match(/ytInitialData\s*=\s*({.*?});/s);
        if (initialMatch) {
            const j = JSON.parse(initialMatch[1]);
            const meta = j && j.metadata && j.metadata.channelMetadataRenderer && j.metadata.channelMetadataRenderer.channelId;
            if (typeof meta === "string" && /^UC[0-9A-Za-z_-]{22}$/.test(meta)) return meta;

            // Fallback: microformat canonical channel URL.
            const canon = j && j.microformat && j.microformat.microformatDataRenderer && j.microformat.microformatDataRenderer.urlCanonical;
            if (typeof canon === "string") {
                const m = canon.match(/\/channel\/(UC[0-9A-Za-z_-]{22})/);
                if (m) return m[1];
            }
        }
    } catch {}

    // Secondary: <link rel="canonical"> and <meta property="og:url"> checks.
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

    // Simple path scan for "/channel/UC..." pattern.
    const path = html.match(/\/channel\/(UC[0-9A-Za-z_-]{22})/);
    if (path) return path[1];

    // ytcfg.set(...) object search for a strict channelId value.
    try {
        const cfgMatch = html.match(/ytcfg\.set\(\s*({.*?})\s*\);/s);
        if (cfgMatch) {
            const cfg = JSON.parse(cfgMatch[1]);
            const strict = findKeyInObject(cfg, "channelId", v => /^UC[0-9A-Za-z_-]{22}$/.test(v));
            if (strict) return strict;
        }
    } catch {}

    // As a last resort, search for "channelId" keys anywhere.
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

    // No match found.
    return null;
}

/*
    Function: normalizeRef

    Purpose
    Normalize a channel reference (UC id, @handle, /c, /user, absolute/relative URL) and produce URL candidates.

    Inputs
    - ref: string channel reference

    Outputs
    - { kind: string, value: string, urlCandidates: string[] }
*/
function normalizeRef(ref) {
    // Clean and fast-path empty and UC id inputs.
    let r = (ref || "").trim();
    if (!r) return { kind: "unknown", value: "", urlCandidates: [] };
    if (r.startsWith("UC") && r.length === 24) {
        return { kind: "uc", value: r, urlCandidates: [] };
    }

    // Handle @handle by building base, mobile, and consent variants.
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

    // Normalize paths to absolute URLs and unify host; classify known patterns.
    try {
        if (!/^https?:\/\//i.test(r)) {
            r = `https://www.youtube.com${r.startsWith("/") ? "" : "/"}${r}`;
        }
        const u = new URL(r);
        const host = u.hostname.replace(/^m\./, "www.");
        const path = u.pathname;

        // Detect /channel/UC..., /@..., /c/..., /user/... and assemble candidates.
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

        // Otherwise treat as a raw URL candidate.
        return { kind: "url", value: r, urlCandidates: [r] };
    } catch {
        // Malformed input; mark unknown.
        return { kind: "unknown", value: r, urlCandidates: [] };
    }
}

/*
    Function: resolveUcFromHtmlCandidates

    Purpose
    Fetch multiple URL candidates and extract a UC id by parsing HTML; follows simple consent redirects.

    Inputs
    - urlCandidates: string[] list of URLs to try

    Outputs
    - Promise<string|null> UC id or null
*/
async function resolveUcFromHtmlCandidates(urlCandidates) {
    // Iterate through candidates in order.
    for (const url of urlCandidates) {
        try {
            // Fetch HTML and parse for a UC id.
            const resp = await fetchWithTimeout(url, {}, HANDLE_RESOLVE_TIMEOUT_MS);
            if (!resp.ok) continue;
            const html = await resp.text();
            const id = extractChannelIdFromHtml(html);
            if (id) return id;

            // Detect consent "continue" link and follow once.
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
    // Return null if none yielded a UC id.
    return null;
}

/*
    Function: searchChannelIdFallback

    Purpose
    Use the YouTube Search API to infer a UC id when HTML parsing fails.

    Inputs
    - tokens: normalized reference object from normalizeRef
    - apiKey: YouTube Data API key

    Outputs
    - Promise<string|null> UC id or null
*/
async function searchChannelIdFallback(tokens, apiKey) {
    // Prepare search terms from handle or custom identifiers.
    const candidates = [];
    if (tokens.kind === "handle") candidates.push(tokens.value);
    if (tokens.kind === "c") candidates.push(tokens.value, "@" + tokens.value);
    if (tokens.kind === "user") candidates.push(tokens.value, "@" + tokens.value);

    // Query for each candidate and score best matches.
    for (const q of candidates) {
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=5&q=${encodeURIComponent(q)}&key=${apiKey}`;
        try {
            const resp = await fetchWithTimeout(url, {}, 7000);
            if (!resp.ok) continue;
            const data = await resp.json();
            if (!data.items || !Array.isArray(data.items)) continue;

            // Score by exact/contains matches of customUrl and title.
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
    // No suitable match found.
    return null;
}

/*
    Function: resolveRefToUc

    Purpose
    Resolve any channel reference into a UC id using cache, HTML probing, and search fallback.

    Inputs
    - ref: string reference (UC/@/c/user/URL)

    Outputs
    - Promise<string|null> UC id or null
*/
async function resolveRefToUc(ref) {
    // Normalize reference and check immediate UC fast path.
    const norm = normalizeRef(ref);
    const key = `${norm.kind}:${norm.value}`.toLowerCase();
    if (norm.kind === "uc") return norm.value;

    // Consult cache; honor negative cache TTL.
    if (handleToChannelCache[key] !== undefined && handleToChannelCache[key] !== null) {
        const cached = handleToChannelCache[key];
        if (typeof cached === "object" && cached._neg) {
            const stale = Date.now() - cached.ts > NEGATIVE_CACHE_TTL_MS;
            if (!stale) {
                logger.debug("negative-cached", key);
                return null;
            }
        } else {
            // In DEBUG we surface more; otherwise keep it quiet at debug level.
            if (DEBUG) logger.info("cached", key, "=>", cached); else logger.debug("cached", key, "=>", cached);
            return cached;
        }
    }

    // Try HTML resolution and then API search fallback.
    if (DEBUG) logger.info("resolving", key); else logger.debug("resolving", key);
    let channelId = await resolveUcFromHtmlCandidates(norm.urlCandidates);
    if (!channelId && SEARCH_API_KEY) {
        channelId = await searchChannelIdFallback(norm, SEARCH_API_KEY);
    }

    // Cache negative result to avoid repeated work.
    if (!channelId) {
        handleToChannelCache[key] = { _neg: true, ts: Date.now() };
        await saveCachesToStorage();
        logger.warn("resolve failed", key);
        return null;
    }

    // Cache and persist positive mapping.
    handleToChannelCache[key] = channelId;
    await saveCachesToStorage();
    if (DEBUG) logger.info("resolved", key, "=>", channelId); else logger.debug("resolved", key, "=>", channelId);
    return channelId;
}

/*
    Function: checkSubscribedPerChannel

    Purpose
    Perform an exact membership check for a specific UC id via the Subscriptions API.

    Inputs
    - channelId: string UC id

    Outputs
    - Promise<boolean> subscribed
*/
async function checkSubscribedPerChannel(channelId) {
    // Require a valid token; otherwise false.
    const token = await getValidToken();
    if (!token) return false;

    // Call subscriptions endpoint scoped to the channel id.
    const url = `https://www.googleapis.com/youtube/v3/subscriptions?part=subscriberSnippet&mine=true&forChannelId=${channelId}`;
    const resp = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token.access_token}` } }, 10000);

    // Handle token expiration and other non-OK statuses.
    if (!resp.ok) {
        if (resp.status === 401) {
            await clearToken();
            logger.warn("token expired during per-channel check");
            return false;
        }
        logger.warn("per-channel api non-ok", resp.status, resp.statusText);
        return false;
    }

    // Interpret presence of items as "subscribed".
    const data = await resp.json();
    const subscribed = !!(data.items && data.items.length > 0);

    // Update short-lived cache and persist.
    cache[channelId] = { status: subscribed, updatedAt: Date.now() };
    await saveCachesToStorage();
    logger.debug("per-channel result", channelId, subscribed);
    return subscribed;
}

/*
    Function: isUserSubscribedLocal

    Purpose
    Answer membership questions using the local subscriptions index first, with verification fallbacks.

    Inputs
    - idOrRef: string UC id or reference

    Outputs
    - Promise<boolean> subscribed
*/
async function isUserSubscribedLocal(idOrRef) {
    // Resolve any non-UC reference to UC id.
    let channelId = idOrRef;
    if (!channelId.startsWith("UC")) {
        const resolved = await resolveRefToUc(channelId);
        if (!resolved) return false;
        channelId = resolved;
    }

    // Prefer the fast local index when present.
    if (subsIndex.ids && subsIndex.ids.length) {
        const inSet = subsSet().has(channelId);
        logger.debug("local subs check", channelId, inSet);
        if (inSet) return true;

        // Occasionally re-verify negatives within a budget.
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

    // If index is absent and stale, use a budgeted per-channel call during warm start.
    if (isSubsIndexStale() && consumePcToken()) {
        try {
            return await checkSubscribedPerChannel(channelId);
        } catch {
            return false;
        }
    }

    // Fall back to recent legacy per-channel cache if fresh.
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
    Retrieve the authenticated user's YouTube channel id and title.

    Inputs
    - None

    Outputs
    - Promise<{ channelId: string, title: string } | null>
*/
async function getCurrentIdentity() {
    // Require authentication.
    const token = await getValidToken();
    if (!token) return null;

    // Request minimal identity fields for the current user.
    const fields = "items(id,snippet/title)";
    const url = `https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&fields=${encodeURIComponent(fields)}`;
    const resp = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token.access_token}` } }, 10000);
    if (!resp.ok) return null;

    // Parse first channel record into a compact identity object.
    const data = await resp.json();
    const it = Array.isArray(data.items) && data.items[0] ? data.items[0] : null;
    if (!it || !it.id) return null;
    const title = it.snippet && it.snippet.title ? it.snippet.title : "";
    return { channelId: it.id, title };
}

/*
    Code Block: Message Bus Listener

    Purpose
    Handle all incoming messages from the content script in a finite, idempotent manner.

    Inputs
    - message: object with a "type" field and optional payload
    - sender: chrome runtime sender
    - sendResponse: callback to return a response

    Outputs
    - boolean to keep the channel open when necessary
*/
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Batch membership checks for up to 200 ids/refs.
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

    // Single membership check.
    if (message.type === "checkChannel") {
        const { channelId } = message;
        isUserSubscribedLocal(channelId)
            .then(subscribed => sendResponse({ subscribed }))
            .catch(() => sendResponse({ subscribed: false }));
        return true;
    }

    // Return cached short-lived per-channel status if available.
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

    // Report authentication state quickly.
    if (message.type === "checkAuth") {
        getValidToken().then(token => sendResponse({ authenticated: !!token }));
        return true;
    }

    // Force subscriptions refresh and return summary.
    if (message.type === "refreshSubscriptions") {
        ensureSubsIndexFresh(true).then(updated => {
            sendResponse({ ok: updated, total: subsIndex.ids.length, updatedAt: subsIndex.updatedAt });
        });
        return true;
    }

    // Invalidate cached handle/url mapping to force re-resolve next time.
    if (message.type === "invalidateHandle") {
        const raw = String(message.handle || "").trim();
        const norm = normalizeRef(raw.startsWith("@") || raw.startsWith("/") ? raw : "@" + raw);
        const k1 = `${norm.kind}:${norm.value}`.toLowerCase();
        let ok = false;

        // Delete canonicalized key and raw-lowercased key if present.
        if (handleToChannelCache[k1] !== undefined) {
            delete handleToChannelCache[k1];
            ok = true;
        }
        if (handleToChannelCache[raw.toLowerCase()] !== undefined) {
            delete handleToChannelCache[raw.toLowerCase()];
            ok = true;
        }

        // Persist and respond.
        saveCachesToStorage().then(() => sendResponse({ ok }));
        return true;
    }

    // Debug helper: resolve a ref and check membership.
    if (message.type === "debugResolve") {
        const ref = String(message.ref || "");
        (async () => {
            const norm = normalizeRef(ref);
            let resolvedUc = null;

            // Resolve UC id via fast-path or fallbacks.
            if (norm.kind === "uc") {
                resolvedUc = norm.value;
            } else {
                resolvedUc = await resolveUcFromHtmlCandidates(norm.urlCandidates);
                if (!resolvedUc && SEARCH_API_KEY) {
                    resolvedUc = await searchChannelIdFallback(norm, SEARCH_API_KEY);
                }
            }

            // Determine membership using index or API.
            const set = subsSet();
            const inIndex = !!(resolvedUc && set.has(resolvedUc));
            const final = resolvedUc ? (inIndex ? true : await checkSubscribedPerChannel(resolvedUc)) : false;
            sendResponse({ ref, norm, resolvedUc, inIndex, final });
        })();
        return true;
    }

    // Report the current authenticated identity.
    if (message.type === "whoami") {
        getCurrentIdentity().then(identity => {
            sendResponse({ ok: !!identity, identity });
        });
        return true;
    }

    // Explicit logout clears token.
    if (message.type === "logout") {
        clearToken().then(() => sendResponse({ ok: true }));
        return true;
    }

    // Reauth and sync subscription index.
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

    // Unhandled type: do not consume.
    return false;
});

/*
    Code Block: Toolbar Click Handler

    Purpose
    When the toolbar icon is clicked, prompt auth and perform a fresh subscriptions sync.

    Inputs
    - Click event from chrome.action

    Outputs
    - None (side effects: token and index updated)
*/
chrome.action.onClicked.addListener(async () => {
    // Wrap in try/catch for UX resilience.
    try {
        await fetchToken(true, "select_account consent");
        logger.info("authenticated; syncing subscriptions");
        await ensureSubsIndexFresh(true);
        logger.info("subscriptions ready", subsIndex.ids.length);
    } catch (e) {
        logger.error("auth/sync failed", e?.message || e);
    }
});
