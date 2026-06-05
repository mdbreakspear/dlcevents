/**
 * DLC Events – GitHub Action entrypoint
 * Fetches data from Supabase, calls shared report-engine.js, uploads to Dropbox.
 *
 * Usage:  node scripts/generate-report.js weekly|monthly
 *
 * Secrets needed:
 *   SB_URL, SB_KEY, DROPBOX_ACCESS_TOKEN
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
const SB_URL    = process.env.SB_URL;
const SB_KEY    = process.env.SB_KEY;
const DBX_TOKEN = process.env.DROPBOX_ACCESS_TOKEN;
const DROPBOX_FOLDER = '/New Structure/Sales/CRM Job Reports';

if (!SB_URL || !SB_KEY || !DBX_TOKEN) {
  console.error('Missing env vars: SB_URL, SB_KEY, DROPBOX_ACCESS_TOKEN');
  process.exit(1);
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
  const dropboxPath = DROPBOX_FOLDER + '/' + filename;
  console.log(`Uploading → ${dropboxPath}`);
  const buf = Buffer.from(pdfBuffer);
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'content.dropboxapi.com',
      path: '/2/files/upload',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DBX_TOKEN}`,
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
