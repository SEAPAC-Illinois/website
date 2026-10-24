// Builds data/bills.json: Illinois bills that touch special education, with each
// bill's sponsors, summary, status, and latest actions.
//
// Source: the General Assembly's public file repository (ftp.ilga.gov), which ILGA
// syncs nightly and points automated readers to. Its server leaves out an
// intermediate certificate, so plain curl/Python can't verify it; Chrome fetches
// the missing certificate itself, so the files are read through headless Chrome.
//
// Usage: node scripts/bill_watch.mjs            (daily run; full rescan on Sundays)
//        node scripts/bill_watch.mjs --full     (rescan every bill)
//        node scripts/bill_watch.mjs --fixtures DIR   (offline test: DIR holds listing-<GA>.html and XML files)
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = process.env.BILLS_OUT || join(ROOT, 'data/bills.json');
const PUBLIC_OUT = process.env.BILLS_PUBLIC_OUT || join(ROOT, 'data/bills-public.json');
const CONFIG = join(ROOT, 'data/bill-watch-config.json');
const BILL_TYPES = new Set(['HB', 'SB', 'HR', 'SR', 'HJR', 'SJR', 'HJRCA', 'SJRCA']);
const KEEP_CHANGES_DAYS = 60;
const PREVIOUS_GA_ACTIVE_DAYS = 45;

const args = process.argv.slice(2);
const fixtures = args.includes('--fixtures') ? args[args.indexOf('--fixtures') + 1] : null;
const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
const configHash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 12);
const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
const now = new Date();
const full = args.includes('--full') || !prev || prev.config !== configHash || now.getUTCDay() === 0;

// ---------- fetching ----------

// Same rule as the in-page decoder below: follow the XML declaration, default UTF-8.
function decodeBytes(buf) {
  const enc = (buf.subarray(0, 200).toString('latin1').match(/encoding=['"]([^'"]+)['"]/i) || [, 'utf-8'])[1];
  return new TextDecoder(/8859|1252|latin/i.test(enc) ? 'windows-1252' : 'utf-8').decode(buf);
}

async function openSource() {
  if (fixtures) {
    return {
      async text(path) {
        const name = path.endsWith('/') ? 'listing-' + (path.match(/\/(\d+)\//) || [])[1] + '.html' : path.split('/').pop();
        if (path === '/Legislation/') return readdirSync(fixtures).filter(f => f.startsWith('listing-')).map(f => `<A HREF="/Legislation/${f.slice(8, -5)}/">`).join('\n');
        const p = join(fixtures, name);
        return existsSync(p) ? decodeBytes(readFileSync(p)) : null;
      },
      async many(paths) { return Promise.all(paths.map(async p => [p, await this.text(p)])); },
      async close() {},
    };
  }
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  await page.goto('https://ftp.ilga.gov/', { timeout: 90000 });
  // Decode by the XML declaration (current files say UTF-8, some older ones ISO-8859-1) rather than trusting .text().
  const getMany = (paths) => page.evaluate(async (paths) => Promise.all(paths.map(async (p) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(p);
        if (r.status === 404) return [p, null];
        if (r.ok) {
          const bytes = new Uint8Array(await r.arrayBuffer());
          const head = new TextDecoder('windows-1252').decode(bytes.slice(0, 200));
          const enc = (head.match(/encoding=['"]([^'"]+)['"]/i) || [, 'utf-8'])[1];
          return [p, new TextDecoder(/8859|1252|latin/i.test(enc) ? 'windows-1252' : 'utf-8').decode(bytes)];
        }
      } catch (e) { /* retry */ }
      await new Promise(res => setTimeout(res, 1500 * (attempt + 1)));
    }
    return [p, undefined];
  })), paths);
  return {
    async text(path) { return (await getMany([path]))[0][1]; },
    async many(paths) {
      const out = [];
      for (let i = 0; i < paths.length; i += 20) out.push(...await getMany(paths.slice(i, i + 20)));
      return out;
    },
    async close() { await browser.close(); },
  };
}

// ---------- parsing ----------

const decode = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
const tag = (xml, name) => { const m = xml.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>', 'i')); return m ? decode(m[1]) : ''; };
const tags = (xml, name) => [...xml.matchAll(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>', 'gi'))].map(m => decode(m[1]));

function parseListing(html) {
  const re = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s+(AM|PM)\s+\d+\s+<A HREF="([^"]+\.xml)"/gi;
  const files = [];
  for (const m of html.matchAll(re)) {
    let h = Number(m[4]) % 12 + (m[6].toUpperCase() === 'PM' ? 12 : 0);
    const stamp = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}T${String(h).padStart(2, '0')}:${m[5]}`;
    const id = m[7].split('/').pop().match(/^(\d{2,3})00([A-Z]+)(\d+)\.xml$/i);
    if (!id || !BILL_TYPES.has(id[2].toUpperCase())) continue;
    files.push({ path: m[7], stamp, ga: Number(id[1]), type: id[2].toUpperCase(), num: Number(id[3]) });
  }
  return files;
}

const usDate = (s) => { const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : s; };

function parseBill(xml) {
  const block = (xml.match(/<actions>([\s\S]*?)<\/actions>/i) || [, ''])[1];
  const actions = [...block.matchAll(/<statusdate>([\s\S]*?)<\/statusdate>\s*<chamber>([\s\S]*?)<\/chamber>\s*<action>([\s\S]*?)<\/action>/gi)]
    .map(m => ({ date: usDate(decode(m[1])), chamber: decode(m[2]), action: decode(m[3]) }));
  return {
    title: tag(xml, 'shortdesc'),
    sponsors: tags(xml, 'sponsors').join('; '),
    altsponsors: tags(xml, 'altsponsors').join('; ').replace(/^\((.*)\)$/, '$1'),
    references: tags(xml, 'reference'),
    synopsis: tags(xml, 'SynopsisText').join(' '),
    actions,
  };
}

// Returns the bill's tags and the IAASE platform items its matches point to (empty tags = not watched).
function match(bill, key) {
  const none = { tags: [], platform: [] };
  if (config.never.includes(key)) return none;
  if (/^(H|S)R$/.test(key.replace(/\d+$/, '')) && (config.skipResolutionTitles || []).some(t => bill.title.startsWith(t))) return none;
  const found = new Set();
  const platform = new Set();
  const hit = (rule) => { found.add(rule.tag); for (const p of rule.platform || []) platform.add(p); };
  if (config.always.includes(key)) found.add('watch-list');
  const refs = bill.references.join(' | ');
  for (const s of config.statutes) if (refs.includes(s.pattern)) hit(s);
  const text = (bill.title + ' ' + bill.synopsis).toLowerCase();
  const schoolCode = /105 ILCS 5\//.test(refs);
  const title = bill.title.toLowerCase();
  for (const p of config.phrases) {
    if (p.needsSchoolCode && !schoolCode) continue;
    const t = p.text.toLowerCase();
    if (p.field === 'title' ? new RegExp(p.text, 'i').test(title) : text.includes(t)) hit(p);
  }
  if (/\bIEPs?\b/.test(bill.synopsis)) hit({ tag: 'special-ed' });
  const items = config.platformItems || {};
  return { tags: [...found].sort(), platform: [...platform].sort().map(k => items[k] || k) };
}

// Walks the actions in order to describe where the bill stands now.
function stage(actions) {
  let s = { label: 'Filed', committee: null, law: null, active: true };
  for (const { action: a } of actions) {
    let m;
    if ((m = a.match(/Public Act[ .]+(\d{2,3}-\d{3,4})/i))) s = { label: 'Law, Public Act ' + m[1], committee: null, law: m[1], active: false };
    else if (s.law) continue;
    else if (/Total Veto Stands/i.test(a)) s = { label: 'Vetoed', committee: null, active: false };
    else if (/Governor Approved/i.test(a)) s = { label: 'Signed by the Governor', committee: null, active: false };
    else if (/Governor Amendatory Veto|Governor Vetoed|^Vetoed/i.test(a)) s = { label: 'Vetoed; the General Assembly may act on the veto', committee: null, active: true };
    else if (/Sent to the Governor/i.test(a)) s = { label: 'On the Governor\'s desk', committee: null, active: true };
    else if (/Passed Both Houses/i.test(a)) s = { label: 'Passed both houses', committee: null, active: true };
    else if (/Session Sine Die/i.test(a)) s = { label: 'Died when the session ended', committee: null, active: false };
    // Covers "Rule 19(a) / Re-referred to Rules Committee" too, which is how a bill that missed a deadline goes back to Rules.
    else if ((m = a.match(/(?:^|\/ )(?:Assigned|Referred|Re-referred|Re-assigned) to (?:the )?(.+?)(?: Committee)?$/i))) {
      const c = m[1].trim();
      s = /^(Rules|Assignments)$/i.test(c)
        ? { label: /Rules/i.test(c) ? 'Waiting in the House Rules Committee' : 'Waiting in Senate Assignments', committee: null, active: true }
        : { label: 'In committee: ' + c, committee: c, active: true };
    }
    else if ((m = a.match(/Placed on Calendar (?:Order of )?(2nd|3rd|Second|Third) Reading/i))) s = { label: 'On the floor (' + m[1].replace('Second', '2nd').replace('Third', '3rd') + ' reading)', committee: null, active: true };
    else if (/Third Reading - (?:Short Debate - )?Passed/i.test(a)) s = { ...s, label: 'Passed one chamber', committee: null };
    else if (/^Arrive in (House|Senate)/i.test(a)) s = { label: 'Arrived in the ' + a.match(/House|Senate/i)[0], committee: null, active: true };
  }
  return s;
}

// GAID and SessionID follow the General Assembly number (103rd: 17 and 112; 104th: 18 and 114).
// One plain sentence for the website: the first sentence of the synopsis that says what the bill does.
function summarize(bill) {
  const sentences = bill.synopsis.split(/(?<=\.)\s+(?=[A-Z])/);
  const pick = sentences.find(x => !/^(Amends|Creates the|Effective|Makes a technical change|Makes technical changes|Contains a)/i.test(x)) || sentences[0] || '';
  return pick.length > 600 ? pick.slice(0, 597).replace(/\s+\S*$/, '') + '...' : pick;
}

const billUrl = (ga, type, num) => `https://www.ilga.gov/Legislation/BillStatus?DocNum=${num}&GAID=${ga - 86}&GA=${ga}&DocTypeID=${type}&SessionID=${2 * ga - 94}`;

// ---------- run ----------

const source = await openSource();
try {
  const top = await source.text('/Legislation/');
  const gaDirs = [...new Set([...(top || '').matchAll(/HREF="\/Legislation\/(\d{2,3})\/"/gi)].map(m => Number(m[1])))].sort((a, b) => b - a);
  if (!gaDirs.length) throw new Error('Could not read the list of General Assemblies.');

  const listings = {};
  for (const ga of gaDirs.slice(0, 2)) {
    const html = await source.text(`/Legislation/${ga}/BillStatus/XML/`);
    const files = html ? parseListing(html) : [];
    if (files.length) listings[ga] = files;
  }
  const newest = Math.max(...Object.keys(listings).map(Number));
  if (!Number.isFinite(newest)) throw new Error('No bill status listing found.');
  const gas = [newest];
  const older = listings[newest - 1];
  if (older) {
    const last = older.reduce((a, f) => (f.stamp > a ? f.stamp : a), '');
    if ((now - new Date(last + 'Z')) / 864e5 <= PREVIOUS_GA_ACTIVE_DAYS) gas.push(newest - 1);
  }

  const prevBills = new Map((prev?.bills || []).map(b => [b.id, b]));
  const since = {};
  const toFetch = [];
  for (const ga of gas) {
    const mark = !full && prev?.listing_newest?.[ga];
    // ILGA syncs nightly, so re-read anything stamped within two days of the last run's newest file.
    since[ga] = mark ? new Date(new Date(mark + 'Z') - 2 * 864e5).toISOString().slice(0, 16) : '';
    for (const f of listings[ga]) if (!mark || f.stamp >= since[ga]) toFetch.push(f);
  }

  const fetched = await source.many(toFetch.map(f => f.path));
  const failed = fetched.filter(([, x]) => x === undefined).length;
  if (failed > toFetch.length * 0.05 + 5) throw new Error(`${failed} of ${toFetch.length} files failed to download; keeping the previous data.`);

  const bills = new Map();
  if (!full) for (const [id, b] of prevBills) if (gas.includes(b.ga)) bills.set(id, b);
  const changes = (prev?.changes || []).filter(c => (now - new Date(c.seen)) / 864e5 <= KEEP_CHANGES_DAYS);
  const seen = now.toISOString();
  const byPath = new Map(toFetch.map(f => [f.path, f]));
  for (const [path, xml] of fetched) {
    if (!xml) continue;
    const f = byPath.get(path);
    const id = `${f.ga}-${f.type}${f.num}`;
    const parsed = parseBill(xml);
    const { tags: tagsFound, platform } = match(parsed, `${f.type}${f.num}`);
    if (!tagsFound.length) { bills.delete(id); continue; }
    const st = stage(parsed.actions);
    const old = prevBills.get(id);
    const bill = {
      id, ga: f.ga, number: `${f.type} ${f.num}`, title: parsed.title, tags: tagsFound, platform,
      sponsors: parsed.sponsors.slice(0, 300),
      altsponsors: parsed.altsponsors.slice(0, 300),
      summary: summarize(parsed),
      synopsis: parsed.synopsis.length > 700 ? parsed.synopsis.slice(0, 697).replace(/\s+\S*$/, '') + '...' : parsed.synopsis,
      references: parsed.references.slice(0, 12),
      status: st.label, committee: st.committee, active: st.active,
      last_action: parsed.actions[parsed.actions.length - 1] || null,
      recent_actions: parsed.actions.slice(-8).reverse(),
      action_count: parsed.actions.length,
      url: billUrl(f.ga, f.type, f.num),
      first_seen: old?.first_seen || seen.slice(0, 10),
    };
    if (prev && !old) changes.push({ seen, bill: id, number: bill.number, title: bill.title, kind: 'newly-watched', ...bill.last_action });
    else if (old && parsed.actions.length > old.action_count) {
      for (const a of parsed.actions.slice(old.action_count)) changes.push({ seen, bill: id, number: bill.number, title: bill.title, kind: 'action', ...a });
    }
    bills.set(id, bill);
  }

  const list = [...bills.values()].sort((a, b) => (b.last_action?.date || '').localeCompare(a.last_action?.date || '') || a.id.localeCompare(b.id));
  const listingNewest = {};
  for (const ga of gas) listingNewest[ga] = listings[ga].reduce((a, f) => (f.stamp > a ? f.stamp : a), '');
  const out = {
    source: 'Illinois General Assembly public file repository (https://ftp.ilga.gov/), synced nightly by ILGA. Hearing dates are not in this source.',
    updated: seen,
    general_assemblies: gas,
    scan: full ? 'full' : 'incremental',
    files_read: toFetch.length,
    config: configHash,
    listing_newest: listingNewest,
    counts: { watched: list.length, active: list.filter(b => b.active).length },
    bills: list,
    changes: changes.sort((a, b) => (b.seen + b.date).localeCompare(a.seen + a.date)),
  };
  // Only rewrite the file when the watched bills change, so quiet days make no commit.
  const same = prev && prev.config === configHash && JSON.stringify(prev.bills) === JSON.stringify(out.bills)
    && JSON.stringify(prev.changes) === JSON.stringify(out.changes) && String(prev.general_assemblies) === String(gas);
  if (!same) {
    writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
    // A small file for the website: bills still in play, most recent movement first.
    const pub = list.filter(b => b.active && b.ga === gas[0]).slice(0, 40).map(b => ({
      number: b.number, url: b.url, title: b.title, summary: b.summary, status: b.status,
      date: b.last_action?.date || '', action: b.last_action?.action || '',
    }));
    writeFileSync(PUBLIC_OUT, JSON.stringify({ updated: seen, watched: list.length, bills: pub }, null, 1) + '\n');
  }
  console.log(same ? 'No changes to watched bills. ' : '', `GA ${gas.join(', ')}: read ${toFetch.length} files (${out.scan}), watching ${list.length} bills, ${changes.length} changes kept.`);
} finally {
  await source.close();
}
