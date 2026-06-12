// background.js — service worker
// Handles all Salesforce REST API calls. The content script can't call the
// my.salesforce.com domain directly (cross-origin + no cookie access), so it
// messages this worker, which reads the session cookie and proxies the call.

const API_VERSION = "v60.0";

/**
 * Map a Lightning hostname to its My Domain API host.
 *   acme.lightning.force.com                  -> acme.my.salesforce.com
 *   acme--uat.sandbox.lightning.force.com     -> acme--uat.sandbox.my.salesforce.com
 *   acme.develop.lightning.force.com          -> acme.develop.my.salesforce.com
 */
function apiHostFromLightning(hostname) {
  const suffix = ".lightning.force.com";
  if (hostname.endsWith(suffix)) {
    return "https://" + hostname.slice(0, -suffix.length) + ".my.salesforce.com";
  }
  if (hostname.endsWith(".my.salesforce.com")) {
    return "https://" + hostname;
  }
  return null;
}

async function getSession(lightningHost) {
  const apiHost = apiHostFromLightning(lightningHost);
  if (!apiHost) {
    throw new Error("Could not derive the API host from " + lightningHost);
  }
  const cookie = await chrome.cookies.get({ url: apiHost, name: "sid" });
  if (!cookie || !cookie.value) {
    throw new Error(
      "No Salesforce session found for " + apiHost +
      ". Open any Setup page in this org once (to establish a my.salesforce.com session), then retry."
    );
  }
  return { apiHost, sid: cookie.value };
}

async function sfFetch(session, path, options = {}) {
  const res = await fetch(session.apiHost + path, {
    ...options,
    headers: {
      Authorization: "Bearer " + session.sid,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const msg = Array.isArray(body)
      ? body.map((e) => e.message || e.errorCode).join("; ")
      : (body && body.message) || (typeof body === "string" ? body : res.statusText);
    throw new Error("Salesforce API error " + res.status + ": " + msg);
  }
  return body;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      const session = await getSession(msg.host);

      if (msg.type === "runReport") {
        const data = await sfFetch(
          session,
          `/services/data/${API_VERSION}/analytics/reports/${msg.reportId}?includeDetails=true`
        );
        sendResponse({ ok: true, data });

      } else if (msg.type === "query") {
        const data = await sfFetch(
          session,
          `/services/data/${API_VERSION}/query?q=${encodeURIComponent(msg.soql)}`
        );
        sendResponse({ ok: true, data });

      } else if (msg.type === "insert") {
        // Composite sObject collections: max 200 records per call,
        // allOrNone=false so duplicates/row errors don't sink the batch.
        const data = await sfFetch(
          session,
          `/services/data/${API_VERSION}/composite/sobjects`,
          {
            method: "POST",
            body: JSON.stringify({ allOrNone: false, records: msg.records })
          }
        );
        sendResponse({ ok: true, data });

      } else {
        sendResponse({ ok: false, error: "Unknown message type: " + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // keep the message channel open for the async response
});
