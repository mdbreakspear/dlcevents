/**
 * DLC Events – GitHub Action entrypoint
 * Fetches data from Supabase, calls shared report-engine.js, uploads to Dropbox.
 *
 * Usage:  node scripts/generate-report.js weekly|monthly
 *
 * Secrets needed:
 *   SB_URL, SB_KEY,
 *   DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');
const { jsPDF }        = require('jspdf');
const { createCanvas } = require('canvas');
const { Chart, registerables } = require('chart.js');
const WebSocket        = require('ws');
const https            = require('https');
const { dlcGenerateWeeklyReport, dlcGenerateMonthlyReport } = require('./report-engine');

Chart.register(...registerables);

// ── Env ────────────────────────────────────────────────────────────────────
const SB_URL          = process.env.SB_URL;
const SB_KEY          = process.env.SB_KEY;
const DBX_APP_KEY     = process.env.DROPBOX_APP_KEY;
const DBX_APP_SECRET  = process.env.DROPBOX_APP_SECRET;
const DBX_REFRESH     = process.env.DROPBOX_REFRESH_TOKEN;
const DROPBOX_FOLDER  = '/New Structure/Sales/CRM Job Reports';

if (!SB_URL || !SB_KEY || !DBX_APP_KEY || !DBX_APP_SECRET || !DBX_REFRESH) {
  console.error('Missing env vars: SB_URL, SB_KEY, DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN');
  process.exit(1);
}

// ── Dropbox: exchange refresh token for a fresh access token ───────────────
async function getDropboxAccessToken() {
  const credentials = Buffer.from(`${DBX_APP_KEY}:${DBX_APP_SECRET}`).toString('base64');
  const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(DBX_REFRESH)}`;
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.dropbox.com',
      path: '/oauth2/token',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(`Dropbox token error ${res.statusCode}: ${data}`));
          else { console.log('🔑 Dropbox access token refreshed'); resolve(parsed.access_token); }
        } catch(e) { reject(new Error(`Dropbox token parse error: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const db = createClient(SB_URL, SB_KEY, { realtime: { transport: WebSocket } });

// ── Chart adapter (server-side canvas) ─────────────────────────────────────
async function drawChart(type, data, options, w, h) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const chart = new Chart(ctx, { type, data, options: { ...options, animation: false, responsive: false } });
  await new Promise(r => setTimeout(r, 80));
  const img = canvas.toDataURL('image/png');
  chart.destroy();
  return img;
}

// ── Supabase fetch ──────────────────────────────────────────────────────────
async function fetchAllJobs() {
  let allJobs = [], from = 0;
  while (true) {
    const { data, error } = await db.from('Jobs').select('*').range(from, from + 999);
    if (error) throw new Error('Supabase: ' + error.message);
    if (!data || !data.length) break;
    allJobs = allJobs.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`Fetched ${allJobs.length} jobs`);
  return allJobs;
}

// ── Dropbox upload ──────────────────────────────────────────────────────────
async function uploadToDropbox(pdfBuffer, filename) {
  const accessToken = await getDropboxAccessToken();
  const dropboxPath = DROPBOX_FOLDER + '/' + filename;
  console.log(`Uploading → ${dropboxPath}`);
  const buf = Buffer.from(pdfBuffer);
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'content.dropboxapi.com',
      path: '/2/files/upload',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath, mode: 'overwrite', autorename: false, mute: false }),
        'Content-Length': buf.length,
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(`Dropbox ${res.statusCode}: ${data}`));
          else { console.log(`✅ Uploaded: ${parsed.path_display}`); resolve(parsed); }
        } catch(e) { reject(new Error(`Dropbox parse error: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const mode = process.argv[2];
  if (!['weekly','monthly'].includes(mode)) {
    console.error('Usage: node generate-report.js weekly|monthly');
    process.exit(1);
  }

  console.log(`\n── DLC ${mode.toUpperCase()} Report ──`);
  const allJobs = await fetchAllJobs();

  // The env object bridges the shared engine to Node-specific implementations
  const env = {
    jsPDF: jsPDF,
    drawChart,
    // jVal and jParseDdMmDate fall back to the engine's own copies if omitted
  };

  const result = mode === 'weekly'
    ? await dlcGenerateWeeklyReport(allJobs, env)
    : await dlcGenerateMonthlyReport(allJobs, env);

  console.log(`Generated: ${result.filename}`);
  await uploadToDropbox(result.pdf, result.filename);
  console.log('Done ✅');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
