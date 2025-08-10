# YouTube Subscription Marker

This Chrome extension adds a small subscription marker icon next to YouTube channel names when the authenticated user is subscribed to that channel.

Subscription status is determined using:

- Bulk retrieval of the user's subscriptions from the YouTube Data API v3
- A local, persistent index for O(1) membership checks
- Strict HTML parsing of channel pages to resolve `@handles`, vanity `/c/...` and legacy `/user/...` links to canonical `UC...` channel IDs
- A minimal Search API fallback under strict budgets
- Negative result caching and occasional re-verification to maintain accuracy with low quota usage

The extension continuously observes the page DOM, so markers appear automatically as you scroll on YouTube.

---

## Features

- **Visible marker next to subscribed channels** across most YouTube surfaces (home, watch, search results, subscriptions feed, grids, compacts, shorts overlays).
- **Low-quota design**: Uses a local subscription index and HTML parsing first; falls back to minimal API checks only when required.
- **Robust channel resolution**: Supports `@handle`, `/channel/UC...`, `/c/...`, `/user/...`, and full `https://youtube.com/...` URLs including mobile and consent hosts.
- **Persistent caching** in `chrome.storage.local` for subscriptions, per-channel membership results, and handle → UC mappings.
- **Occasional negative verification**: Re-checks "not subscribed" answers under a small budget to correct rare mismatches.
- **Automatic operation**: Runs continuously and marks new elements as they appear in the DOM.

---

## Requirements

- A Google account with YouTube access.
- A Google Cloud project with **YouTube Data API v3** enabled.
- OAuth 2.0 **Client ID** (Web application) for authentication.
- **API key** for fallback channel search (used rarely).

---

## Google Cloud API Setup

1. Go to **Google Cloud Console**: https://console.cloud.google.com/
2. Create a new project or select an existing one.
3. Enable the **YouTube Data API v3** under **APIs & Services → Library**.
4. Create credentials under **APIs & Services → Credentials**:
   - **OAuth 2.0 Client ID** (Application type: Web application). Add this **Authorized redirect URI**:
     ```
     https://<your-extension-id>.chromiumapp.org/
     ```

     Replace `<your-extension-id>` with the actual extension ID from `chrome://extensions/` (Developer mode).
   - **API key** (for fallback channel search).
5. Save the **Client ID** and **API key** for the extension configuration.

---

## Installation

1. Clone or download this repository.
2. Create a `config.js` in the extension root:
   ```js
   export default {
       CLIENT_ID: "YOUR_OAUTH_CLIENT_ID",
       SEARCH_API_KEY: "YOUR_API_KEY"
   };
   ```
3. Open `chrome://extensions/` in Chrome.
4. Enable **Developer mode**.
5. Click **Load unpacked** and select the extension directory.

---

## Usage

1. Click the extension icon in the toolbar and authenticate with your Google account.
2. Browse YouTube — subscribed channels will be marked automatically.
3. Markers update as you scroll, without reloading the page.

---

## Tunable Parameters

### background.js

| Parameter                     | Description                                            | Default value       |
| ----------------------------- | ------------------------------------------------------ | ------------------- |
| `SUB_LIST_TTL_MS`           | Time before the subscription list cache expires.       | 43200000 (12 hours) |
| `SUB_LIST_BATCH`            | Max subscriptions retrieved per API call.              | 50                  |
| `HANDLE_RESOLVE_TIMEOUT_MS` | Timeout for HTML fetches when resolving handles.       | 8000 ms             |
| `NEGATIVE_CACHE_TTL_MS`     | Cache lifetime for failed resolutions before retry.    | 21600000 (6 hours)  |
| `PC_BUDGET_MAX`             | Max per-channel API checks allowed per refill window.  | 20                  |
| `PC_BUDGET_REFILL_MS`       | Time to refill per-channel check budget.               | 60000 ms            |
| `VERIFY_BUDGET_MAX`         | Max negative verification calls per refill window.     | 10                  |
| `VERIFY_BUDGET_REFILL_MS`   | Time to refill negative verification budget.           | 60000 ms            |
| `VERIFY_NEG_TTL_MS`         | Cooldown before re-verifying a non-subscribed channel. | 21600000 (6 hours)  |

### content.js

| Parameter            | Description                                      | Default value |
| -------------------- | ------------------------------------------------ | ------------- |
| `BULK_INTERVAL_MS` | Minimum interval between bulk channel ID checks. | 1000 ms       |
| `MAX_IDS_PER_BULK` | Max channel IDs sent in a single bulk check.     | 100           |

---

## Logging

- Logging is structured with severity levels: `info`, `warn`, `error`.
- Excessively detailed debug logs are disabled by default to minimize console noise.
- Errors and key state changes are always logged.

---

## Debugging Aids

- `window.postMessage({ type: "YTSM_DEBUG_RESOLVE", ref: "<handle-or-url>" })` from the page console sends a debug resolution request.
- Invalidate a cached mapping:
  ```js
  window.postMessage({ type: "YTSM_INVALIDATE", ref: "<handle-or-url>" });
  ```

---

## Quota Strategy

- Uses a single bulk subscription list retrieval every `SUB_LIST_TTL_MS` (default 12 hours).
- Falls back to per-channel checks only when bulk data is missing.
- Negative caches prevent repeated queries for non-subscribed channels within the cooldown period.
- Budgets prevent API overuse from frequent new channel sightings.

---

## Privacy

- Subscription data is stored locally in the browser (`chrome.storage.local`).
- No subscription data is sent to any server other than YouTube's official APIs.
- No personal data is collected or transmitted.

---

## Troubleshooting

- If markers are missing for channels you know you're subscribed to, try:
  1. Clicking the extension icon and re-authenticating.
  2. Clearing the extension's storage in `chrome://extensions/` → "Inspect background page" → Application tab.
  3. Reloading the YouTube page.
