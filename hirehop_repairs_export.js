#!/usr/bin/env node
/**
 * HireHop → Supabase  Repairs Sync
 * ----------------------------------
 * Runs via GitHub Actions on a schedule (08:00 and 16:00 UTC daily).
 * Credentials stored as GitHub Actions Secrets — never hardcoded.
 *
 * ZERO DELETE POLICY:
 *   Rows are NEVER deleted from Supabase.
 *   - Items present in HireHop feed → UPDATE the existing row (preserving
 *     comments / responsible), or INSERT if brand new.
 *   - Items NOT in the HireHop feed → PATCH archived = 'Archived'.
 *   - Items that reappear in HireHop → PATCH archived = 'Current'.
 *
 * Required GitHub Secrets:
 *   HIREHOP_EMAIL, HIREHOP_PASS, SB_URL, SB_KEY
 */

const HIREHOP_BASE  = "https://myhirehop.com";
const HIREHOP_CO    = "DEFTR";
const HIREHOP_EMAIL = process.env.HIREHOP_EMAIL;
const HIREHOP_PASS  = process.env.HIREHOP_PASS;
const HIREHOP_DEPOT = [2];

const SB_URL    = process.env.SB_URL;
const SB_KEY    = process.env.SB_KEY;
const REP_TABLE = "Repairs";

if (!HIREHOP_EMAIL || !HIREHOP_PASS) throw new Error("Missing HIREHOP_EMAIL or HIREHOP_PASS secret");
if (!SB_URL || !SB_KEY)             throw new Error("Missing SB_URL or SB_KEY secret");

const STATUS_MAP = { "1.0": "Flagged", "2.0": "In repair" };

// ── Cookie helpers ────────────────────────────────────────────────────────────
function parseCookies(jar, val) {
  const pair = val.split(";")[0].trim();
  const idx  = pair.indexOf("=");
  if (idx < 0) return jar;
  jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  return jar;
}
const cookieStr = jar => Object.entries(jar).map(([k,v]) => `${k}=${v}`).join("; ");

// ── Login ─────────────────────────────────────────────────────────────────────
async function login() {
  console.log("Logging in to HireHop...");
  let jar = {};
  const r1 = await fetch(`${HIREHOP_BASE}/login.php`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: HIREHOP_BASE },
    body: `loc=home.php&code=${encodeURIComponent(HIREHOP_CO)}&type=login&rem=1`,
    redirect: "manual",
  });
  r1.headers.forEach((v, k) => { if (k.toLowerCase() === "set-cookie") parseCookies(jar, v); });

  const r2 = await fetch(`${HIREHOP_BASE}/login_msg.php`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: HIREHOP_BASE, cookie: cookieStr(jar) },
    body: `loc=&code=${encodeURIComponent(HIREHOP_CO)}&rem=1`
        + `&username=${encodeURIComponent(HIREHOP_EMAIL)}`
        + `&password=${encodeURIComponent(HIREHOP_PASS)}`,
    redirect: "manual",
  });
  r2.headers.forEach((v, k) => { if (k.toLowerCase() === "set-cookie") parseCookies(jar, v); });

  if (!jar["id"] || !jar["password"]) throw new Error("Login failed — missing session cookies");
  console.log(`  ✅ Logged in (user ${jar["id"]})`);
  return jar;
}

// ── Fetch repairs from HireHop (with retries) ────────────────────────────────
async function fetchRepairs(jar, maxAttempts = 4, delayMs = 15000) {
  const url = `${HIREHOP_BASE}/reports/damaged_list.php`
            + `?depot=${encodeURIComponent(JSON.stringify(HIREHOP_DEPOT))}`;
  console.log(`  GET ${url}`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res  = await fetch(url, {
        headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest",
                   referer: `${HIREHOP_BASE}/reports/damaged.php`, cookie: cookieStr(jar) },
      });
      const text = await res.text();

      if (res.status === 502 || res.status === 503 || res.status === 504) {
        throw new Error(`HTTP ${res.status} (transient)`);
      }
      if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      if (text.trim().startsWith("<")) throw new Error("Got HTML — login may have failed");

      const data = JSON.parse(text);
      if (data?.error) throw new Error(`HireHop error: ${data.error}`);
      const rows = data.data ?? (Array.isArray(data) ? data : null);
      if (!Array.isArray(rows)) throw new Error("Unexpected response shape: " + text.slice(0, 200));

      console.log(`  ✅ Fetched ${rows.length} repair items`);
      return rows;

    } catch (err) {
      const transient = /transient|fetch failed|ECONNRESET|ETIMEDOUT/i.test(err.message);
      if (attempt < maxAttempts && transient) {
        console.warn(`  ⚠ Attempt ${attempt}/${maxAttempts} failed: ${err.message} — retrying in ${delayMs/1000}s...`);
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        throw err;
      }
    }
  }
}

// ── Transform one HireHop row ─────────────────────────────────────────────────
function transform(raw) {
  const sc = String(raw.STATUS_CHANGE ?? "").trim();
  const m  = sc.match(/^(\d{4}-\d{2}-\d{2})/);
  return {
    hirehop_id:     String(raw.ID      ?? "").trim(),
    qty:            parseInt(raw.QTY, 10) || 1,
    title:          String(raw.TITLE   ?? "").trim(),
    barcode:        String(raw.BARCODE ?? "").trim(),
    serial:         String(raw.SERIAL  ?? "").trim(),
    memo:           String(raw.MEMO    ?? "").trim(),
    status:         STATUS_MAP[String(raw.STATUS ?? "").trim()] ?? String(raw.STATUS ?? "").trim(),
    date_in_repair: m ? m[1] : null,
  };
}

// ── Raw Supabase REST call ────────────────────────────────────────────────────
async function sb(method, path, body) {
  const res = await fetch(`${SB_URL}/rest/v1${path}`, {
    method,
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json", Prefer: "return=minimal",
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (res.status >= 400) throw new Error(`SB ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

// ── Fetch ALL existing rows from Supabase (throws on any error) ───────────────
async function fetchAllExisting() {
  let rows = [], offset = 0;
  while (true) {
    const res = await fetch(
      `${SB_URL}/rest/v1/${REP_TABLE}?select=id,hirehop_id,archived,comments,responsible&limit=1000&offset=${offset}`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    const text = await res.text();
    if (res.status >= 400) throw new Error(`fetchAllExisting → ${res.status}: ${text.slice(0, 400)}`);
    const chunk = JSON.parse(text);
    if (!Array.isArray(chunk)) throw new Error(`fetchAllExisting: unexpected shape: ${text.slice(0, 200)}`);
    if (!chunk.length) break;
    rows = rows.concat(chunk);
    if (chunk.length < 1000) break;
    offset += 1000;
  }
  return rows;
}

// ── Sync run reporting ────────────────────────────────────────────────────────
async function writeSyncRun(status, detail) {
  try {
    await sb("POST", "/SyncRuns", {
      sync_name: "HireHop → Supabase (Repairs)", tab: "repairs",
      status, detail: detail ? String(detail).slice(0, 500) : null,
      ran_at: new Date().toISOString(),
    });
  } catch (e) { console.warn("  ⚠ Could not write SyncRun:", e.message); }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== HireHop → Supabase  Repairs Sync ===");
  console.log(`    ${new Date().toISOString()}\n`);

  const jar = await login();

  console.log("\nFetching repair list from HireHop...");
  const hhRows = await fetchRepairs(jar);

  if (!hhRows.length) {
    console.log("  ℹ️  Empty feed — no changes made.");
    await writeSyncRun("success", "0 items in HireHop feed — no changes made");
    return;
  }

  // Transform and index by hirehop_id
  const incoming = hhRows.map(transform).filter(r => r.hirehop_id && (r.title || r.barcode || r.serial));
  const liveById = new Map(incoming.map(r => [r.hirehop_id, r]));
  console.log(`  Transformed: ${incoming.length} valid rows`);

  // Read everything currently in Supabase — throws on error so we never run blind
  console.log("\nReading existing Supabase rows...");
  const existing    = await fetchAllExisting();
  const existingMap = new Map(existing.filter(r => r.hirehop_id).map(r => [r.hirehop_id, r]));
  console.log(`  Found ${existing.length} existing rows`);

  const now = new Date().toISOString();
  let inserted = 0, updated = 0, archived = 0, restored = 0;

  // ── 1. For each live HireHop item: PATCH if exists, POST if new ───────────
  // NOTE: A UNIQUE constraint on hirehop_id ensures a POST can never create a
  //       duplicate — it will 409 if somehow existingMap was wrong, rather than
  //       silently inserting a second row.
  // NOTE: comments and responsible are never included — those are user-managed.
  console.log("\nProcessing live HireHop items...");
  for (const r of incoming) {
    const prev = existingMap.get(r.hirehop_id);

    if (prev) {
      const wasArchived = String(prev.archived || '').toLowerCase() === 'archived';
      await sb("PATCH", `/${REP_TABLE}?id=eq.${prev.id}`, {
        qty:            r.qty,
        title:          r.title,
        barcode:        r.barcode,
        serial:         r.serial,
        memo:           r.memo,
        status:         r.status,
        date_in_repair: r.date_in_repair,
        archived:       'Current',
        updated_at:     now,
      });
      updated++;
      if (wasArchived) restored++;
    } else {
      await sb("POST", `/${REP_TABLE}`, {
        ...r,
        archived:   'Current',
        updated_at: now,
      });
      inserted++;
    }
  }
  console.log(`  ✅ Updated ${updated} rows (${restored} restored from archived)`);
  console.log(`  ✅ Inserted ${inserted} new rows`);

  // ── 2. Any existing row NOT in the live feed → mark Archived ────────────
  console.log("\nChecking for items to archive...");
  const toArchive = existing.filter(r =>
    r.hirehop_id &&
    !liveById.has(r.hirehop_id) &&
    String(r.archived || '').toLowerCase() !== 'archived'
  );

  if (toArchive.length) {
    const ids = toArchive.map(r => r.id).join(',');
    await sb("PATCH", `/${REP_TABLE}?id=in.(${ids})`, {
      archived:   'Archived',
      updated_at: now,
    });
    archived = toArchive.length;
    console.log(`  ✅ Archived ${archived} item(s) no longer in HireHop`);
    toArchive.forEach(r => console.log(`     – [${r.hirehop_id}] (id ${r.id})`));
  } else {
    console.log("  ✅ No items to archive");
  }

  console.log("\n✅ Sync complete");
  await writeSyncRun("success",
    `${updated} updated · ${inserted} inserted · ${archived} archived · ${restored} restored`);
}

main().catch(async err => {
  const transient = /502|503|504|transient|ECONNRESET|ETIMEDOUT/i.test(err.message);
  console.error(`\n❌ Fatal error${transient ? " (transient — HireHop may be temporarily down)" : ""}:`, err.message);
  await writeSyncRun(transient ? "transient_failure" : "failure", err.message).catch(() => {});
  process.exit(1);
});
