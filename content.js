// content.js

/**
 * Extracts the channel ID or handle from a channel link <a>.
 */
function extractChannelId(channelLink) {
    try {
        const url = new URL(channelLink.href);
        const path = url.pathname.split("/").filter(Boolean);

        if (path[0] === "channel" && path[1]) {
            return path[1];
        }

        if (path[0] && path[0].startsWith("@")) {
            return path[0];
        }

        return null;
    }
    catch (error) {
        console.error("error extracting channel id:", error);
        return null;
    }
}

/**
 * Appends a small 'subscription marker' icon next to the channel link.
 */
function addSubscriptionMarker(channelLink) {
    if (!channelLink.querySelector(".subscription-marker")) {
        const marker = document.createElement("img");
        marker.src = chrome.runtime.getURL("icon.png");
        marker.className = "subscription-marker";
        marker.style.marginLeft = "5px";
        marker.style.width = "16px";
        marker.style.height = "16px";
        marker.alt = "subscribed";
        channelLink.appendChild(marker);
    }
}

let checkTimeout = null;

/**
 * Checks each channel link on the page and marks those the user is subscribed to.
 */
function checkAndMarkSubscriptions() {
    if (checkTimeout) clearTimeout(checkTimeout);

    checkTimeout = setTimeout(() => {
        chrome.runtime.sendMessage({ type: "checkAuth" }, response => {
            const authenticated = response.authenticated;
            const channelLinks = document.querySelectorAll("ytd-channel-name a");

            channelLinks.forEach(link => {
                const channelId = extractChannelId(link);
                if (!channelId) return;

                chrome.runtime.sendMessage({ type: "getCachedStatus", channelId }, cachedRes => {
                    if (typeof cachedRes.status === "boolean") {
                        if (cachedRes.status === true) {
                            addSubscriptionMarker(link);
                        }
                    }
                    else {
                        if (!authenticated) return;
                        chrome.runtime.sendMessage({ type: "checkChannel", channelId }, res => {
                            if (res && res.subscribed === true) {
                                addSubscriptionMarker(link);
                            }
                            else if (res && res.notAuthenticated) {
                                console.warn("not authenticated - user must sign in.");
                            }
                            else if (res && res.error) {
                                console.error("error checking subscription:", res.error);
                            }
                        });
                    }
                });
            });
        });
    }, 300);
}

const observer = new MutationObserver(() => {
    checkAndMarkSubscriptions();
});

observer.observe(document.documentElement, { childList: true, subtree: true });
checkAndMarkSubscriptions();
