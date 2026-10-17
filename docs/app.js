'use strict';
const NCCC = 'https://travel.nccc.com.tw/NASApp/NTC/servlet/com.du.mvc.EntryServlet';
const PAGE = 200;
const $ = id => document.getElementById(id);
const detailUrl = id => `${NCCC}?Action=RetailerEdit&Type=GetFull&Id=${id}&RequestType=0`;

let meta, gName = {}, tName = {};
let rows = [], matched = [], shown = 0;

// 統一比對用字串：全半形、大小寫、臺→台、空白標點，並去除公司後綴
const SUFFIX = /股份有限公司|有限公司|分公司|營業所|[-－﹣](網路|ec)(\.?app)?/g;
function norm(s) {
  return s.normalize('NFKC').toLowerCase().replace(/臺/g, '台')
    .replace(SUFFIX, '').replace(/[\s\-_.,，、()（）]/g, '');
}
const digits = s => s.normalize('NFKC').replace(/\D/g, '');

async function getJSON(name) {
  const r = await fetch(`data/${encodeURIComponent(name)}.json`);
  if (!r.ok) throw new Error(name + ' ' + r.status);
  return r.json();
}

function fill(sel, items, first) {
  sel.innerHTML = '';
  sel.add(new Option(first, ''));
  items.forEach(([v, t]) => sel.add(new Option(t, v)));
}

async function init() {
  meta = await getJSON('meta');
  $('updated').textContent = meta.updated;
  $('total').textContent = meta.total.toLocaleString();
  meta.cats.forEach(g => { gName[g.g] = g.n; g.t.forEach(t => tName[t.c] = t.n); });
  fill($('city'), Object.entries(meta.counts).map(([c, n]) => [c, `${c}（${n.toLocaleString()}）`]), '請選擇縣市');
  fill($('gmcc'), meta.cats.map(g => [g.g, g.n]), '全部');
  loadChanges();
  loadTaxi();
}

async function loadChanges() {
  const c = await getJSON('changes');
  $('chg-sum').textContent = `（新增 ${c.added.length}、解約 ${c.removed.length}；計程車不列）`;
  const list = (title, arr) => {
    if (!arr.length) return `<h3>${title}</h3><p class="note">無</p>`;
    const li = arr.slice(0, 300).map(r =>
      `<li>${esc(r.n)}　<span class="meta">${esc(r.a)}</span> <a href="${detailUrl(r.i)}" target="_blank" rel="noopener">NCCC</a></li>`).join('');
    return `<h3>${title}（${arr.length}）</h3><ul>${li}</ul>${arr.length > 300 ? '<p class="note">僅列前 300 筆。</p>' : ''}`;
  };
  $('chg-body').innerHTML = list('本週新增', c.added) + list('本週消失（解約）', c.removed);
}

async function loadTaxi() {
  const t = await getJSON('taxi');
  $('taxi-total').textContent = t.total.toLocaleString();
  $('taxi-table').tBodies[0].innerHTML = t.fleets.map(f => `<tr><td>${esc(f.n)}</td><td>${f.c.toLocaleString()}</td></tr>`).join('');
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function onCity() {
  const city = $('city').value;
  rows = [];
  fill($('district'), [], '全部');
  $('district').disabled = true;
  if (!city) { render(); return; }
  $('status').textContent = '載入中…';
  rows = await getJSON(city);
  rows.forEach(r => { r._n = norm(r.n); r._p = digits(r.p || ''); });
  const ds = [...new Set(rows.map(r => r.d).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  fill($('district'), ds.map(d => [d, d]), '全部');
  $('district').disabled = !ds.length;
  render();
}

function onGmcc() {
  const g = meta.cats.find(x => x.g === $('gmcc').value);
  fill($('tcc'), g ? g.t.map(t => [t.c, t.n]) : [], '全部');
  $('tcc').disabled = !g || !g.t.length;
  render();
}

function render() {
  const city = $('city').value;
  if (!city) { matched = []; $('results').innerHTML = ''; $('more').hidden = true; $('status').textContent = '請先選擇縣市。'; return; }
  const d = $('district').value, g = $('gmcc').value, t = $('tcc').value;
  const kw = norm($('kw').value), tel = digits($('tel').value);
  matched = rows.filter(r =>
    (!d || r.d === d) && (!g || r.g === g) && (!t || r.t === t) &&
    (!kw || r._n.includes(kw)) && (!tel || r._p.includes(tel)));
  shown = 0;
  $('results').innerHTML = '';
  more();
  $('status').textContent = `${city} 共 ${matched.length.toLocaleString()} 筆符合（不含計程車）`;
}

function more() {
  const next = matched.slice(shown, shown + PAGE);
  $('results').insertAdjacentHTML('beforeend', next.map(r =>
    `<div class="card"><div class="name">${esc(r.n)}</div>` +
    `<div class="meta">${esc(r.a)}</div>` +
    `<div class="meta">${esc(tName[r.t] || '')}｜${esc(gName[r.g] || '')}${r.p ? '｜' + esc(r.p) : ''}</div>` +
    `<a href="${detailUrl(r.i)}" target="_blank" rel="noopener">到 NCCC 確認</a></div>`).join(''));
  shown += next.length;
  $('more').hidden = shown >= matched.length;
}

let timer;
const later = () => { clearTimeout(timer); timer = setTimeout(render, 200); };
$('city').addEventListener('change', onCity);
$('district').addEventListener('change', render);
$('gmcc').addEventListener('change', onGmcc);
$('tcc').addEventListener('change', render);
$('kw').addEventListener('input', later);
$('tel').addEventListener('input', later);
$('more').addEventListener('click', more);
init().catch(e => { $('updated').textContent = '載入失敗'; console.error(e); });
