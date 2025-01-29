// background.js

import config from "./config.js";

const CLIENT_ID = config.CLIENT_ID;
const REDIRECT_URI = `https://${chrome.runtime.id}.chromiumapp.org/`;
const SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"];
const TOKEN_KEY = "oauth_token";
const SEARCH_API_KEY = config.SEARCH_API_KEY;

const ONE_HOUR_MS = 60 * 60 * 1000;

// caches for subscription & handle lookups
let cache = {};
let handleToChannelCache = {};

// loads caches from storage on startup
chrome.storage.local.get(["subscriptionCache", "handleChannelCache"], data => {
    if (data.subscriptionCache && typeof data.subscriptionCache === 'object') {
        cache = data.subscriptionCache;
        console.log("loaded subscription cache from storage, size:", Object.keys(cache).length);
    }
    else {
        console.log("no subscription cache found, starting fresh.");
    }
    if (data.handleChannelCache && typeof data.handleChannelCache === 'object') {
        handleToChannelCache = data.handleChannelCache;
        console.log("loaded handle channel cache from storage, size:", Object.keys(handleToChannelCache).length);
    }
    else {
        console.log("no handle channel cache found, starting fresh.");
    }
});

async function saveCachesToStorage() {
    return new Promise(resolve => {
        chrome.storage.local.set({
            subscriptionCache: cache,
            handleChannelCache: handleToChannelCache
        }, () => {
            console.log("caches saved to storage.");
            resolve();
        });
    });
}

function findKeyInObject(obj, keyToFind, validateFn) {
    if (typeof obj !== 'object' || obj === null) return null;
    for (const key in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
        const value = obj[key];
        if (key === keyToFind && typeof value === 'string' && (!validateFn || validateFn(value))) {
            return value;
        }
        if (typeof value === 'object' && value !== null) {
            const result = findKeyInObject(value, keyToFind, validateFn);
            if (result) return result;
        }
    }
    return null;
}

async function getTokenFromStorage() {
    return new Promise(resolve => {
        chrome.storage.local.get([TOKEN_KEY], data => {
            resolve(data[TOKEN_KEY] || null);
        });
    });
}

async function setTokenInStorage(token) {
    return new Promise(resolve => {
        chrome.storage.local.set({ [TOKEN_KEY]: token }, () => {
            resolve();
        });
    });
}

async function clearToken() {
    return new Promise(resolve => {
        chrome.storage.local.remove([TOKEN_KEY], () => resolve());
    });
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
        chrome.identity.launchWebAuthFlow({ url: authUrl, interactive }, async (redirectUrl) => {
            if (chrome.runtime.lastError || !redirectUrl) {
                return reject(chrome.runtime.lastError || new Error("no redirect url"));
            }
            const fragments = redirectUrl.split('#')[1];
            if (!fragments) return reject(new Error("no fragment in redirect url"));
            const params = new URLSearchParams(fragments);
            const access_token = params.get('access_token');
            const expires_in = parseInt(params.get('expires_in'), 10);
            if (!access_token) return reject(new Error("no access token found"));
            const tokenObj = { access_token, expiry_date: Date.now() + expires_in * 1000 };
            await setTokenInStorage(tokenObj);
            resolve(tokenObj);
        });
    });
}

async function getValidToken() {
    const token = await getTokenFromStorage();
    if (token && token.expiry_date > Date.now()) {
        return token;
    }
    return null;
}

// fallback search using youtube data api
async function searchForHandleChannelId(handle) {
    console.log("attempting search fallback for handle:", handle);
    const query = handle.startsWith('@') ? handle.slice(1) : handle;
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(query)}&key=${SEARCH_API_KEY}`;
    const resp = await fetch(url);
    if (!resp.ok) {
        console.log("non-ok response from search api:", resp.status, resp.statusText);
        return null;
    }
    const data = await resp.json();
    if (data.items && data.items.length > 0) {
        const channelId = data.items[0].id.channelId;
        console.log("found channelId via search fallback for handle:", handle, channelId);
        return channelId;
    }
    console.log("no search results for handle:", handle);
    return null;
}

async function resolveHandleToChannelId(handle) {
    console.log("attempting to resolve handle:", handle);
    if (handleToChannelCache[handle] !== undefined) {
        console.log("returning cached channelId for handle:", handle, handleToChannelCache[handle]);
        return handleToChannelCache[handle];
    }
    let rawHandle = handle;
    if (rawHandle.includes('%')) {
        try {
            const part = rawHandle.startsWith('@') ? rawHandle.slice(1) : rawHandle;
            const decodedPart = decodeURIComponent(part);
            rawHandle = rawHandle.startsWith('@') ? '@' + decodedPart : decodedPart;
        } catch (e) {
            console.warn("decoding handle failed, using handle as-is:", handle, e);
            rawHandle = handle;
        }
    }
    const url = `https://www.youtube.com/${rawHandle}`;
    console.log("fetching handle page at:", url);
    const resp = await fetch(url);
    if (!resp.ok) {
        console.log("non-ok response fetching handle page:", resp.status, resp.statusText);
        return null;
    }
    const text = await resp.text();
    const dataMatch = text.match(/ytInitialData\s*=\s*(\{.*?\});/s);
    let channelId = null;
    if (dataMatch) {
        try {
            const jsonData = JSON.parse(dataMatch[1]);
            if (jsonData.metadata && jsonData.metadata.channelMetadataRenderer && jsonData.metadata.channelMetadataRenderer.channelId) {
                channelId = jsonData.metadata.channelMetadataRenderer.channelId;
            }
            if (!channelId && jsonData.microformat && jsonData.microformat.microformatDataRenderer && jsonData.microformat.microformatDataRenderer.urlCanonical) {
                const urlC = jsonData.microformat.microformatDataRenderer.urlCanonical;
                const match = urlC.match(/\/channel\/(UC[0-9A-Za-z_-]+)/);
                if (match) channelId = match[1];
            }
            if (!channelId) {
                channelId = findKeyInObject(jsonData, "channelId", val => val.startsWith("UC"));
            }
        } catch (e) {
            console.error("error parsing ytInitialData:", e);
        }
    }
    else {
        console.log("no ytInitialData in channel page for handle:", rawHandle);
    }
    if (!channelId) {
        channelId = await searchForHandleChannelId(handle);
    }
    handleToChannelCache[handle] = channelId || null;
    await saveCachesToStorage();
    console.log("resolved handle:", handle, "to channelId:", channelId);
    return channelId;
}

async function isUserSubscribed(channelId) {
    console.log("checking subscription for channel:", channelId);
    if (channelId.startsWith('@')) {
        const realId = await resolveHandleToChannelId(channelId);
        if (!realId) {
            throw new Error(`could not resolve handle ${channelId} to a channel id`);
        }
        channelId = realId;
    }

    let cachedEntry = cache[channelId];
    if (cachedEntry !== undefined && cachedEntry !== null) {
        const { status, updatedAt } = cachedEntry;

        if (Date.now() - updatedAt < ONE_HOUR_MS) {
            console.log(
                `Using cached subscription status for ${channelId}: ${status}`
            );
            return status;
        } else {
            console.log(
                `Cache entry for ${channelId} is older than 24 hours; re-checking.`
            );
        }
    }

    const token = await getValidToken();
    if (!token) {
        console.log("user not authenticated, cannot check subscription");
        throw new Error("not authenticated");
    }
    const url = `https://www.googleapis.com/youtube/v3/subscriptions?part=subscriberSnippet&mine=true&forChannelId=${channelId}`;
    console.log("subscription api call for:", channelId, url);
    const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!resp.ok) {
        console.log("non-ok response from subscriptions.list:", resp.status, resp.statusText);
        if (resp.status === 401) {
            await clearToken();
            throw new Error("token expired, please authenticate again.");
        }
        throw new Error(`api error: ${resp.statusText}`);
    }
    const data = await resp.json();
    const subscribed = data.items && data.items.length > 0;

    // Save new status + timestamp in the cache
    cache[channelId] = {
        status: subscribed,
        updatedAt: Date.now(),
    };

    await saveCachesToStorage();
    return subscribed;
}

// handles messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "checkChannel") {
        const { channelId } = message;
        if (cache[channelId] !== undefined) {
            sendResponse({ subscribed: cache[channelId], fromCache: true });
            return true;
        }
        isUserSubscribed(channelId).then(subscribed => {
            sendResponse({ subscribed });
        }).catch(err => {
            console.error("error checking subscription:", err.message);
            if (err.message.includes("not authenticated")) {
                sendResponse({ notAuthenticated: true });
            }
            else {
                sendResponse({ error: err.message });
            }
        });
        return true;
    }
    if (message.type === "getCachedStatus") {
        const { channelId } = message;
        if (cache[channelId] !== undefined) {
            sendResponse({ status: cache[channelId] });
        }
        else {
            sendResponse({});
        }
        return true;
    }
    if (message.type === "checkAuth") {
        getValidToken().then(token => {
            sendResponse({ authenticated: !!token });
        });
        return true;
    }
    return false;
});

// listens for clicks on the extension action
chrome.action.onClicked.addListener(async () => {
    try {
        await fetchToken(true, "consent");
        console.log("user authenticated successfully!");
    } catch (e) {
        console.error("user failed to authenticate:", e);
    }
});