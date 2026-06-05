/**
 * DLC Events - Automated Report Generator
 * Generates Weekly / Monthly PDF reports from Supabase and uploads to Dropbox.
 *
 * Usage:
 *   node generate-report.js weekly
 *   node generate-report.js monthly
 *
 * Required environment variables (set as GitHub Secrets):
 *   SUPABASE_URL          – e.g. https://otvxgiujssoyzrfkdlzb.supabase.co
 *   SUPABASE_KEY          – anon/service key
 *   DROPBOX_ACCESS_TOKEN  – long-lived / refresh token
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const { jsPDF }        = require('jspdf');
const { createCanvas } = require('canvas');
const { Chart, registerables } = require('chart.js');
const https            = require('https');
const http             = require('http');
const { URL }          = require('url');

Chart.register(...registerables);

// ─── ENV ────────────────────────────────────────────────────────────────────
const SB_URL   = process.env.SB_URL;
const SB_KEY   = process.env.SB_KEY;
const DBX_TOKEN = process.env.DROPBOX_ACCESS_TOKEN;
const DROPBOX_FOLDER = '/New Structure/Sales/CRM Job Reports';

if (!SB_URL || !SB_KEY || !DBX_TOKEN) {
  console.error('Missing required env vars: SB_URL, SB_KEY, DROPBOX_ACCESS_TOKEN');
  process.exit(1);
}

const db = createClient(SB_URL, SB_KEY);

// ─── FIELD ALIASES (mirrors the HTML) ───────────────────────────────────────
const J_ALIASES = {
  'Created on': ['Created on','Created On','created_on','created at','created_at','Created'],
  'Company':    ['Company','company','Client','Client Company'],
  'Job Name':   ['Job Name','Job name','job_name','Name','Job Title','Title'],
  'Job Type':   ['Job Type','Job type','job_type','Type'],
  'Outgoing':   ['Outgoing','outgoing','Outgoing Date','Quote Sent','Sent'],
  'Status':     ['Status','status'],
  'Total':      ['Total','total','Grand Total','Value','Amount'],
  'Job':        ['Job','job','Job Number','Job No','Job Ref','Job Reference'],
};

function jVal(r, f) {
  const keys = J_ALIASES[f] || [f];
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(r, k) && r[k] !== null && r[k] !== undefined && r[k] !== '')
      return r[k];
  }
  return '';
}

function jParseDdMmDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+.*)?$/);
  if (m) {
    let [,dd,mm,yy] = m.map(Number);
    if (yy < 100) yy += 2000;
    const dt = new Date(yy, mm-1, dd);
    if (dt.getFullYear()===yy && dt.getMonth()===mm-1 && dt.getDate()===dd) return dt;
    return null;
  }
  m = s.match(/^(\d{1,2})[-.](\d{1,2})[-.](\d{2,4})(?:\s+.*)?$/);
  if (m) {
    let [,dd,mm,yy] = m.map(Number);
    if (yy < 100) yy += 2000;
    const dt = new Date(yy, mm-1, dd);
    if (dt.getFullYear()===yy && dt.getMonth()===mm-1 && dt.getDate()===dd) return dt;
    return null;
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
  if (m) {
    const [,yy,mm,dd] = m.map(Number);
    const dt = new Date(yy, mm-1, dd);
    if (dt.getFullYear()===yy && dt.getMonth()===mm-1 && dt.getDate()===dd) return dt;
    return null;
  }
  const dt = new Date(s);
  return isNaN(dt) ? null : dt;
}

function dateInRange(dt, start, end) {
  if (!dt) return false;
  const d = (dt instanceof Date) ? dt : jParseDdMmDate(dt);
  if (!d || isNaN(d)) return false;
  return d >= start && d <= end;
}

function isWon(status) {
  const s = String(status||'').trim().toLowerCase();
  return ['confirmed','dispatched','prepped','part dispatched','returned','returned incomplete','invoiced'].includes(s);
}

function jobType(r) {
  const t = String(jVal(r,'Job Type')||'').trim().toLowerCase();
  if (t === 'dryhire') return 'Dryhire';
  if (t === 'radios')  return 'Radios';
  return 'Events';
}

function fmtAED(n) {
  return 'AED ' + Math.round(n).toLocaleString('en-AE');
}

function toLocaleDateStr(d, opts) {
  return d.toLocaleDateString('en-GB', opts);
}

// ─── CHART RENDERING (server-side via canvas) ────────────────────────────────
async function drawChart(type, data, options, w, h) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const chart = new Chart(ctx, {
    type,
    data,
    options: { ...options, animation: false, responsive: false },
  });
  await new Promise(r => setTimeout(r, 80));
  const img = canvas.toDataURL('image/png');
  chart.destroy();
  return img;
}

// ─── SUPABASE DATA FETCH ─────────────────────────────────────────────────────
async function fetchAllJobs() {
  let allJobs = [], from = 0;
  while (true) {
    const { data, error } = await db.from('Jobs').select('*').range(from, from + 999);
    if (error) throw new Error('Supabase fetch error: ' + error.message);
    if (!data || !data.length) break;
    allJobs = allJobs.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`Fetched ${allJobs.length} jobs from Supabase`);
  return allJobs;
}

// ─── BRAND COLOURS ───────────────────────────────────────────────────────────
const DLC_BLUE   = [43, 76, 140];
const DLC_GREEN  = [58, 143, 111];
const DLC_RED    = [217, 79, 65];
const JT_DRYHIRE = [197, 124, 45];
const JT_RADIOS  = [70, 103, 227];
const JT_EVENTS  = [86, 159, 84];
const hex = rgb => '#' + rgb.map(x => x.toString(16).padStart(2,'0')).join('');

// ─── PDF HELPERS ─────────────────────────────────────────────────────────────
function drawPageHeader(doc, PW, PH, ML, CW, label, genDate) {
  const H = 22;
  doc.setFillColor(...DLC_BLUE);
  doc.rect(0, 0, PW, H, 'F');
  doc.setFont('helvetica','bold');
  doc.setFontSize(12);
  doc.setTextColor(255,255,255);
  doc.text(label, ML + 10, 10);
  doc.setFont('helvetica','normal');
  doc.setFontSize(7.5);
  doc.setTextColor(200,215,240);
  doc.text(genDate, PW-12, 16, { align:'right' });
  return H + 6;
}

function drawPageFooter(doc, PW, PH, footerLabel) {
  doc.setFillColor(43, 76, 140);
  doc.rect(0, PH-8, PW, 8, 'F');
  doc.setFont('helvetica','normal');
  doc.setFontSize(6);
  doc.setTextColor(180,200,230);
  doc.text(footerLabel, PW/2, PH-3, { align:'center' });
}

// ─── WEEKLY REPORT ───────────────────────────────────────────────────────────
async function generateWeeklyReport(allJobs) {
  // Previous Mon–Sun
  const today = new Date();
  today.setHours(0,0,0,0);
  const day   = today.getDay(); // 0=Sun
  const diffToMon = (day === 0) ? -6 : 1 - day;
  const prevMon   = new Date(today); prevMon.setDate(today.getDate() + diffToMon - 7);
  const prevSun   = new Date(prevMon); prevSun.setDate(prevMon.getDate() + 6);
  prevSun.setHours(23,59,59,999);

  const weekLabel = toLocaleDateStr(prevMon,{day:'numeric',month:'short',year:'numeric'})
    + ' – ' + toLocaleDateStr(prevSun,{day:'numeric',month:'short',year:'numeric'});
  const genDate = 'Generated: ' + toLocaleDateStr(new Date(),{day:'numeric',month:'short',year:'numeric'});
  const title   = 'Weekly Performance Report';

  // ── Data ────────────────────────────────────────────────────────────────
  const days = []; for (let i=0;i<7;i++){const d=new Date(prevMon);d.setDate(prevMon.getDate()+i);days.push(d);}
  const quotedByDay = days.map(d => {
    const s = new Date(d); s.setHours(0,0,0,0);
    const e = new Date(d); e.setHours(23,59,59,999);
    return allJobs.filter(r => dateInRange(jParseDdMmDate(jVal(r,'Created on')), s, e)).length;
  });
  const dayLabels = days.map(d => toLocaleDateStr(d,{weekday:'short'}));
  const totalQuoted = quotedByDay.reduce((a,b)=>a+b, 0);

  const outgoingJobs = allJobs.filter(r => dateInRange(jParseDdMmDate(jVal(r,'Outgoing')), prevMon, prevSun));
  const getStatus    = r => jVal(r,'Status');
  const wonJobs      = outgoingJobs.filter(r => isWon(getStatus(r)));
  const lostJobs     = outgoingJobs.filter(r => !isWon(getStatus(r)));
  const wonRevenue   = wonJobs.reduce((s,r) => s + (Number(String(jVal(r,'Total')||'').replace(/[^\d.-]/g,''))||0), 0);

  function typeSplit(jobs){ const c={Dryhire:0,Radios:0,Events:0}; jobs.forEach(r=>c[jobType(r)]++); return c; }
  const allTypeSplit = typeSplit(outgoingJobs);
  const wonTypeSplit = typeSplit(wonJobs);

  const companyMap = {};
  outgoingJobs.forEach(r => {
    const co = String(jVal(r,'Company'))||'Unknown';
    if (!companyMap[co]) companyMap[co] = {quoted:0,won:0,lost:0};
    companyMap[co].quoted++;
    if (isWon(getStatus(r))) companyMap[co].won++; else companyMap[co].lost++;
  });
  const companyRows = Object.entries(companyMap).sort((a,b)=>b[1].quoted-a[1].quoted);

  // ── Charts ───────────────────────────────────────────────────────────────
  const barImg = await drawChart('bar', {
    labels: dayLabels,
    datasets: [{ data: quotedByDay, backgroundColor: hex(DLC_BLUE), borderRadius: 3, barPercentage: 0.6 }]
  }, {
    plugins: { legend:{ display:false } },
    scales: {
      x:{ grid:{display:false}, ticks:{color:'#475569',font:{size:10}} },
      y:{ grid:{color:'#eee'}, ticks:{color:'#475569',font:{size:10},stepSize:1,precision:0}, beginAtZero:true }
    }
  }, 480, 160);

  const pieImg = await drawChart('pie', {
    labels: ['Won','Lost'],
    datasets: [{ data:[wonJobs.length,lostJobs.length], backgroundColor:[hex(DLC_GREEN),hex(DLC_RED)], borderWidth:2, borderColor:'#fff' }]
  }, { plugins:{ legend:{display:false} } }, 200, 200);

  const makeTypePie = splits => drawChart('pie', {
    labels: ['Dryhire','Radios','Events'],
    datasets: [{ data:[splits.Dryhire,splits.Radios,splits.Events], backgroundColor:[hex(JT_DRYHIRE),hex(JT_RADIOS),hex(JT_EVENTS)], borderWidth:2, borderColor:'#fff' }]
  }, { plugins:{ legend:{display:false} } }, 220, 220);

  const allTypeImg = await makeTypePie(allTypeSplit);
  const wonTypeImg = await makeTypePie(wonTypeSplit);

  // ── Build PDF ────────────────────────────────────────────────────────────
  const doc = new jsPDF({ orientation:'portrait', unit:'mm', format:'a4' });
  const PW=210, PH=297, ML=12, MR=12;
  const CW = PW-ML-MR;
  const FOOTER_H = 8;
  const USABLE_H = PH - FOOTER_H;

  let y = drawPageHeader(doc, PW, PH, ML, CW, title, genDate);

  // Week subtitle
  doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(100,116,139);
  doc.text(weekLabel, ML, y); y += 8;

  // ── KPI Cards ────────────────────────────────────────────────────────────
  const cards = [
    { label:'Jobs Quoted',   value: String(totalQuoted) },
    { label:'Jobs Outgoing', value: String(outgoingJobs.length) },
    { label:'Jobs Won',      value: String(wonJobs.length) },
    { label:'Jobs Lost',     value: String(lostJobs.length) },
    { label:'Win Rate',      value: outgoingJobs.length ? Math.round(wonJobs.length/outgoingJobs.length*100)+'%' : '—' },
    { label:'Won Revenue',   value: fmtAED(wonRevenue) },
  ];
  const cardW = CW/3 - 2; const cardH = 18;
  cards.forEach((c,i) => {
    const cx = ML + (i%3)*(cardW+3);
    const cy = y + Math.floor(i/3)*(cardH+3);
    doc.setFillColor(245,247,251); doc.rect(cx,cy,cardW,cardH,'F');
    doc.setDrawColor(225,230,240); doc.setLineWidth(0.2); doc.rect(cx,cy,cardW,cardH,'S');
    doc.setFont('helvetica','bold'); doc.setFontSize(14); doc.setTextColor(...DLC_BLUE);
    doc.text(c.value, cx+cardW/2, cy+10, {align:'center'});
    doc.setFont('helvetica','normal'); doc.setFontSize(6.5); doc.setTextColor(100,116,139);
    doc.text(c.label, cx+cardW/2, cy+15, {align:'center'});
  });
  y += cardH*2 + 3*2 + 6;

  // ── Bar Chart ────────────────────────────────────────────────────────────
  if (barImg) {
    doc.setFont('helvetica','bold'); doc.setFontSize(8); doc.setTextColor(...DLC_BLUE);
    doc.text('Jobs Quoted This Week', ML, y); y += 4;
    doc.addImage(barImg,'PNG', ML, y, CW*0.65, 35); y += 38;
  }

  // ── Pie Charts ────────────────────────────────────────────────────────────
  const pieY = y;
  doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(...DLC_BLUE);
  doc.text('Won / Lost', ML, y); doc.text('All Job Types', ML+65, y); doc.text('Won Job Types', ML+130, y);
  y += 3;
  if (pieImg)     doc.addImage(pieImg,    'PNG', ML,      y, 45, 45);
  if (allTypeImg) doc.addImage(allTypeImg,'PNG', ML+62,   y, 48, 48);
  if (wonTypeImg) doc.addImage(wonTypeImg,'PNG', ML+125,  y, 48, 48);
  y = pieY + 52;

  // Legends
  const drawLegend = (items, xStart, yStart) => {
    items.forEach(([col, label], i) => {
      const lx = xStart; const ly = yStart + i*5;
      doc.setFillColor(...col); doc.rect(lx, ly, 3.5, 3.5, 'F');
      doc.setFont('helvetica','normal'); doc.setFontSize(6); doc.setTextColor(71,85,105);
      doc.text(label, lx+5, ly+3);
    });
  };
  drawLegend([[DLC_GREEN,'Won'],[DLC_RED,'Lost']], ML, pieY+48);
  drawLegend([[JT_DRYHIRE,'Dryhire'],[JT_RADIOS,'Radios'],[JT_EVENTS,'Events']], ML+62, pieY+48);
  drawLegend([[JT_DRYHIRE,'Dryhire'],[JT_RADIOS,'Radios'],[JT_EVENTS,'Events']], ML+125, pieY+48);
  y += 12;

  // ── Company Table ─────────────────────────────────────────────────────────
  doc.setFont('helvetica','bold'); doc.setFontSize(8.5); doc.setTextColor(...DLC_BLUE);
  doc.text('Jobs by Company', ML, y); y += 4;

  const colW = [CW-60, 20, 20, 20]; const colX = [ML, ML+CW-60, ML+CW-40, ML+CW-20];
  const TBL_HDR_H = 7, TBL_ROW_H = 7;

  doc.setFillColor(232,237,245); doc.rect(ML, y, CW, TBL_HDR_H, 'F');
  doc.setFont('helvetica','bold'); doc.setFontSize(6.5); doc.setTextColor(71,85,105);
  ['Company','Quotes','Won','Lost'].forEach((h,i) => {
    if (i===0) doc.text(h, colX[0]+2, y+4.2);
    else doc.text(h, colX[i]+colW[i]/2, y+4.2, {align:'center'});
  });
  y += TBL_HDR_H;
  doc.setFont('helvetica','normal'); doc.setFontSize(6.2);

  companyRows.forEach(([co, s], idx) => {
    if (y + TBL_ROW_H > USABLE_H) {
      drawPageFooter(doc, PW, PH, 'DLC Events CRM · Confidential · '+weekLabel+' (continued)');
      doc.addPage();
      y = drawPageHeader(doc, PW, PH, ML, CW, title, genDate);
      doc.setFillColor(232,237,245); doc.rect(ML,y,CW,TBL_HDR_H,'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(6.5); doc.setTextColor(71,85,105);
      ['Company','Quotes','Won','Lost'].forEach((h,i) => {
        if (i===0) doc.text(h, colX[0]+2, y+4.2);
        else doc.text(h, colX[i]+colW[i]/2, y+4.2, {align:'center'});
      });
      y += TBL_HDR_H;
      doc.setFont('helvetica','normal'); doc.setFontSize(6.2);
    }
    if (idx%2===0){ doc.setFillColor(250,251,253); doc.rect(ML,y,CW,TBL_ROW_H,'F'); }
    doc.setTextColor(15,23,42);   doc.text(String(co).substring(0,50), colX[0]+2, y+3.5);
    doc.setTextColor(...DLC_BLUE);  doc.text(String(s.quoted), colX[1]+colW[1]/2, y+3.5, {align:'center'});
    doc.setTextColor(...DLC_GREEN); doc.text(String(s.won),    colX[2]+colW[2]/2, y+3.5, {align:'center'});
    doc.setTextColor(...DLC_RED);   doc.text(String(s.lost),   colX[3]+colW[3]/2, y+3.5, {align:'center'});
    y += TBL_ROW_H;
    doc.setDrawColor(225,230,240); doc.setLineWidth(0.15); doc.line(ML,y,ML+CW,y);
  });

  drawPageFooter(doc, PW, PH, 'DLC Events CRM · Confidential · '+weekLabel);

  const filename = 'DLC_Weekly_Report_' +
    toLocaleDateStr(prevMon,{day:'2-digit',month:'2-digit',year:'numeric'}).replace(/\//g,'-') + '.pdf';

  return { pdf: doc.output('arraybuffer'), filename };
}

// ─── MONTHLY REPORT ──────────────────────────────────────────────────────────
async function generateMonthlyReport(allJobs) {
  const today = new Date();
  const firstOfThisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const mEnd   = new Date(firstOfThisMonth - 1); mEnd.setHours(23,59,59,999);
  const mStart = new Date(mEnd.getFullYear(), mEnd.getMonth(), 1); mStart.setHours(0,0,0,0);

  const periodLabel = toLocaleDateStr(mStart,{day:'numeric',month:'short',year:'numeric'})
    + ' – ' + toLocaleDateStr(mEnd,{day:'numeric',month:'short',year:'numeric'});
  const genDate = 'Generated: ' + toLocaleDateStr(new Date(),{day:'numeric',month:'short',year:'numeric'});
  const title   = 'Monthly Performance Report';

  const daysInMonth = mEnd.getDate();
  const quotedByDay = [], dayLabels = [];
  for (let d=1; d<=daysInMonth; d++) {
    const dayStart = new Date(mStart.getFullYear(), mStart.getMonth(), d, 0,0,0,0);
    const dayEnd   = new Date(mStart.getFullYear(), mStart.getMonth(), d, 23,59,59,999);
    quotedByDay.push(allJobs.filter(r => dateInRange(jParseDdMmDate(jVal(r,'Created on')), dayStart, dayEnd)).length);
    dayLabels.push(String(d));
  }
  const totalQuoted = quotedByDay.reduce((a,b)=>a+b, 0);

  const outgoingJobs = allJobs.filter(r => dateInRange(jParseDdMmDate(jVal(r,'Outgoing')), mStart, mEnd));
  const getStatus    = r => jVal(r,'Status');
  const wonJobs      = outgoingJobs.filter(r => isWon(getStatus(r)));
  const lostJobs     = outgoingJobs.filter(r => !isWon(getStatus(r)));
  const wonRevenue   = wonJobs.reduce((s,r) => s + (Number(String(jVal(r,'Total')||'').replace(/[^\d.-]/g,''))||0), 0);

  function typeSplit(jobs){ const c={Dryhire:0,Radios:0,Events:0}; jobs.forEach(r=>c[jobType(r)]++); return c; }
  const allTypeSplit = typeSplit(outgoingJobs);
  const wonTypeSplit = typeSplit(wonJobs);

  const companyMap = {};
  outgoingJobs.forEach(r => {
    const co = String(jVal(r,'Company'))||'Unknown';
    if (!companyMap[co]) companyMap[co] = {quoted:0,won:0,lost:0};
    companyMap[co].quoted++;
    if (isWon(getStatus(r))) companyMap[co].won++; else companyMap[co].lost++;
  });
  const companyRows = Object.entries(companyMap).sort((a,b)=>b[1].quoted-a[1].quoted);

  // Charts
  const barImg = await drawChart('bar', {
    labels: dayLabels,
    datasets: [{ data: quotedByDay, backgroundColor: hex(DLC_BLUE), borderRadius: 2, barPercentage: 0.7 }]
  }, {
    plugins:{ legend:{display:false} },
    scales:{
      x:{ grid:{display:false}, ticks:{color:'#475569',font:{size:8},maxRotation:0} },
      y:{ grid:{color:'#eee'}, ticks:{color:'#475569',font:{size:9},stepSize:1,precision:0}, beginAtZero:true }
    }
  }, 600, 160);

  const pieImg = await drawChart('pie', {
    labels:['Won','Lost'],
    datasets:[{ data:[wonJobs.length,lostJobs.length], backgroundColor:[hex(DLC_GREEN),hex(DLC_RED)], borderWidth:2, borderColor:'#fff' }]
  }, { plugins:{legend:{display:false}} }, 200, 200);

  const makeTypePie = splits => drawChart('pie', {
    labels:['Dryhire','Radios','Events'],
    datasets:[{ data:[splits.Dryhire,splits.Radios,splits.Events], backgroundColor:[hex(JT_DRYHIRE),hex(JT_RADIOS),hex(JT_EVENTS)], borderWidth:2, borderColor:'#fff' }]
  }, { plugins:{legend:{display:false}} }, 220, 220);

  const allTypeImg = await makeTypePie(allTypeSplit);
  const wonTypeImg = await makeTypePie(wonTypeSplit);

  // Build PDF
  const doc = new jsPDF({ orientation:'portrait', unit:'mm', format:'a4' });
  const PW=210, PH=297, ML=12, MR=12;
  const CW = PW-ML-MR;
  const FOOTER_H = 8;
  const USABLE_H = PH - FOOTER_H;

  const drawMonthFooter = label => drawPageFooter(doc, PW, PH, label);

  let y = drawPageHeader(doc, PW, PH, ML, CW, title, genDate);

  doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(100,116,139);
  doc.text(periodLabel, ML, y); y += 8;

  // KPIs
  const cards = [
    { label:'Jobs Quoted',   value: String(totalQuoted) },
    { label:'Jobs Outgoing', value: String(outgoingJobs.length) },
    { label:'Jobs Won',      value: String(wonJobs.length) },
    { label:'Jobs Lost',     value: String(lostJobs.length) },
    { label:'Win Rate',      value: outgoingJobs.length ? Math.round(wonJobs.length/outgoingJobs.length*100)+'%' : '—' },
    { label:'Won Revenue',   value: fmtAED(wonRevenue) },
  ];
  const cardW = CW/3 - 2; const cardH = 18;
  cards.forEach((c,i) => {
    const cx = ML + (i%3)*(cardW+3);
    const cy = y + Math.floor(i/3)*(cardH+3);
    doc.setFillColor(245,247,251); doc.rect(cx,cy,cardW,cardH,'F');
    doc.setDrawColor(225,230,240); doc.setLineWidth(0.2); doc.rect(cx,cy,cardW,cardH,'S');
    doc.setFont('helvetica','bold'); doc.setFontSize(14); doc.setTextColor(...DLC_BLUE);
    doc.text(c.value, cx+cardW/2, cy+10, {align:'center'});
    doc.setFont('helvetica','normal'); doc.setFontSize(6.5); doc.setTextColor(100,116,139);
    doc.text(c.label, cx+cardW/2, cy+15, {align:'center'});
  });
  y += cardH*2 + 3*2 + 6;

  // Bar chart
  if (barImg) {
    doc.setFont('helvetica','bold'); doc.setFontSize(8); doc.setTextColor(...DLC_BLUE);
    doc.text('Jobs Quoted Per Day', ML, y); y += 4;
    doc.addImage(barImg,'PNG', ML, y, CW*0.75, 38); y += 42;
  }

  // Pies
  const pieY = y;
  doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(...DLC_BLUE);
  doc.text('Won / Lost', ML, y); doc.text('All Job Types', ML+65, y); doc.text('Won Job Types', ML+130, y);
  y += 3;
  if (pieImg)     doc.addImage(pieImg,    'PNG', ML,     y, 45, 45);
  if (allTypeImg) doc.addImage(allTypeImg,'PNG', ML+62,  y, 48, 48);
  if (wonTypeImg) doc.addImage(wonTypeImg,'PNG', ML+125, y, 48, 48);
  y = pieY + 52;

  const drawLegend = (items, xStart, yStart) => {
    items.forEach(([col, label], i) => {
      doc.setFillColor(...col); doc.rect(xStart, yStart+i*5, 3.5, 3.5, 'F');
      doc.setFont('helvetica','normal'); doc.setFontSize(6); doc.setTextColor(71,85,105);
      doc.text(label, xStart+5, yStart+i*5+3);
    });
  };
  drawLegend([[DLC_GREEN,'Won'],[DLC_RED,'Lost']], ML, pieY+48);
  drawLegend([[JT_DRYHIRE,'Dryhire'],[JT_RADIOS,'Radios'],[JT_EVENTS,'Events']], ML+62, pieY+48);
  drawLegend([[JT_DRYHIRE,'Dryhire'],[JT_RADIOS,'Radios'],[JT_EVENTS,'Events']], ML+125, pieY+48);
  y += 12;

  // Company table
  doc.setFont('helvetica','bold'); doc.setFontSize(8.5); doc.setTextColor(...DLC_BLUE);
  doc.text('Jobs by Company', ML, y); y += 4;

  const colW = [CW-60, 20, 20, 20]; const colX = [ML, ML+CW-60, ML+CW-40, ML+CW-20];
  const TBL_HDR_H = 7, TBL_ROW_H = 7;

  doc.setFillColor(232,237,245); doc.rect(ML,y,CW,TBL_HDR_H,'F');
  doc.setFont('helvetica','bold'); doc.setFontSize(6.5); doc.setTextColor(71,85,105);
  ['Company','Quotes','Won','Lost'].forEach((h,i) => {
    if (i===0) doc.text(h, colX[0]+2, y+4.2);
    else doc.text(h, colX[i]+colW[i]/2, y+4.2, {align:'center'});
  });
  y += TBL_HDR_H;
  doc.setFont('helvetica','normal'); doc.setFontSize(6.2);

  companyRows.forEach(([co, s], idx) => {
    if (y + TBL_ROW_H > USABLE_H) {
      drawMonthFooter('DLC Events CRM · Confidential · '+periodLabel+' (continued)');
      doc.addPage();
      y = drawPageHeader(doc, PW, PH, ML, CW, title, genDate);
      doc.setFillColor(232,237,245); doc.rect(ML,y,CW,TBL_HDR_H,'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(6.5); doc.setTextColor(71,85,105);
      ['Company','Quotes','Won','Lost'].forEach((h,i) => {
        if (i===0) doc.text(h, colX[0]+2, y+4.2);
        else doc.text(h, colX[i]+colW[i]/2, y+4.2, {align:'center'});
      });
      y += TBL_HDR_H;
      doc.setFont('helvetica','normal'); doc.setFontSize(6.2);
    }
    if (idx%2===0){ doc.setFillColor(250,251,253); doc.rect(ML,y,CW,TBL_ROW_H,'F'); }
    doc.setTextColor(15,23,42);   doc.text(String(co).substring(0,50), colX[0]+2, y+3.5);
    doc.setTextColor(...DLC_BLUE);  doc.text(String(s.quoted), colX[1]+colW[1]/2, y+3.5, {align:'center'});
    doc.setTextColor(...DLC_GREEN); doc.text(String(s.won),    colX[2]+colW[2]/2, y+3.5, {align:'center'});
    doc.setTextColor(...DLC_RED);   doc.text(String(s.lost),   colX[3]+colW[3]/2, y+3.5, {align:'center'});
    y += TBL_ROW_H;
    doc.setDrawColor(225,230,240); doc.setLineWidth(0.15); doc.line(ML,y,ML+CW,y);
  });

  drawMonthFooter('DLC Events CRM · Confidential · '+periodLabel);

  const mn = toLocaleDateStr(mStart,{month:'long',year:'numeric'}).replace(/ /g,'_');
  const filename = 'DLC_Monthly_Report_' + mn + '.pdf';

  return { pdf: doc.output('arraybuffer'), filename };
}

// ─── DROPBOX UPLOAD ──────────────────────────────────────────────────────────
function dropboxRequest(endpoint, body, isUpload = false) {
  return new Promise((resolve, reject) => {
    const bodyBuf = isUpload ? body : Buffer.from(JSON.stringify(body));
    const options = {
      hostname: 'api.dropboxapi.com',
      path: endpoint,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DBX_TOKEN}`,
        'Content-Length': bodyBuf.length,
      },
    };

    if (isUpload) {
      options.hostname = 'content.dropboxapi.com';
      options.headers['Content-Type'] = 'application/octet-stream';
      options.headers['Dropbox-API-Arg'] = JSON.stringify(body.apiArg);
    } else {
      options.headers['Content-Type'] = 'application/json';
    }

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(`Dropbox API ${res.statusCode}: ${JSON.stringify(parsed)}`));
          else resolve(parsed);
        } catch (e) {
          if (res.statusCode >= 400) reject(new Error(`Dropbox HTTP ${res.statusCode}: ${data}`));
          else resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.write(isUpload ? bodyBuf : bodyBuf);
    req.end();
  });
}

async function uploadToDropbox(pdfBuffer, filename) {
  const dropboxPath = DROPBOX_FOLDER + '/' + filename;
  console.log(`Uploading to Dropbox: ${dropboxPath}`);

  const buf = Buffer.from(pdfBuffer);

  // Use upload endpoint
  const result = await new Promise((resolve, reject) => {
    const apiArg = {
      path: dropboxPath,
      mode: 'overwrite',
      autorename: false,
      mute: false,
    };

    const options = {
      hostname: 'content.dropboxapi.com',
      path: '/2/files/upload',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DBX_TOKEN}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify(apiArg),
        'Content-Length': buf.length,
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(`Dropbox upload failed ${res.statusCode}: ${data}`));
          else resolve(parsed);
        } catch (e) {
          reject(new Error(`Dropbox parse error: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(buf);
    req.end();
  });

  console.log(`✅ Uploaded: ${result.path_display}`);
  return result;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  const mode = process.argv[2]; // 'weekly' or 'monthly'
  if (!['weekly','monthly'].includes(mode)) {
    console.error('Usage: node generate-report.js weekly|monthly');
    process.exit(1);
  }

  console.log(`\n── DLC Events ${mode.toUpperCase()} Report ──`);
  console.log('Fetching jobs from Supabase...');

  const allJobs = await fetchAllJobs();

  let result;
  if (mode === 'weekly') {
    console.log('Generating weekly PDF...');
    result = await generateWeeklyReport(allJobs);
  } else {
    console.log('Generating monthly PDF...');
    result = await generateMonthlyReport(allJobs);
  }

  console.log(`Generated: ${result.filename}`);
  await uploadToDropbox(result.pdf, result.filename);
  console.log('Done! ✅');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
