// scripts/fetch_counts.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';   // 在 GitHub Actions 中安装

const WINDOW_DAYS = 10;
const ENTRY_URL = 'https://www.workforceaustralia.gov.au/individuals/jobs';

const KEYWORDS = {
  // regional 五类
  cultivation: ['farm hand','farmhand','harvest','picker','picking','packing','pruner','horticulture','orchard','vineyard','cattle','shearing','poultry','abattoir','nursery'],
  fishing: ['fishing','deckhand','aquaculture','pearling','hatchery'],
  forestry: ['forestry','tree felling','silviculture','chainsaw','plantation'],
  mining: ['mining','pit','fifo','driller','shotfirer','excavator','haul truck'],
  construction: ['construction','labourer','scaffolder','concreter','formwork','bricklayer','carpenter','painter','plasterer'],
  // 远/北部 才计入
  hospo: ['hotel','motel','hostel','caravan park','housekeeper','bartender','barista','waiter','kitchen hand','chef','cook','restaurant','cafe','front of house']
};

// 粗略判断是否属于WHM可计行业（根据是否在远/北部或regional）
function isEligibleByKeywords(text, isRemoteOrNorth) {
  text = text.toLowerCase();
  const packs = [KEYWORDS.cultivation, KEYWORDS.fishing, KEYWORDS.forestry, KEYWORDS.mining, KEYWORDS.construction];
  if (isRemoteOrNorth) packs.push(KEYWORDS.hospo);
  return packs.some(list => list.some(k => text.includes(k)));
}

function parseAdded(text){
  // e.g., "Added 3 days ago" / "Added 8 hours ago" / "Added yesterday"
  const t = text.toLowerCase();
  if (t.includes('hour')) return 0;
  if (t.includes('yesterday')) return 1;
  const m = t.match(/added\s+(\d+)\s+day/);
  return m ? parseInt(m[1], 10) : 999;
}

function stateByPc(pc){
  const p = pc[0];
  if (p==='2') return 'NSW';
  if (p==='3') return 'VIC';
  if (p==='4') return 'QLD';
  if (p==='5') return 'SA';
  if (p==='6') return 'WA';
  if (p==='7') return 'TAS';
  if (p==='0' || p==='8' || p==='9') return 'NT';
  return 'Other';
}

// 读取 rules/eligibility.json（决定 hospo 是否计入）
const rules = JSON.parse(await fs.readFile('rules/eligibility.json','utf8'));
const remoteSet = new Set();
for (const [st, arr] of Object.entries(rules.remoteVeryRemoteByState)) {
  for (const token of arr) {
    const segs = String(token).split(',');
    for (const s of segs) {
      if (s.includes('-')) {
        const [a,b] = s.split('-').map(x=>parseInt(x,10));
        for (let n=a;n<=b;n++) remoteSet.add(String(n).padStart(4,'0'));
      } else {
        remoteSet.add(String(s).padStart(4,'0'));
      }
    }
  }
}
for (const line of rules.northern) {
  const [st, list] = line.split(':');
  if (list.trim()==='*') continue;
  for (const token of list.split(',')) {
    if (token.includes('-')) {
      const [a,b] = token.split('-').map(x=>parseInt(x,10));
      for (let n=a;n<=b;n++) remoteSet.add(String(n).padStart(4,'0'));
    } else {
      remoteSet.add(String(token).padStart(4,'0'));
    }
  }
}
for (const line of rules.remotePlusHospo) {
  const [_, list] = line.split(':');
  for (const token of list.split(',')) remoteSet.add(String(token).padStart(4,'0'));
}

// 取所有可能邮编（从 POA 或你自己维护的一份邮编列表；这里为演示，取 rules 推断州后扫描典型范围）
function* allCandidatePostcodes(){
  for (let i=200; i<=7999; i++){
    const pc = String(i).padStart(4,'0');
    const st = stateByPc(pc);
    // 仅覆盖常见取值范围，避免空洞；你也可以从 ABS POA 里导出所有 POA_CODE21
    if (['NSW','VIC','QLD','SA','WA','TAS','NT'].includes(st)) yield pc;
  }
}

const browser = await chromium.launch({headless:true});
const page = await browser.newPage();

async function countForPostcode(pc){
  const st = stateByPc(pc);
  // 判断该邮编是否 regional（五类行业生效）
  const regional = rules.regionalAllStates.includes(st) ||
    (rules.regionalByState[st]||[]).some(([a,b]) => pc>=a && pc<=b);
  const isRemoteOrNorth = remoteSet.has(pc);
  if (!regional && !isRemoteOrNorth) return 0; // 不可集签区域，直接 0

  // 打开搜索页，输入邮编关键词
  await page.goto(ENTRY_URL, {waitUntil:'domcontentloaded'});
  // Workforce Australia 是 SPA，需要等待组件加载（粗略等待&选择器示例，跑通后你可适配真实 DOM）
  await page.waitForTimeout(3000);
  await page.fill('input[placeholder*="Enter location"], input[aria-label="Search"]', pc).catch(()=>{});
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);

  // 解析岗位卡片（标题/摘要/“Added …”/地点），过滤近10天 + 行业关键词
  const items = await page.$$('[data-testid="job-card"], .job-card'); // 选择器示例
  let count = 0;
  for (const it of items){
    const title = (await it.textContent()) || '';
    const addedText = await it.textContent();
    const d = parseAdded(addedText||'');
    if (d > WINDOW_DAYS) continue;

    const blob = (await it.textContent()) || '';
    const ok = isEligibleByKeywords(blob, isRemoteOrNorth);
    if (ok) count++;
  }
  return count;
}

const counts = {};
for (const pc of allCandidatePostcodes()){
  // 可按需改为：只遍历 POA 中出现过的邮编，提高速度
  try {
    counts[pc] = await countForPostcode(pc);
  } catch(e){
    counts[pc] = 0;
  }
}

await fs.mkdir('data', {recursive:true});
await fs.writeFile('data/jobs-last10d.json', JSON.stringify({
  generatedAt: new Date().toISOString(),
  windowDays: WINDOW_DAYS,
  source: 'Workforce Australia (official)',
  countsByPostcode: counts
}, null, 2));
await browser.close();
console.log('OK');
