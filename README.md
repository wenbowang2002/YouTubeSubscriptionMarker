# YouTube Subscription Marker

This Chrome extension adds a small marker icon next to channel names on YouTube pages if the user is subscribed to the channel.
It uses a combination of the YouTube Data API v3 and HTML parsing to determine subscription status, with local caching to reduce API usage.

The extension works automatically as the user scrolls through pages such as the YouTube home page, history page, and subscriptions feed.

---

## Features

- Displays an icon next to subscribed channels in the YouTube interface.
- Uses bulk subscription list retrieval to minimize API calls.
- Falls back to per-channel API checks for cases where bulk data is insufficient.
- Caches subscription results and channel ID resolutions to reduce repeated lookups.
- Operates automatically without manual clicks once authenticated.

---

## Requirements

- Google account with access to YouTube.
- YouTube Data API v3 enabled on a Google Cloud project.
- OAuth 2.0 Client ID (for user authentication).
- API key (for channel search and certain fallback lookups).

---

## Google Cloud API Setup

1. Go to Google Cloud Console: https://console.cloud.google.com/
2. Create a new project or select an existing one.
3. Enable **YouTube Data API v3** in the API Library.
4. In **APIs & Services → Credentials**:
   - Create an **OAuth 2.0 Client ID** for a Web Application.
     - Add the following as an Authorized redirect URI:
       ```
       https://<your-extension-id>.chromiumapp.org/
       ```
       Replace `<your-extension-id>` with the actual ID of the extension from the Chrome Extensions page in Developer Mode.
   - Create an **API key**.
5. Note the OAuth Client ID and API Key; they will be placed in `config.js`.

---

## Installation

1. Clone or download this repository.
2. Create a file named `config.js` in the extension directory:
   ```javascript
   export default {
       CLIENT_ID: "YOUR_OAUTH_CLIENT_ID",
       SEARCH_API_KEY: "YOUR_API_KEY"
   };
   ```
3. Open `chrome://extensions/` in Google Chrome.
4. Enable **Developer mode**.
5. Click **Load unpacked** and select the extension directory.

---

## Usage

1. Click the extension icon in Chrome to authenticate with your Google account.
2. Once authenticated, open YouTube and scroll through pages as usual.
3. Subscribed channels will have the marker icon next to their names.

---

## Tunable parameters

All parameters are defined in `background.js` and `content.js`.
Defaults shown below are the values used by the extension if not modified.

### background.js

| Parameter | Description | Default value |
|-----------|-------------|---------------|
| `SUB_LIST_TTL_MS` | Time before the subscription list cache expires. | 12 hours |
| `SUB_LIST_BATCH` | Maximum number of subscriptions retrieved per API call. | 50 |
| `HANDLE_RESOLVE_TIMEOUT_MS` | Timeout for HTML fetches when resolving handles. | 8 seconds |
| `NEGATIVE_CACHE_TTL_MS` | Duration to cache failed handle resolutions before retrying. | 6 hours |
| `PC_BUDGET_MAX` | Maximum per-channel API checks allowed within the refill window during cache warm-up. | 20 checks |
| `PC_BUDGET_REFILL_MS` | Time to fully refill the per-channel check budget. | 1 minute |
| `VERIFY_BUDGET_MAX` | Maximum negative verification API calls allowed within the refill window. | 10 checks |
| `VERIFY_BUDGET_REFILL_MS` | Time to fully refill the verification budget. | 1 minute |
| `VERIFY_NEG_TTL_MS` | Cooldown before re-verifying a channel marked as not subscribed. | 6 hours |

### content.js

| Parameter | Description | Default value |
|-----------|-------------|---------------|
| `BULK_INTERVAL_MS` | Minimum interval between bulk channel checks sent to the background. | 1 second |
| `MAX_IDS_PER_BULK` | Maximum number of channel IDs in a single bulk message. | 100 |

---

## Notes

- API calls are minimized through caching and bulk retrieval.
- In rare cases where cached or bulk data is insufficient, the extension falls back to per-channel API checks.
- The extension does not store subscription data outside of Chrome's local storage.
- API quota usage can be monitored in Google Cloud Console under **APIs & Services → Dashboard**.
