#!/usr/bin/env node
/**
 * HireHop → Supabase  Repairs Sync
 * ----------------------------------
 * Runs via GitHub Actions on a schedule (08:00 and 16:00 UTC daily).
 * Credentials are stored as GitHub Actions Secrets — never hardcoded.
 *
 * Required GitHub Secrets (Settings → Secrets → Actions → New repository secret):
 *   HIREHOP_EMAIL   lorraine@dlcevents.com
 *   HIREHOP_PASS    hirehopapi1993
 *   SB_URL          https://otvxgiujssoyzrfkdlzb.supabase.co
 *   SB_KEY          (your Supabase anon key)
 */

// ── Config (from environment — set as GitHub Secrets) ────────────────────────
const HIREHOP_BASE  = "https://myhirehop.com";
const HIREHOP_CO    = "DEFTR";
const HIREHOP_EMAIL = process.env.HIREHOP_EMAIL;
const HIREHOP_PASS  = process.env.HIREHOP_PASS;
const HIREHOP_DEPOT = [2];

const SB_URL    = process.env.SB_URL;
const SB_KEY    = process.env.SB_KEY;
const REP_TABLE = "Repairs";

// Validate secrets are present
if (!HIREHOP_EMAIL || !HIREHOP_PASS) throw new Error("Missing HIREHOP_EMAIL or HIREHOP_PASS secret");
if (!SB_URL || !SB_KEY)             throw new Error("Missing SB_URL or SB_KEY secret");

// ── Status map (confirmed from live API) ─────────────────────────────────────
const STATUS_MAP = {
  "1.0": "Flagged",
  "2.0": "In repair",
};

// ── Cookie helpers ────────────────────────────────────────────────────────────
function parseCookies(jar, headerVal) {
  const pair = headerVal.split(";")[0].trim();
  const idx  = pair.indexOf("=");
  if (idx < 0) return jar;
  jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  return jar;
}
function cookieStr(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

// ── Login ─────────────────────────────────────────────────────────────────────
async function login() {
  console.log("Logging in to HireHop...");
  let jar = {};

  const r1 = await fetch(`${HIREHOP_BASE}/login.php`, {
    method:   "POST",
    headers:  { "content-type": "application/x-www-form-urlencoded", "origin": HIREHOP_BASE },
    body:     `loc=home.php&code=${encodeURIComponent(HIREHOP_CO)}&type=login&rem=1`,
    redirect: "manual",
  });
  r1.headers.forEach((v, k) => { if (k.toLowerCase() === "set-cookie") parseCookies(jar, v); });

  const r2 = await fetch(`${HIREHOP_BASE}/login_msg.php`, {
    method:   "POST",
    headers:  {
      "content-type": "application/x-www-form-urlencoded",
      "origin":       HIREHOP_BASE,
      "cookie":       cookieStr(jar),
    },
    body:     `loc=&code=${encodeURIComponent(HIREHOP_CO)}&rem=1`
            + `&username=${encodeURIComponent(HIREHOP_EMAIL)}`
            + `&password=${encodeURIComponent(HIREHOP_PASS)}`,
    redirect: "manual",
  });
  r2.headers.forEach((v, k) => { if (k.toLowerCase() === "set-cookie") parseCookies(jar, v); });

  if (!jar["id"] || !jar["password"]) throw new Error("Login failed — missing session cookies");
  console.log(`  ✅ Logged in (user ${jar["id"]})`);
  return jar;
}

// ── Fetch repair list ─────────────────────────────────────────────────────────
async function fetchRepairs(jar) {
  const url = `${HIREHOP_BASE}/reports/damaged_list.php`
            + `?depot=${encodeURIComponent(JSON.stringify(HIREHOP_DEPOT))}`;

  console.log(`  GET ${url}`);

  const res  = await fetch(url, {
    headers: {
      "accept":           "application/json",
      "x-requested-with": "XMLHttpRequest",
      "referer":          `${HIREHOP_BASE}/reports/damaged.php`,
      "cookie":           cookieStr(jar),
    },
  });

  const text = await res.text();
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  if (text.trim().startsWith("<")) throw new Error("Got HTML — login may have failed");

  const data = JSON.parse(text);
  if (data && data.error) throw new Error(`HireHop error: ${data.error}`);

  const rows = data.data ?? (Array.isArray(data) ? data : null);
  if (!Array.isArray(rows)) throw new Error("Unexpected response shape: " + text.slice(0, 200));

  console.log(`  ✅ Fetched ${rows.length} repair items`);
  return rows;
}

// ── Transform ─────────────────────────────────────────────────────────────────
function transformRow(raw) {
  let dateIso = null;
  const sc = String(raw.STATUS_CHANGE ?? "").trim();
  const m  = sc.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) dateIso = m[1];

  const rawStatus = String(raw.STATUS ?? "").trim();

  return {
    hirehop_id:     String(raw.ID      ?? "").trim(),
    qty:            parseInt(raw.QTY,  10) || 1,
    title:          String(raw.TITLE   ?? "").trim(),
    barcode:        String(raw.BARCODE ?? "").trim(),
    serial:         String(raw.SERIAL  ?? "").trim(),
    memo:           String(raw.MEMO    ?? "").trim(),
    status:         STATUS_MAP[rawStatus] ?? rawStatus,
    date_in_repair: dateIso,
  };
}

// ── Supabase helpers ──────────────────────────────────────────────────────────
async function sbRequest(method, path, body) {
  const res = await fetch(`${SB_URL}/rest/v1${path}`, {
    method,
    headers: {
      "apikey":        SB_KEY,
      "Authorization": `Bearer ${SB_KEY}`,
      "Content-Type":  "application/json",
      "Prefer":        "return=minimal",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (res.status >= 400) throw new Error(`Supabase ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  try { return text ? JSON.parse(text) : null; } catch(e) { return null; }
}

// ── Main ──────────────────────────────────────────────────────────────────────

// ── Supabase error + run reporting ───────────────────────────────────────────────────────────
async function sbReportSyncError(errorDetail, context) {
  try {
    await sbRequest("POST", "/SyncErrors", {
      sync_name:    "HireHop \u2192 Supabase (Repairs)",
      error_detail: String(errorDetail ?? "Unknown error").slice(0, 500),
      context:      context ? String(context).slice(0, 200) : null,
      created_at:   new Date().toISOString(),
    });
  } catch(e) {
    console.warn("  \u26a0 Could not write to SyncErrors table:", e.message);
  }
}

async function sbWriteSyncRun(status, detail) {
  try {
    await sbRequest("POST", "/SyncRuns", {
      sync_name: "HireHop \u2192 Supabase (Repairs)",
      tab:       "repairs",
      status,
      detail:    detail ? String(detail).slice(0, 500) : null,
      ran_at:    new Date().toISOString(),
    });
  } catch(e) {
    console.warn("  \u26a0 Could not write to SyncRuns table:", e.message);
  }
}

async function main() {
  console.log("=== HireHop → Supabase  Repairs Sync ===");
  console.log(`    ${new Date().toISOString()}\n`);

  const jar    = await login();

  console.log("\nFetching repair list...");
  const rows   = await fetchRepairs(jar);

  if (!rows.length) {
    console.log("  ℹ️  No items returned — nothing to sync.");
    return;
  }

  const mapped = rows
    .map(transformRow)
    .filter(r => r.title || r.barcode || r.serial);

  console.log(`  Transformed: ${mapped.length} rows`);

  console.log(`\nReplacing "${REP_TABLE}" in Supabase...`);
  await sbRequest("DELETE", `/${REP_TABLE}?id=neq.0`);
  console.log("  ✅ Cleared existing rows");

  const BATCH = 200;
  let inserted = 0;
  for (let i = 0; i < mapped.length; i += BATCH) {
    await sbRequest("POST", `/${REP_TABLE}`, mapped.slice(i, i + BATCH));
    inserted += Math.min(BATCH, mapped.length - i);
  }

  console.log(`  ✅ Inserted ${inserted} rows`);
  console.log("\n✅ Sync complete");
}

  console.log("\n✅ Sync complete");
  await sbWriteSyncRun("success", `${inserted} repairs synced from HireHop`);
}

main().catch(async err => {
  console.error("\n❌ Fatal error:", err.message);
  await sbReportSyncError(err.message, "Fatal — sync did not complete").catch(() => {});
  await sbWriteSyncRun("failure", err.message).catch(() => {});
  process.exit(1);
});
