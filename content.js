// content.js — runs on Lightning pages, shows a button on report run pages.
(() => {
  "use strict";

  const REPORT_URL_RE = /\/lightning\/r\/Report\/(00O[A-Za-z0-9]{12,15})\/view/;
  const CONTACT_ID_RE = /^003[A-Za-z0-9]{12,15}$/;
  const SYNC_ROW_CAP = 2000; // Analytics REST API detail-row ceiling

  let currentReportId = null;
  let root = null;       // shadow host element
  let shadow = null;
  let state = null;      // per-panel state

  // ---------- messaging ----------

  function call(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ ...msg, host: location.hostname }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp) return reject(new Error("No response from extension background worker."));
        if (!resp.ok) return reject(new Error(resp.error));
        resolve(resp.data);
      });
    });
  }

  // ---------- helpers ----------

  const escSoql = (s) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) {
      node.append(c instanceof Node ? c : document.createTextNode(c));
    }
    return node;
  }

  // ---------- report parsing ----------

  function getDetailRows(factMap) {
    // Tabular reports keep all rows under "T!T". Summary reports keep them
    // under group keys ("0!T", "1!T", ...). Collect every rows array; the
    // value Sets downstream make double-collection harmless.
    const rows = [];
    for (const key of Object.keys(factMap)) {
      const fact = factMap[key];
      if (fact && Array.isArray(fact.rows) && fact.rows.length) {
        rows.push(...fact.rows);
      }
    }
    return rows;
  }

  function describeColumns(reportData) {
    const names = reportData.reportMetadata.detailColumns || [];
    const info = (reportData.reportExtendedMetadata || {}).detailColumnInfo || {};
    return names.map((name, index) => {
      const meta = info[name] || {};
      return {
        index,
        name,
        label: meta.label || name,
        dataType: (meta.dataType || "").toLowerCase()
      };
    });
  }

  function autoPickColumn(columns) {
    const idCol = columns.find((c) => {
      const n = c.name.toUpperCase();
      return n === "CONTACT_ID" || n === "CONTACT.ID" || n.endsWith(".CONTACT_ID");
    });
    if (idCol) return idCol;
    return columns.find(
      (c) => c.dataType === "email" || c.name.toUpperCase().includes("EMAIL")
    ) || null;
  }

  function extractValues(rows, colIndex) {
    const ids = new Set();
    const emails = new Set();
    let blanks = 0;
    for (const row of rows) {
      const cell = (row.dataCells || [])[colIndex];
      if (!cell) continue;
      const raw = String(cell.value ?? cell.label ?? "").trim();
      if (!raw) { blanks++; continue; }
      if (CONTACT_ID_RE.test(raw)) ids.add(raw);
      else if (raw.includes("@")) emails.add(raw.toLowerCase());
      else blanks++;
    }
    return { ids, emails, blanks };
  }

  // ---------- the workflow ----------

  async function resolveEmails(emails) {
    const map = new Map(); // email -> contactId (first match wins)
    let ambiguous = 0;
    for (const group of chunk([...emails], 100)) {
      const inList = group.map((e) => `'${escSoql(e)}'`).join(",");
      const res = await call({
        type: "query",
        soql: `SELECT Id, Email FROM Contact WHERE Email IN (${inList})`
      });
      for (const rec of res.records || []) {
        const e = (rec.Email || "").toLowerCase();
        if (map.has(e)) ambiguous++;
        else map.set(e, rec.Id);
      }
    }
    return { map, ambiguous };
  }

  async function existingMemberIds(campaignId, contactIds) {
    const existing = new Set();
    for (const group of chunk([...contactIds], 300)) {
      const inList = group.map((id) => `'${id}'`).join(",");
      const res = await call({
        type: "query",
        soql:
          `SELECT ContactId FROM CampaignMember ` +
          `WHERE CampaignId = '${campaignId}' AND ContactId IN (${inList})`
      });
      for (const rec of res.records || []) existing.add(rec.ContactId);
    }
    return existing;
  }

  async function insertMembers(campaignId, contactIds, status, onProgress) {
    let created = 0;
    const errors = [];
    const groups = chunk([...contactIds], 200);
    for (let i = 0; i < groups.length; i++) {
      const records = groups[i].map((id) => ({
        attributes: { type: "CampaignMember" },
        CampaignId: campaignId,
        ContactId: id,
        ...(status ? { Status: status } : {})
      }));
      const res = await call({ type: "insert", records });
      for (const r of res) {
        if (r.success) created++;
        else errors.push((r.errors || []).map((e) => e.message).join("; "));
      }
      onProgress(`Inserting… batch ${i + 1}/${groups.length}`);
    }
    return { created, errors };
  }

  // ---------- UI ----------

  const STYLES = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
    .fab {
      position: fixed; right: 20px; bottom: 20px; z-index: 2147483646;
      background: #032d60; color: #fff; border: none; border-radius: 20px;
      padding: 10px 16px; font-size: 13px; font-weight: 600; cursor: pointer;
      box-shadow: 0 4px 14px rgba(3, 45, 96, .35);
    }
    .fab:hover { background: #054a91; }
    .panel {
      position: fixed; right: 20px; bottom: 70px; z-index: 2147483647;
      width: 380px; max-height: 75vh; overflow-y: auto;
      background: #fff; border: 1px solid #d8dde6; border-radius: 8px;
      box-shadow: 0 8px 30px rgba(0,0,0,.18); padding: 16px;
      color: #16325c; font-size: 13px;
    }
    .panel h2 { margin: 0 0 2px; font-size: 15px; }
    .muted { color: #54698d; font-size: 12px; margin: 0 0 12px; }
    label { display: block; font-weight: 600; margin: 12px 0 4px; font-size: 12px; }
    select, input[type=text] {
      width: 100%; padding: 7px 8px; border: 1px solid #d8dde6;
      border-radius: 4px; font-size: 13px; background: #fff; color: #16325c;
    }
    select:focus, input:focus { outline: 2px solid #1b96ff; outline-offset: 1px; }
    .results { border: 1px solid #d8dde6; border-radius: 4px; margin-top: 4px; max-height: 140px; overflow-y: auto; }
    .results button {
      display: block; width: 100%; text-align: left; padding: 7px 8px;
      background: #fff; border: none; border-bottom: 1px solid #eef1f6;
      cursor: pointer; font-size: 13px; color: #16325c;
    }
    .results button:hover { background: #f3f6fb; }
    .selected { background: #eef4ff; border: 1px solid #aacbff; border-radius: 4px; padding: 7px 8px; margin-top: 4px; display: flex; justify-content: space-between; align-items: center; }
    .selected a { color: #0b5cab; cursor: pointer; font-size: 12px; }
    .run {
      width: 100%; margin-top: 16px; padding: 10px; border: none; border-radius: 4px;
      background: #2e844a; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer;
    }
    .run:disabled { background: #c9c9c9; cursor: default; }
    .log { margin-top: 12px; padding: 8px; background: #f3f6fb; border-radius: 4px; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
    .warn { color: #8c4b02; }
    .err { color: #ba0517; }
    .ok { color: #2e844a; font-weight: 600; }
    .close { position: absolute; top: 10px; right: 12px; border: none; background: none; font-size: 16px; cursor: pointer; color: #54698d; }
  `;

  function ensureRoot() {
    if (root) return;
    root = document.createElement("div");
    root.id = "sf-r2c-root";
    shadow = root.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLES;
    shadow.append(style);
    document.documentElement.append(root);
  }

  function showButton() {
    ensureRoot();
    if (shadow.querySelector(".fab")) return;
    shadow.append(
      el("button", { class: "fab", onclick: togglePanel }, "Add to Campaign +")
    );
  }

  function hideButton() {
    shadow?.querySelector(".fab")?.remove();
    closePanel();
  }

  function closePanel() {
    shadow?.querySelector(".panel")?.remove();
    state = null;
  }

  function setLog(text, cls = "") {
    const log = shadow.querySelector(".log");
    if (log) { log.textContent = text; log.className = "log " + cls; }
  }

  async function togglePanel() {
    if (shadow.querySelector(".panel")) { closePanel(); return; }

    state = { reportId: currentReportId, columns: [], rows: [], campaign: null };

    const panel = el("div", { class: "panel" },
      el("button", { class: "close", onclick: closePanel, title: "Close" }, "\u00d7"),
      el("h2", {}, "Add report Contacts to Campaign"),
      el("p", { class: "muted" }, `Report ${state.reportId}`),
      el("div", { class: "log" }, "Loading report\u2026")
    );
    shadow.append(panel);

    try {
      const data = await call({ type: "runReport", reportId: state.reportId });
      state.columns = describeColumns(data);
      state.rows = getDetailRows(data.factMap || {});
      buildForm(panel);
    } catch (e) {
      setLog(e.message, "err");
    }
  }

  function buildForm(panel) {
    const auto = autoPickColumn(state.columns);

    const colSelect = el("select", {});
    for (const c of state.columns) {
      const opt = el("option", { value: String(c.index) }, `${c.label} (${c.name})`);
      if (auto && c.index === auto.index) opt.selected = true;
      colSelect.append(opt);
    }

    const search = el("input", {
      type: "text",
      placeholder: "Search campaigns by name\u2026",
      oninput: debounce(() => searchCampaigns(search.value), 350)
    });
    const resultsBox = el("div", { class: "results", style: "display:none" });
    const selectedBox = el("div", { style: "display:none" });
    const statusInput = el("input", { type: "text", placeholder: "e.g. Sent (leave blank for default)" });

    const runBtn = el("button", { class: "run", onclick: () => runImport(), disabled: "true" }, "Add to Campaign");

    panel.querySelector(".log").before(
      el("label", {}, "Contact column"), colSelect,
      el("label", {}, "Campaign"), search, resultsBox, selectedBox,
      el("label", {}, "Member status (optional)"), statusInput,
      runBtn
    );

    const capNote = state.rows.length >= SYNC_ROW_CAP
      ? ` \u26a0 The API caps detail rows at ${SYNC_ROW_CAP}; this report may be truncated.`
      : "";
    setLog(`Loaded ${state.rows.length} rows.` +
      (auto ? ` Auto-selected column: ${auto.label}.` : " Pick the Contact ID or Email column.") + capNote,
      capNote ? "warn" : "");

    state.ui = { colSelect, search, resultsBox, selectedBox, statusInput, runBtn };
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  async function searchCampaigns(term) {
    const { resultsBox } = state.ui;
    if (!term || term.trim().length < 2) { resultsBox.style.display = "none"; return; }
    try {
      const res = await call({
        type: "query",
        soql:
          `SELECT Id, Name, Status FROM Campaign ` +
          `WHERE Name LIKE '%${escSoql(term.trim())}%' ` +
          `ORDER BY LastModifiedDate DESC LIMIT 10`
      });
      resultsBox.replaceChildren();
      if (!res.records?.length) {
        resultsBox.append(el("button", { disabled: "true" }, "No campaigns found"));
      } else {
        for (const c of res.records) {
          resultsBox.append(
            el("button", { onclick: () => pickCampaign(c) }, `${c.Name} \u00b7 ${c.Status || ""}`)
          );
        }
      }
      resultsBox.style.display = "block";
    } catch (e) {
      setLog(e.message, "err");
    }
  }

  function pickCampaign(c) {
    state.campaign = c;
    const { resultsBox, selectedBox, search, runBtn } = state.ui;
    resultsBox.style.display = "none";
    search.style.display = "none";
    selectedBox.style.display = "block";
    selectedBox.replaceChildren(
      el("div", { class: "selected" },
        el("span", {}, c.Name),
        el("a", { onclick: clearCampaign }, "change")
      )
    );
    runBtn.disabled = false;
  }

  function clearCampaign() {
    state.campaign = null;
    const { selectedBox, search, runBtn } = state.ui;
    selectedBox.style.display = "none";
    search.style.display = "block";
    search.value = "";
    runBtn.disabled = true;
  }

  async function runImport() {
    const { colSelect, statusInput, runBtn } = state.ui;
    runBtn.disabled = true;
    const colIndex = parseInt(colSelect.value, 10);
    const status = statusInput.value.trim();

    try {
      setLog("Extracting values from report\u2026");
      const { ids, emails, blanks } = extractValues(state.rows, colIndex);

      const contactIds = new Set(ids);
      let ambiguous = 0;
      let unmatched = 0;

      if (emails.size) {
        setLog(`Resolving ${emails.size} email(s) to Contacts\u2026`);
        const resolved = await resolveEmails(emails);
        ambiguous = resolved.ambiguous;
        unmatched = emails.size - resolved.map.size;
        for (const id of resolved.map.values()) contactIds.add(id);
      }

      if (!contactIds.size) {
        setLog("No Contacts found in the selected column. Check you picked a Contact ID or Email column.", "err");
        runBtn.disabled = false;
        return;
      }

      setLog(`Checking for existing Campaign Members\u2026`);
      const existing = await existingMemberIds(state.campaign.Id, contactIds);
      for (const id of existing) contactIds.delete(id);

      if (!contactIds.size) {
        setLog(`All matched Contacts are already members of "${state.campaign.Name}". Nothing to add.`, "ok");
        runBtn.disabled = false;
        return;
      }

      const { created, errors } = await insertMembers(
        state.campaign.Id, contactIds, status, (msg) => setLog(msg)
      );

      const lines = [`Done. Added ${created} Contact(s) to "${state.campaign.Name}".`];
      if (existing.size) lines.push(`${existing.size} already on the campaign (skipped).`);
      if (ambiguous) lines.push(`${ambiguous} email(s) matched multiple Contacts (first match used).`);
      if (unmatched) lines.push(`${unmatched} email(s) had no matching Contact.`);
      if (blanks) lines.push(`${blanks} row(s) had blank/unusable values.`);
      if (errors.length) lines.push(`${errors.length} insert error(s): ${[...new Set(errors)].slice(0, 3).join(" | ")}`);
      setLog(lines.join("\n"), errors.length ? "warn" : "ok");
    } catch (e) {
      setLog(e.message, "err");
    } finally {
      runBtn.disabled = false;
    }
  }

  // ---------- SPA navigation watcher ----------

  function checkUrl() {
    const m = location.pathname.match(REPORT_URL_RE);
    const reportId = m ? m[1] : null;
    if (reportId !== currentReportId) {
      currentReportId = reportId;
      if (reportId) showButton();
      else hideButton();
    }
  }

  setInterval(checkUrl, 800);
  checkUrl();
})();
