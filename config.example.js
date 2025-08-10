// config.example.js

/*
    Copy this file to config.js and fill in your credentials.

    CLIENT_ID
        OAuth 2.0 Web Client ID from Google Cloud Console.
        Remember to add https://<your-extension-id>.chromiumapp.org/ as an authorized redirect URI.

    SEARCH_API_KEY
        API key for YouTube Data API v3.
        Used only as a fallback for handle resolution when HTML parsing fails.
*/

export default {
    CLIENT_ID: "YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com",
    SEARCH_API_KEY: "YOUR_YOUTUBE_DATA_API_KEY"
};
