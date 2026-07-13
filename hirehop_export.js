#!/usr/bin/env node
/**
 * HireHop → Supabase Jobs Sync
 * -----------------------------
 * 1. Logs in to HireHop (2-step)
 * 2. Fetches the Job Income report (1st of previous month → 2040-01-01)
 * 3. Transforms data exactly as the HTML upload function does
 * 4. Upserts into Supabase Jobs table (insert new, update changed, skip unchanged)
 *
 * Usage:    node hirehop_export.js
 * Schedule: Windows Task Scheduler → node C:\path\to\hirehop_export.js
 */

const fs = require("fs");
const path = require("path");

// ── Config ─────────────────────────────────────────────────────────────────
const HIREHOP_BASE   = "https://myhirehop.com";
const HIREHOP_CO     = "DEFTR";
const HIREHOP_EMAIL  = process.env.HIREHOP_EMAIL || "lorraine@dlcevents.com";
const HIREHOP_PASS   = process.env.HIREHOP_PASS;
const HIREHOP_DEPOT  = [2];
const HIREHOP_STATUS = ["0","0.5","1","2","2.5","3","4","5","5.5","6","7","8","9",
                        "10","10.1","10.2","10.3","10.4","10.5","10.6","11"];

const SB_URL = process.env.SB_URL || "https://otvxgiujssoyzrfkdlzb.supabase.co";
const SB_KEY = process.env.SB_KEY;
const J_TABLE = "Jobs";
const JC_TABLE = "JobCostings";

// Columns the HTML allows into Supabase (matches J_UPLOAD_ALLOWED_COLUMNS)
const ALLOWED_COLUMNS = new Set([
  "Job","Job name","Depot","Company","Created on","Outgoing","Returning",
  "Total","Net invoiced","Tax","Invoiced","Credits","Uninvoiced","Costs",
  "Unapproved Costs","Profit","Margin","Paid","Job type","Status","Manager",
  "INVOICE STATUS","Reference","Client reference","Deliver to",
  "Delivery address","Email","Project name","Contact name","Mobile",
  "Telephone","Goods out","Goods in"
]);

// HireHop API numeric status → text label
// NOTE: The HireHop API returns different numeric codes to the web UI.
// This map was corrected by cross-referencing the API export against a manual
// export — the original map was shifted by one step throughout.
// ⚠ Codes for Invoiced, Part Paid, Paid, and Lost - No reply are not confirmed
//   from data (none appeared in the reference dataset). Verify against a live
//   job in each of those states and update accordingly.
const STATUS_MAP = {
  "0":    "Enquiry",
  "1":    "Provisional",
  "2":    "Confirmed",
  "3":    "Prepped",
  "5":    "Dispatched",
  "6":    "Returned Incomplete",
  "7":    "Returned",
  "9":    "Cancelled",
  "10":   "Lost - Budget",
  "10.1": "Lost - Client lost pitch",
  "10.2": "Lost - Event cancelled",
  "10.3": "Lost - Other",
  "10.4": "Lost - Other",
  "10.5": "Lost - Other",
  "10.6": "Lost - Other",
  "11":   "Missing Equipment",
  // Unconfirmed — verify against live jobs in these states:
  // "4":   "Invoiced",        // ?
  // "4.5": "Part Paid",       // ?
  // "6":   "Paid",            // ? (conflicts with Returned Incomplete above if same code)
  // "8":   "Lost - No reply", // ?
};

// Date columns that get converted to ISO YYYY-MM-DD (matches jCellToValue)
const DATE_COLS = new Set(["created on","created","outgoing","returning","goods out","goods in"]);

// ── Date range ─────────────────────────────────────────────────────────────
function getDateRange() {
  const now  = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const pad  = n => String(n).padStart(2, "0");
  const fmt  = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  return { from: fmt(from), upto: "2040-01-01" };
}

// ── Cookie helpers ─────────────────────────────────────────────────────────
function parseCookies(jar, headerVal) {
  const pair = headerVal.split(";")[0].trim();
  const idx  = pair.indexOf("=");
  if (idx < 0) return jar;
  jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  return jar;
}
function cookieStr(jar) {
  return Object.entries(jar).map(([k,v]) => `${k}=${v}`).join("; ");
}

// ── HireHop login ──────────────────────────────────────────────────────────
async function login() {
  console.log("Logging in to HireHop...");
  let jar = {};

  const r1 = await fetch(`${HIREHOP_BASE}/login.php`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "origin": HIREHOP_BASE },
    body: `loc=home.php&code=${encodeURIComponent(HIREHOP_CO)}&type=login&rem=1`,
    redirect: "manual",
  });
  r1.headers.forEach((v,k) => { if(k.toLowerCase()==="set-cookie") parseCookies(jar,v); });
  console.log(`  Step 1 status: ${r1.status}, cookies: ${JSON.stringify(Object.keys(jar))}`);
  console.log(`  Logging in as: ${HIREHOP_EMAIL}, pass set: ${!!HIREHOP_PASS}`);

  const r2 = await fetch(`${HIREHOP_BASE}/login_msg.php`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "origin": HIREHOP_BASE, "cookie": cookieStr(jar) },
    body: `loc=&code=${encodeURIComponent(HIREHOP_CO)}&rem=1&username=${encodeURIComponent(HIREHOP_EMAIL)}&password=${encodeURIComponent(HIREHOP_PASS)}`,
    redirect: "manual",
  });
  r2.headers.forEach((v,k) => { if(k.toLowerCase()==="set-cookie") parseCookies(jar,v); });
  console.log(`  Step 2 status: ${r2.status}, cookies: ${JSON.stringify(Object.keys(jar))}`);
  const r2body = await r2.text().catch(()=>'');
  console.log(`  Step 2 body: ${r2body.slice(0,300)}`);

  if (!jar["id"] || !jar["password"]) throw new Error("Login failed — missing session cookies");
  console.log(`  ✅ Logged in (user ${jar["id"]})`);
  return jar;
}

// ── Fetch HireHop report ───────────────────────────────────────────────────
async function fetchReport(jar, from, upto) {
  const url = `${HIREHOP_BASE}/reports/job_income_list.php`
    + `?from=${from}&upto=${upto}`
    + `&status=${encodeURIComponent(JSON.stringify(HIREHOP_STATUS))}`
    + `&depot=${encodeURIComponent(JSON.stringify(HIREHOP_DEPOT))}`;

  const res  = await fetch(url, {
    headers: { "accept": "application/json", "x-requested-with": "XMLHttpRequest",
               "referer": `${HIREHOP_BASE}/reports/job_income.php`, "cookie": cookieStr(jar) }
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${text.slice(0,200)}`);

  const data = JSON.parse(text);
  if (data.error) throw new Error(`HireHop error: ${data.error}`);

  const rows = data.data || data.rows || (Array.isArray(data) ? data : null);
  if (!Array.isArray(rows)) throw new Error("Unexpected response shape from HireHop");
  console.log(`  ✅ Fetched ${rows.length} jobs from HireHop`);
  return rows;
}

// ── Transform a HireHop row → Supabase payload ─────────────────────────────
// Mirrors exactly what jBuildJobsPayload + jCellToValue does in the HTML
function transformRow(row) {
  // Map HireHop API fields → CSV column names (as the HTML sees them)
  const mapped = {
    "Job":              String(row.JOB_ID  ?? "").trim(),
    "Job name":         row.JOB_NAME   ?? null,
    "Depot":            row.DEPOT      ?? null,
    "Company":          row.COMPANY    ?? null,
    "Created on":       row.CREATE_DATE?? null,
    "Outgoing":         row.OUT_DATE   ?? null,
    "Returning":        row.RETURN_DATE?? null,
    "Total":            row.TOTAL      ?? null,
    "Net invoiced":     row.INVOICED   ?? null,
    "Tax":              row.VAT_AMOUNT ?? null,
    "Invoiced":         row.GROSS_INVOICED ?? null,
    "Credits":          row.CREDITS    ?? null,
    "Uninvoiced":       row.UNINVOICED ?? null,
    "Costs":            row.COSTS      ?? null,
    "Unapproved Costs": row.UNAPPROVED_COSTS ?? null,
    "Profit":           row.PROFIT     ?? null,
    "Margin":           row.MARGIN     ?? null,
    "Paid":             row.PAID       ?? null,
    "Job type":         row.JOB_TYPE   ?? null,
    "Status":           STATUS_MAP[String(row.STATUS)] ?? row.STATUS ?? null,
    "Manager":          row.MANAGER    ?? null,
    "Email":            row.EMAIL      ?? null,
    "Project name":     row.PROJECT_NAME ?? null,
    "Contact name":     row.NAME       ?? null,
    "Mobile":           row.MOBILE     ?? null,
    "Telephone":        row.TELEPHONE  ?? null,
    "Client reference": row.CLIENT_REF ?? null,
    "Delivery address": row.VENUE_ADDRESS ?? null,
    "Deliver to":       row.VENUE      ?? null,
  };

  const payload = {};

  for (const [col, raw] of Object.entries(mapped)) {
    if (!ALLOWED_COLUMNS.has(col)) continue;

    const s = String(raw ?? "").trim();
    if (!s) { payload[col] = null; continue; }

    // Date columns → ISO YYYY-MM-DD (mirrors jCellToValue)
    if (DATE_COLS.has(col.toLowerCase())) {
      // HireHop returns ISO datetime like "2024-06-27 09:45:19" — take date part only
      const isoMatch = s.match(/^(\d{4}-\d{2}-\d{2})/);
      if (isoMatch) { payload[col] = isoMatch[1]; continue; }
      // DD/MM/YYYY
      const dmySlash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (dmySlash) {
        const [,d,m,y] = dmySlash;
        payload[col] = `${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`;
        continue;
      }
    }

    // Numeric: strip currency symbols/commas (mirrors jCellToValue)
    const cleaned = s.replace(/,/g,"");
    if (/^[-+]?\d+(\.\d+)?$/.test(cleaned)) { payload[col] = Number(cleaned); continue; }

    payload[col] = s;
  }

  return payload;
}

// ── Supabase helpers ───────────────────────────────────────────────────────
async function sbRequest(method, path, body) {
  const res = await fetch(`${SB_URL}/rest/v1${path}`, {
    method,
    headers: {
      "apikey":        SB_KEY,
      "Authorization": `Bearer ${SB_KEY}`,
      "Content-Type":  "application/json",
      "Prefer":        method === "POST" ? "return=representation" : "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch(e) {}
  if (res.status >= 400) throw new Error(`Supabase ${method} ${path} → ${res.status}: ${text.slice(0,300)}`);
  return data;
}

async function sbFindJob(jobId) {
  const data = await sbRequest("GET", `/${J_TABLE}?Job=eq.${encodeURIComponent(jobId)}&limit=1`);
  return (Array.isArray(data) && data.length) ? data[0] : null;
}

async function sbInsert(payload) {
  return sbRequest("POST", `/${J_TABLE}`, payload);
}

async function sbUpdate(jobId, payload) {
  return sbRequest("PATCH", `/${J_TABLE}?Job=eq.${encodeURIComponent(jobId)}`, payload);
}

// ── JobCostings (HireHop "Known Job Costs" custom field) ───────────────────
// The report returns the custom field flattened as the tilde key "~JobCosts"
// (a formatted string, e.g. "1000.00"; empty string when unset). Parse it to a
// number; return null when blank / non-numeric.
function parseJobCosts(row) {
  const raw = row["~JobCosts"];
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/,/g, "").trim();
  if (s === "") return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// Look up the existing costing row for a job (Job Cost only — that's all the
// fill decision needs).
async function sbFindCosting(jobId) {
  const data = await sbRequest(
    "GET",
    `/${JC_TABLE}?Job=eq.${encodeURIComponent(jobId)}&select=Job,"Job Cost"&limit=1`
  );
  return (Array.isArray(data) && data.length) ? data[0] : null;
}

// Fill rule (a): HireHop is a FALLBACK cost source, never authoritative.
// Write the HireHop JobCosts value only when the existing Job Cost is null OR 0
// (i.e. no real Xero cost is present). A non-zero existing cost — which would
// have come from a Xero Project Financials import — is left untouched.
// Profit = Total − JobCosts. Applies to all job types.
async function syncCosting(row, payload, summary) {
  const jobId    = payload["Job"];
  const jobCosts = parseJobCosts(row);
  if (jobCosts === null) { summary.costSkipped++; return; }   // HireHop has no value → do nothing

  // Total from the same report row (already mapped into the Jobs payload).
  const totalNum = parseFloat(String(payload["Total"] ?? "").replace(/,/g, "").trim());
  const total    = Number.isFinite(totalNum) ? totalNum : 0;
  const profit   = total - jobCosts;

  const existing    = await sbFindCosting(jobId);
  const existingCost = existing && existing["Job Cost"] !== null && existing["Job Cost"] !== undefined
    ? Number(existing["Job Cost"]) : null;

  // Only fill when existing cost is null or exactly 0.
  if (existingCost !== null && existingCost !== 0) { summary.costPreserved++; return; }

  const nowIso = new Date().toISOString();
  const body = {
    Job:        jobId,
    "Job Cost": jobCosts,
    "Profit":   profit,
    updated_at: nowIso,
    updated_by: "HireHop sync",
  };

  if (existing) {
    await sbRequest("PATCH", `/${JC_TABLE}?Job=eq.${encodeURIComponent(jobId)}`, body);
  } else {
    await sbRequest("POST", `/${JC_TABLE}`, body);
  }
  summary.costWritten++;
}

// Write a row to SyncErrors so the CRM notifications panel can surface it.
// Silently swallows its own errors so error reporting never crashes the sync.
async function sbReportSyncError(errorDetail, context) {
  try {
    await sbRequest("POST", "/SyncErrors", {
      sync_name:    "HireHop → Supabase",
      error_detail: String(errorDetail ?? "Unknown error").slice(0, 500),
      context:      context ? String(context).slice(0, 200) : null,
      created_at:   new Date().toISOString(),
    });
  } catch(e) {
    console.warn("  ⚠ Could not write to SyncErrors table:", e.message);
  }
}

// Write a sync run record to SyncRuns so the CRM shows last-run status.
async function sbWriteSyncRun(status, detail) {
  try {
    await sbRequest("POST", "/SyncRuns", {
      sync_name:  "HireHop → Supabase (Jobs)",
      tab:        "jobs",
      status:     status,
      detail:     detail ? String(detail).slice(0, 500) : null,
      ran_at:     new Date().toISOString(),
    });
  } catch(e) {
    console.warn("  ⚠ Could not write to SyncRuns table:", e.message);
  }
}

// ── Canonical value for change detection (mirrors jCanonicalUploadValue) ───
function canonical(v, col) {
  if (v == null) return "";
  let s = String(v).trim();
  if (!s) return "";
  // Numbers
  if (/^(total|net invoiced|tax|invoiced|credits|uninvoiced|costs|unapproved costs|profit|margin|paid)$/i.test(col)) {
    const n = Number(s.replace(/[\sAED£$€]/gi, ""));
    if (!isNaN(n)) return String(Number(n.toFixed(2)));
  }
  // Dates
  if (DATE_COLS.has(col.toLowerCase())) {
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  return s.toLowerCase().replace(/\s+/g, " ");
}

function hasChanges(existing, payload) {
  for (const [col, newVal] of Object.entries(payload)) {
    if (col === "Job") continue;
    if (canonical(existing[col], col) !== canonical(newVal, col)) return true;
  }
  return false;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== HireHop → Supabase Sync ===\n");

  // 1. Login + fetch
  const jar            = await login();
  const { from, upto } = getDateRange();
  console.log(`\nFetching report: ${from} → ${upto}`);
  const rows           = await fetchReport(jar, from, upto);

  // 2. Sync to Supabase
  console.log(`\nSyncing to Supabase (${J_TABLE})...`);
  const summary = { inserted: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0,
                    costWritten: 0, costPreserved: 0, costSkipped: 0, errors: [] };

  for (const row of rows) {
    const payload = transformRow(row);
    const jobId   = payload["Job"];

    // Skip rows with no Company or Job ID (mirrors HTML logic)
    if (!jobId || !payload["Company"]) { summary.skipped++; continue; }

    try {
      const existing = await sbFindJob(jobId);

      if (existing) {
        if (hasChanges(existing, payload)) {
          await sbUpdate(jobId, payload);
          summary.updated++;
        } else {
          summary.unchanged++;
        }
      } else {
        await sbInsert(payload);
        summary.inserted++;
      }

      // JobCostings fallback fill (HireHop "Known Job Costs" → Job Cost / Profit).
      await syncCosting(row, payload, summary);
    } catch(e) {
      summary.failed++;
      summary.errors.push(`Job ${jobId}: ${e.message}`);
      console.error(`  ❌ Job ${jobId}:`, e.message);
      await sbReportSyncError(e.message, `Job ${jobId}`);
    }
  }

  // 3. If there were row-level failures, write one summary error to SyncErrors
  if (summary.failed > 0) {
    await sbReportSyncError(
      `${summary.failed} job(s) failed to sync. First error: ${summary.errors[0]}`,
      `${summary.inserted} inserted, ${summary.updated} updated, ${summary.unchanged} unchanged`
    );
  }

  // 4. Report
  console.log("\n=== Sync complete ===");
  console.log(`  Inserted:  ${summary.inserted}`);
  console.log(`  Updated:   ${summary.updated}`);
  console.log(`  Unchanged: ${summary.unchanged}`);
  console.log(`  Skipped:   ${summary.skipped}`);
  console.log(`  Failed:    ${summary.failed}`);
  console.log(`  Costs written:   ${summary.costWritten}`);
  console.log(`  Costs preserved: ${summary.costPreserved} (existing non-zero left intact)`);
  console.log(`  Costs skipped:   ${summary.costSkipped} (no HireHop value)`);
  if (summary.errors.length) {
    console.log("\nErrors:");
    summary.errors.forEach(e => console.log(" ", e));
  }

  // 4. Write sync run record
  await sbWriteSyncRun(
    summary.failed === 0 ? "success" : "partial",
    summary.failed === 0
      ? `${summary.inserted} inserted, ${summary.updated} updated, ${summary.unchanged} unchanged`
      : `${summary.failed} failed. ${summary.errors[0] || ''}`
  );

  // 5. Save a local CSV backup as well
  const now      = new Date();
  const stamp    = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}`;
  const filename = path.join(__dirname, `Job_Income_${stamp}.csv`);
  const cols     = ["Job","Job name","Company","Created on","Outgoing","Returning","Total","Job type","Status"];
  const csvLines = [cols.join(",")];
  for (const row of rows) {
    const p = transformRow(row);
    csvLines.push(cols.map(c => {
      const v = String(p[c] ?? "");
      return (v.includes(",") || v.includes('"')) ? `"${v.replace(/"/g,'""')}"` : v;
    }).join(","));
  }
  fs.writeFileSync(filename, csvLines.join("\r\n"), "utf8");
  console.log(`\n  CSV backup: ${filename}`);
}

main().catch(async err => {
  console.error("\n❌ Fatal error:", err.message);
  await sbReportSyncError(err.message, "Fatal — sync did not complete").catch(() => {});
  await sbWriteSyncRun("failure", err.message).catch(() => {});
  process.exit(1);
});
