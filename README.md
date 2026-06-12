# SF Report to Campaign — Chrome Extension

Adds an **"Add to Campaign +"** button to every Salesforce Lightning report run page —
including reports where the standard button doesn't appear because the report type
doesn't contain Contact. It works off any **Contact ID** or **Email** column in the report.

## How it works

1. A content script watches for `/lightning/r/Report/{Id}/view` URLs and injects a
   floating button (rendered in a shadow DOM so Lightning's CSS can't touch it).
2. When you open the panel, the background service worker reads your existing
   Salesforce session cookie (`sid`) for the org's `*.my.salesforce.com` domain and
   calls the **Analytics REST API** to run the report with detail rows.
3. It auto-detects a Contact ID or Email column (you can override via the dropdown),
   lets you search for a target Campaign, then:
   - resolves emails to Contact IDs (first match wins; ambiguous matches are reported),
   - skips Contacts already on the Campaign,
   - inserts CampaignMembers in batches of 200 via the composite API with
     `allOrNone=false`, so one bad row never fails the batch.

No data leaves your browser; everything happens between your browser and your org.

## Install (unpacked)

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Navigate to any Lightning report — the button appears bottom-right

> Note: the manifest references icon16/48/128.png. Chrome will load fine without
> them (it shows a default icon), or drop in any three PNGs with those names.

## Limitations & gotchas

- **2,000 row cap.** The Analytics REST API returns at most 2,000 detail rows per
  report run. The panel warns you when a report hits the cap. For bigger lists,
  filter the report into chunks and run the import per chunk.
- **Tabular and summary reports** are supported. Matrix reports store detail rows
  differently and are untested.
- **Email matching is fuzzy.** Duplicate Contacts sharing an email resolve to the
  first match; the result summary tells you how many were ambiguous or unmatched.
  Contact ID columns are always safer if the report type can include one.
- **"API Enabled" permission** is required on your user (true for almost all
  admin/consultant profiles).
- **API access control / connected-app restrictions.** Orgs that enforce
  "API Access Control" or block session-ID API use may reject the calls — the same
  constraint Salesforce Inspector Reloaded runs into.
- **Session required on the API domain.** If you get a "no session found" error,
  open any Setup page once (this establishes the `my.salesforce.com` cookie) and retry.
- **CampaignMember Status** must be a valid status for that Campaign; leave it blank
  to use the campaign's default.

## Security notes

- The extension requests the `cookies` permission scoped to Salesforce/force.com
  domains only, and only ever reads the `sid` cookie for the org you're viewing.
- All API calls go directly to your org. There is no third-party server, telemetry,
  or storage.
- Treat the unpacked folder like a credential-adjacent tool: anyone who can edit
  these files can alter what the extension does with your session.

## File map

| File           | Purpose                                                        |
| -------------- | -------------------------------------------------------------- |
| manifest.json  | MV3 manifest, permissions                                       |
| background.js  | Session lookup + REST proxy (report run, SOQL query, inserts)   |
| content.js     | URL watcher, injected button, panel UI, import workflow         |
