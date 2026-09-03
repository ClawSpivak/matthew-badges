#!/usr/bin/env node
/**
 * wegotused-scraper.js
 * Scrapes wegotused.com daily inventory, groups by make,
 * and flags cars with collectible badges not yet in the collection.
 *
 * Usage:
 *   node wegotused-scraper.js              # Run check, send Telegram if finds
 *   node wegotused-scraper.js --dry-run    # Print to stdout, no Telegram
 *   node wegotused-scraper.js --dump       # Dump raw inventory JSON
 */

const puppeteer = require('/Users/clawspivak/.openclaw/workspace-chookcha/node_modules/puppeteer-core');
const fs = require('fs');
const https = require('https');
const path = require('path');

const CHROMIUM = '/Applications/Chromium.app/Contents/MacOS/Chromium';
const STATE_FILE = '/Users/clawspivak/badge-hunter/state/wegotused-state.json';
const COLLECTION_FILE = '/Users/clawspivak/badge-hunter/state/badge-collection.json';
const TELEGRAM_TOKEN = '8750057664:AAHQ7_idVGVxS9w6iAAVCZ83szJ1HdeuuHY';
const TELEGRAM_CHAT_ID = '1699110096';

const DRY_RUN = process.argv.includes('--dry-run');
const DUMP = process.argv.includes('--dump');
const FULL = process.argv.includes('--full'); // Pull all yards, all 4000+ records

const INVENTORY_PENNSBURG = 'https://wegotused.com/our-inventory/?inv[yard]=pennsburg&inv[make]=&inv[model]=&inv[manufacturer]=&inv[year]=&inv[part]=&inv[sort][yard_date]=0';
const INVENTORY_ALLENTOWN = 'https://wegotused.com/our-inventory/?inv[yard]=allentown&inv[make]=&inv[model]=&inv[manufacturer]=&inv[year]=&inv[part]=&inv[sort][yard_date]=0';
const INVENTORY_ALL = 'https://wegotused.com/our-inventory/?inv[yard]=all&inv[make]=&inv[model]=&inv[manufacturer]=&inv[year]=&inv[part]=&inv[sort][yard_date]=0&inv[sort][yard_city]=1';

// Default (no flag): Pennsburg + Allentown, both within reasonable driving
// distance. Hazle Township is excluded — ~90mi, deliberately not monitored.
// --full pulls every yard including Hazle Township (~4500+ records).
const DEFAULT_YARDS = [
  { label: 'Pennsburg', base: INVENTORY_PENNSBURG },
  { label: 'Allentown', base: INVENTORY_ALLENTOWN },
];

// ── Badges worth hunting ─────────────────────────────────────────────
const BADGE_TARGETS = [
  // Luxury / exotic
  { keywords: ['rolls-royce', 'rolls royce'],     badge: 'Spirit / Flying Lady',       tier: 'RARE' },
  { keywords: ['bentley'],                         badge: 'Bentley B-wing',              tier: 'RARE' },
  { keywords: ['lamborghini'],                     badge: 'Raging Bull',                 tier: 'RARE' },
  { keywords: ['ferrari'],                         badge: 'Prancing Horse',              tier: 'RARE' },
  { keywords: ['maserati'],                        badge: 'Maserati Trident',            tier: 'HIGH' },
  { keywords: ['aston martin', 'aston-martin'],   badge: 'AM Wings',                    tier: 'HIGH' },
  { keywords: ['bugatti'],                         badge: 'Bugatti Macaron',             tier: 'RARE' },
  { keywords: ['porsche'],                         badge: 'Porsche Crest',               tier: 'HIGH' },
  { keywords: ['alfa romeo'],                      badge: 'Alfa Cloverleaf / Scudetto',  tier: 'HIGH' },
  { keywords: ['delorean'],                        badge: 'DeLorean DMC badge',          tier: 'HIGH' },
  { keywords: ['lotus'],                           badge: 'Lotus badge',                 tier: 'HIGH' },

  // German performance trims
  { keywords: ['amg'],                             badge: 'AMG badge',                   tier: 'MED'  },
  { keywords: ['bmw m3'],                          badge: 'BMW M3 badge',                tier: 'MED'  },
  { keywords: ['bmw m5'],                          badge: 'BMW M5 badge',                tier: 'MED'  },
  { keywords: ['bmw m6'],                          badge: 'BMW M6 badge',                tier: 'MED'  },
  { keywords: ['audi rs'],                         badge: 'Audi RS badge',               tier: 'MED'  },
  { keywords: ['quattro'],                         badge: 'Quattro badge',               tier: 'MED'  },
  { keywords: ['volkswagen r32', 'vw r32'],        badge: 'R32 badge',                   tier: 'MED'  },

  // American muscle / rare trims
  { keywords: ['shelby'],                          badge: 'Shelby Cobra badge',          tier: 'HIGH' },
  { keywords: ['boss 302'],                        badge: 'Boss 302 badge',              tier: 'HIGH' },
  { keywords: ['boss 429'],                        badge: 'Boss 429 badge',              tier: 'RARE' },
  { keywords: ['hellcat'],                         badge: 'Hellcat badge',               tier: 'MED'  },
  { keywords: ['demon'],                           badge: 'Dodge Demon badge',           tier: 'HIGH' },
  { keywords: ['viper'],                           badge: 'Viper snake badge',           tier: 'HIGH' },
  { keywords: ['corvette zr1', 'zr1'],            badge: 'ZR1 badge',                   tier: 'HIGH' },
  { keywords: ['corvette z06', 'z06'],            badge: 'Z06 badge',                   tier: 'MED'  },
  { keywords: ['grand sport'],                     badge: 'Grand Sport badge',           tier: 'MED'  },
  { keywords: ['yenko'],                           badge: 'Yenko badge',                 tier: 'RARE' },
  { keywords: ['copo'],                            badge: 'COPO badge',                  tier: 'RARE' },
  { keywords: ['hurst'],                           badge: 'Hurst badge',                 tier: 'MED'  },

  // Classic American brands
  { keywords: ['eldorado'],                        badge: 'Eldorado badge',              tier: 'MED'  },
  { keywords: ['deville'],                         badge: 'DeVille crest',               tier: 'MED'  },
  { keywords: ['fleetwood'],                       badge: 'Fleetwood badge',             tier: 'MED'  },
  { keywords: ['lincoln continental'],             badge: 'Continental star',            tier: 'MED'  },
  { keywords: ['thunderbird'],                     badge: 'Thunderbird badge',           tier: 'MED'  },
  { keywords: ['riviera'],                         badge: 'Buick Riviera badge',         tier: 'MED'  },
  { keywords: ['toronado'],                        badge: 'Toronado badge',              tier: 'MED'  },
  { keywords: ['stutz'],                           badge: 'Stutz badge',                 tier: 'RARE' },
  { keywords: ['tucker'],                          badge: 'Tucker badge',                tier: 'RARE' },

  // Japanese collectible
  { keywords: ['nsx'],                             badge: 'NSX badge',                   tier: 'HIGH' },
  { keywords: ['type r'],                          badge: 'Honda Type R badge',          tier: 'MED'  },
  { keywords: ['supra'],                           badge: 'Toyota Supra badge',          tier: 'MED'  },
  { keywords: ['gt-r', 'gtr', 'skyline'],         badge: 'Nissan GT-R / Skyline badge', tier: 'HIGH' },
  { keywords: ['rx-7', 'rx7'],                    badge: 'Mazda RX-7 badge',            tier: 'MED'  },
  { keywords: ['lancer evolution', 'lancer evo'], badge: 'Mitsubishi Evo badge',        tier: 'MED'  },
  { keywords: ['wrx sti'],                         badge: 'Subaru STI badge',            tier: 'MED'  },
  { keywords: ['2000gt'],                          badge: 'Toyota 2000GT badge',         tier: 'RARE' },

  // SUV / truck collector
  { keywords: ['ford bronco'],                     badge: 'Bronco badge',                tier: 'MED'  },
  { keywords: ['land rover defender'],             badge: 'Defender badge',              tier: 'MED'  },
  { keywords: ['toyota fj'],                       badge: 'FJ badge',                    tier: 'MED'  },
];

// ── Load / save state ─────────────────────────────────────────────────
function loadCollection() {
  if (!fs.existsSync(COLLECTION_FILE)) return { badges: [] };
  return JSON.parse(fs.readFileSync(COLLECTION_FILE, 'utf8'));
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { lastSeen: {}, lastRunDate: null };
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Badge check ───────────────────────────────────────────────────────
function checkBadge(year, make, model, collection) {
  const haystack = `${year} ${make} ${model}`.toLowerCase();
  // badges array may contain objects (full badge records) or plain strings
  const owned = (collection.badges || []).map(b => {
    if (typeof b === 'string') return b.toLowerCase();
    // object form: build a searchable string from make/model/badge_name
    return `${b.make || ''} ${b.model || ''} ${b.badge_name || ''}`.toLowerCase();
  });

  for (const target of BADGE_TARGETS) {
    const matches = target.keywords.some(k => haystack.includes(k.toLowerCase()));
    if (!matches) continue;
    const alreadyOwned = owned.some(b =>
      target.keywords.some(k => b.includes(k.toLowerCase())) ||
      b.includes(target.badge.toLowerCase())
    );
    if (!alreadyOwned) return target;
  }
  return null;
}

// ── Scrape one page ───────────────────────────────────────────────────
async function scrapePage(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise(r => setTimeout(r, 2000));

  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tr'));
    return rows.map(r => r.innerText.trim()).filter(t => t.length > 10);
  });
}

// ── Parse tab-separated row ───────────────────────────────────────────
function parseRow(raw) {
  const parts = raw.split('\t').map(p => p.trim());
  // Format: YARD_CITY | YEAR | MAKE | MODEL | MANUFACTURER | COLOR | YARD_DATE | ROW | VIN | ...
  if (parts.length < 7) return null;
  const year = parts[1];
  if (!/^(19|20)\d{2}$/.test(year)) return null;

  return {
    yard: parts[0],
    year: parts[1],
    make: parts[2],
    model: parts[3],
    color: parts[5] || '',
    yardDate: parts[6] || '',
    row: parts[7] || '',
    vin: parts[8] || '',
  };
}

// ── Scrape one yard (paginated) using a shared browser page ────────────
async function scrapeYard(page, baseUrl, opts = {}) {
  const { maxPages, stopAfterDate = null, label = '' } = opts;
  const allRows = [];
  let pageIdx = 0; // inv[page] is 0-indexed after first page
  let done = false;

  while (!done && pageIdx <= maxPages) {
    const url = pageIdx === 0
      ? baseUrl
      : `${baseUrl}&inv[page]=${pageIdx}`;

    console.error(`[${label}] Fetching page ${pageIdx + 1} (inv[page]=${pageIdx})... total so far: ${allRows.length}`);

    let rows;
    try {
      rows = await scrapePage(page, url);
    } catch (e) {
      console.error(`[${label}] Page ${pageIdx} error: ${e.message}`);
      break;
    }

    const cars = rows.map(parseRow).filter(Boolean);
    if (cars.length === 0) break;

    allRows.push(...cars);

    // If stopAfterDate set, stop once we're past cars from that date
    if (stopAfterDate && cars.length > 0) {
      const oldestOnPage = cars[cars.length - 1];
      if (oldestOnPage.yardDate) {
        const [m, d, y] = oldestOnPage.yardDate.split('/');
        const isoDate = `${y}-${m}-${d}`;
        if (isoDate < stopAfterDate) {
          console.error(`[${label}] Reached cars older than ${stopAfterDate}, stopping.`);
          done = true;
        }
      }
    }

    // Check for next page link
    const hasNext = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      return links.some(l => l.href && l.href.includes('inv[page]='));
    });

    if (!hasNext) break;
    pageIdx++;
  }

  return allRows;
}

// ── Main scrape ───────────────────────────────────────────────────────
// Default: Pennsburg + Allentown (DEFAULT_YARDS), one page per yard scan.
// --full: single scan of every yard via inv[yard]=all (includes Hazle Township).
async function scrapeAll(opts = {}) {
  const { fullScan = false, stopAfterDate = null } = opts;

  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

  let allRows = [];

  if (fullScan) {
    allRows = await scrapeYard(page, INVENTORY_ALL, { maxPages: 300, stopAfterDate, label: 'ALL' });
  } else {
    for (const yard of DEFAULT_YARDS) {
      const rows = await scrapeYard(page, yard.base, { maxPages: 10, stopAfterDate, label: yard.label });
      allRows.push(...rows);
    }
  }

  await browser.close();
  return allRows;
}

// ── Send Telegram ─────────────────────────────────────────────────────
function sendTelegram(msg) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => resolve(res.statusCode));
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────
(async () => {
  const state = loadState();
  const lastRunDate = state.lastRunDate || null;

  // For daily runs: only fetch pages until we're past yesterday's date
  // For --full: fetch everything
  const cars = await scrapeAll({
    fullScan: FULL,
    stopAfterDate: (!FULL && !DUMP && lastRunDate) ? lastRunDate : null,
  });
  console.error(`Total vehicles fetched: ${cars.length}`);

  if (DUMP) {
    console.log(JSON.stringify(cars, null, 2));
    process.exit(0);
  }

  const collection = loadCollection();
  const today = new Date().toISOString().slice(0, 10);

  // Find cars added since last run
  const sinceDate = state.lastRunDate || today;
  const newToday = cars.filter(c => {
    if (!c.yardDate) return false;
    const [m, d, y] = c.yardDate.split('/');
    const isoDate = `${y}-${m}-${d}`;
    return isoDate >= sinceDate;
  });

  // Group ALL inventory by make
  const byMake = {};
  for (const car of cars) {
    const make = car.make || 'Unknown';
    if (!byMake[make]) byMake[make] = 0;
    byMake[make]++;
  }

  // Badge hits in NEW arrivals
  const hits = [];
  for (const car of newToday) {
    const badge = checkBadge(car.year, car.make, car.model, collection);
    if (badge) hits.push({ ...car, badge });
  }

  // Build message
  const makesSummary = Object.entries(byMake)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([make, count]) => `  ${make}: ${count}`)
    .join('\n');

  const yardLabel = FULL ? 'All Yards' : '📍 Pennsburg + Allentown';
  let msg = `🚗 <b>WeGotUsed ${yardLabel} — ${today}</b>\n`;
  msg += `${cars.length} vehicles | ${newToday.length} new since last check\n\n`;

  if (newToday.length > 0) {
    const MAX_LISTED = 40;
    msg += `<b>New Arrivals (${newToday.length}):</b>\n`;
    for (const c of newToday.slice(0, MAX_LISTED)) {
      msg += `• ${c.year} ${c.make} ${c.model} [${c.yard}]\n`;
    }
    if (newToday.length > MAX_LISTED) {
      msg += `  …and ${newToday.length - MAX_LISTED} more\n`;
    }
    msg += `\n`;
  }

  msg += `<b>By Make (all inventory):</b>\n${makesSummary}\n`;

  const pennsburgHits = hits.filter(h => h.yard === 'PENNSBURG');
  const otherHits = hits.filter(h => h.yard !== 'PENNSBURG');

  if (hits.length > 0) {
    if (pennsburgHits.length > 0) {
      msg += `\n📍 <b>PENNSBURG BADGE ALERTS — ${pennsburgHits.length} nearby:</b>\n`;
      for (const h of pennsburgHits) {
        const icon = h.badge.tier === 'RARE' ? '🔴' : h.badge.tier === 'HIGH' ? '🟠' : '🟡';
        msg += `${icon} ${h.year} ${h.make} ${h.model} → <b>${h.badge.badge}</b>\n`;
        if (h.vin) msg += `   VIN: ${h.vin}\n`;
      }
    }
    if (otherHits.length > 0) {
      msg += `\n🏷️ <b>OTHER BADGE ALERTS (${otherHits.length}):</b>\n`;
      for (const h of otherHits) {
        const icon = h.badge.tier === 'RARE' ? '🔴' : h.badge.tier === 'HIGH' ? '🟠' : '🟡';
        msg += `${icon} ${h.year} ${h.make} ${h.model} [${h.yard}] → <b>${h.badge.badge}</b>\n`;
        if (h.vin) msg += `   VIN: ${h.vin}\n`;
      }
    }
  } else if (newToday.length > 0) {
    msg += `\n✅ No badge targets in today's ${newToday.length} new arrivals.`;
  } else {
    msg += `\n✅ No new arrivals since last check.`;
  }

  // Save state
  state.lastRunDate = today;
  state.lastCount = cars.length;
  saveState(state);

  if (DRY_RUN) {
    console.log(msg.replace(/<[^>]+>/g, ''));
    if (newToday.length > 0) {
      console.log(`\nNew arrivals (${newToday.length}):`);
      newToday.forEach(c => console.log(`  ${c.year} ${c.make} ${c.model} [${c.yardDate}] ${c.yard}`));
    }
  } else {
    await sendTelegram(msg);
    console.log('Sent to Telegram.');
  }
})();
