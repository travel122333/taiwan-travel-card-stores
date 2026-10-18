'use strict';
const NCCC = 'https://travel.nccc.com.tw/NASApp/NTC/servlet/com.du.mvc.EntryServlet';
const PAGE = 200;
const $ = id => document.getElementById(id);
const detailUrl = id => `${NCCC}?Action=RetailerEdit&Type=GetFull&Id=${id}&RequestType=0`;

let meta, gName = {}, tName = {};
let rows = [], all = null, matched = [], shown = 0;
let bounds = null, map, mapReady = false, popup, hlEl;

// 統一比對用字串：全半形、大小寫、臺→台、空白標點，並去除公司後綴
const SUFFIX = /股份有限公司|有限公司|分公司|營業所|[-－﹣](網路|ec)(\.?app)?/g;
function norm(s) {
  return s.normalize('NFKC').toLowerCase().replace(/臺/g, '台')
    .replace(SUFFIX, '').replace(/[\s\-_.,，、()（）]/g, '');
}
const digits = s => s.normalize('NFKC').replace(/\D/g, '');
const prep = r => { r._n = norm([r.n, ...(r.m || []).map(x => x[0])].join('|')); r._p = digits(r.p || ''); return r; };
// Google 地圖搜尋：店名（去公司後綴）＋地址；Google 找得到該店就會直接跳到店家頁
const mapUrl = r => 'https://www.google.com/maps/search/?api=1&query=' +
  encodeURIComponent(r.n.replace(/股份有限公司|有限公司/g, ' ') + ' ' + r.a);

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
  resetBounds();
  const city = $('city').value;
  rows = [];
  fill($('district'), [], '全部');
  $('district').disabled = true;
  if (!city) { render(); return; }
  $('status').textContent = '載入中…';
  rows = (await getJSON(city)).map(prep);
  const ds = [...new Set(rows.map(r => r.d).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  fill($('district'), ds.map(d => [d, d]), '全部');
  $('district').disabled = !ds.length;
  render();
}

function onGmcc() {
  resetBounds();
  const g = meta.cats.find(x => x.g === $('gmcc').value);
  fill($('tcc'), g ? g.t.map(t => [t.c, t.n]) : [], '全部');
  $('tcc').disabled = !g || !g.t.length;
  render();
}

function render() {
  const city = $('city').value;
  const d = $('district').value, g = $('gmcc').value, t = $('tcc').value;
  const kw = norm($('kw').value), tel = digits($('tel').value);
  if (!city && !kw && !tel) { matched = []; $('results').innerHTML = ''; $('more').hidden = true; $('status').textContent = '請選擇縣市，或直接輸入店名／電話搜尋全國。'; $('areabar').hidden = true; updateMap(''); return; }
  if (!city && !all) { loadAll(); return; }
  matched = (city ? rows : all).filter(r =>
    (!d || r.d === d) && (!g || r.g === g) && (!t || r.t === t) &&
    (!kw || r._n.includes(kw)) && (!tel || r._p.includes(tel)) &&
    (!bounds || (r.c && r.c[1] >= bounds.getWest() && r.c[1] <= bounds.getEast() && r.c[0] >= bounds.getSouth() && r.c[0] <= bounds.getNorth())));
  shown = 0;
  $('results').innerHTML = '';
  more();
  const nc = matched.filter(r => r.c).length;
  $('status').textContent = `${city || '全國'} 共 ${matched.length.toLocaleString()} 家符合（不含計程車；同一家店的多筆登記已合併）；地圖上有 ${nc.toLocaleString()} 家`;
  $('areabar').hidden = !bounds;
  $('searcharea').hidden = true;
  updateMap(city);
}

// ---- 地圖 ----
const TAIWAN = [[118.0, 21.6], [122.3, 26.6]];
function initMap() {
  if (!window.maplibregl) { $('map').textContent = '地圖載入失敗（無法連線 CDN）'; return; }
  map = new maplibregl.Map({ container: 'map', style: 'https://tiles.openfreemap.org/styles/liberty', bounds: TAIWAN, fitBoundsOptions: { padding: 10 } });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  popup = new maplibregl.Popup({ closeOnClick: false, offset: 12, maxWidth: '280px' });
  map.on('load', () => {
    map.addSource('stores', { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, cluster: true, clusterMaxZoom: 16, clusterRadius: 45 });
    map.addLayer({ id: 'clusters', type: 'circle', source: 'stores', filter: ['has', 'point_count'],
      paint: { 'circle-color': ['step', ['get', 'point_count'], '#4a90d9', 50, '#1e5aa8', 500, '#0b3a78'],
        'circle-radius': ['step', ['get', 'point_count'], 15, 50, 19, 500, 24], 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } });
    map.addLayer({ id: 'cluster-count', type: 'symbol', source: 'stores', filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Regular'], 'text-size': 12 },
      paint: { 'text-color': '#fff' } });
    map.addLayer({ id: 'point', type: 'circle', source: 'stores', filter: ['!', ['has', 'point_count']],
      paint: { 'circle-color': ['case', ['==', ['get', 'ap'], 1], '#e0a030', '#d94a4a'], 'circle-radius': 7, 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } });
    map.addLayer({ id: 'label', type: 'symbol', source: 'stores', minzoom: 15, filter: ['!', ['has', 'point_count']],
      layout: { 'text-field': ['get', 'n'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': '#222', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });
    map.on('click', 'clusters', e => {
      const f = e.features[0];
      map.getSource('stores').getClusterExpansionZoom(f.properties.cluster_id).then(z =>
        map.easeTo({ center: f.geometry.coordinates, zoom: z + 0.5 }));
    });
    map.on('click', 'point', e => selectStore(+e.features[0].properties.k, { fromMap: true }));
    ['clusters', 'point'].forEach(l => {
      map.on('mouseenter', l, () => map.getCanvas().style.cursor = 'pointer');
      map.on('mouseleave', l, () => map.getCanvas().style.cursor = '');
    });
    map.on('moveend', e => { if (e.originalEvent) $('searcharea').hidden = false; });
    mapReady = true;
    updateMap($('city').value);
  });
}

function updateMap(city) {
  if (!mapReady) return;
  const feats = [];
  matched.forEach((r, k) => {
    if (r.c) feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.c[1], r.c[0]] }, properties: { k, n: r.n, ap: r.c[2] || 0 } });
  });
  map.getSource('stores').setData({ type: 'FeatureCollection', features: feats });
  popup.remove();
  if (bounds) return;
  if (!city || !feats.length) { if (!city) map.fitBounds(TAIWAN, { padding: 10 }); return; }
  const b = new maplibregl.LngLatBounds();
  feats.forEach(f => b.extend(f.geometry.coordinates));
  map.fitBounds(b, { padding: 40, maxZoom: 16 });
}

function popupHtml(r) {
  return `<div class="pn">${esc(r.n)}</div>` +
    (r.p ? `<div>${esc(r.p)}</div>` : '') + `<div>${esc(r.a)}</div>` +
    (r.c[2] ? '<div class="approx">位置約略（僅定位到路段）</div>' : '') +
    `<a href="${detailUrl(r.i)}" target="_blank" rel="noopener">到 NCCC 確認</a>　` +
    `<a href="${mapUrl(r)}" target="_blank" rel="noopener">Google 地圖</a>`;
}

// 選取第 k 家：開 popup、清單高亮並捲動；從清單點選時地圖 flyTo，從地圖點選時清單捲動
function selectStore(k, { fromMap = false } = {}) {
  const r = matched[k];
  if (!r || !r.c) return;
  while (shown <= k && shown < matched.length) more();
  if (hlEl) hlEl.classList.remove('hl');
  hlEl = $('c' + k);
  if (hlEl) { hlEl.classList.add('hl'); if (fromMap) hlEl.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  const ll = [r.c[1], r.c[0]];
  popup.setLngLat(ll).setHTML(popupHtml(r)).addTo(map);
  if (!fromMap) {
    if (window.matchMedia('(max-width: 899px)').matches) $('map').scrollIntoView({ block: 'start', behavior: 'smooth' });
    map.flyTo({ center: ll, zoom: Math.max(map.getZoom(), 17) });
  }
}

function more() {
  const next = matched.slice(shown, shown + PAGE);
  $('results').insertAdjacentHTML('beforeend', next.map((r, j) =>
    `<div class="card${r.c ? ' hasmap' : ''}" id="c${shown + j}"><div class="name">${esc(r.n)}</div>` +
    `<div class="meta">${esc(r.a)}</div>` +
    `<div class="meta">${esc(tName[r.t] || '')}｜${esc(gName[r.g] || '')}${r.p ? '｜' + esc(r.p) : ''}${r.c ? '' : ' <span class="nomap">｜無地圖位置</span>'}</div>` +
    `<a href="${detailUrl(r.i)}" target="_blank" rel="noopener">到 NCCC 確認</a>　` +
    `<a href="${mapUrl(r)}" target="_blank" rel="noopener">Google 地圖</a>` +
    (r.m && r.m.length ? `<details class="regs"><summary>同一家店另有 ${r.m.length} 筆登記（不同刷卡機或部門，都是特約）</summary><ul>` +
      r.m.map(([n, i]) => `<li>${esc(n)} <a href="${detailUrl(i)}" target="_blank" rel="noopener">NCCC</a></li>`).join('') +
      '</ul></details>' : '') + '</div>').join(''));
  shown += next.length;
  $('more').hidden = shown >= matched.length;
}

let loading;
function loadAll() {
  $('status').textContent = '載入全國索引中…';
  loading = loading || getJSON('index').then(x => {
    all = x.map(([n, a, d, g, t, p, i, m, c]) => prep({ n, a, d, g, t, p, i, m, c: c || undefined }));
    render();
  });
}

function resetBounds() { bounds = null; }
$('searcharea').addEventListener('click', () => { bounds = map.getBounds(); render(); });
$('cleararea').addEventListener('click', e => { e.preventDefault(); resetBounds(); render(); });
$('results').addEventListener('click', e => {
  const card = e.target.closest('.card.hasmap');
  if (!card || e.target.closest('a, summary, details')) return;
  selectStore(+card.id.slice(1));
});

let timer;
const later = () => { clearTimeout(timer); timer = setTimeout(render, 200); };
$('city').addEventListener('change', onCity);
$('district').addEventListener('change', () => { resetBounds(); render(); });
$('gmcc').addEventListener('change', onGmcc);
$('tcc').addEventListener('change', () => { resetBounds(); render(); });
$('kw').addEventListener('input', later);
$('tel').addEventListener('input', later);
$('more').addEventListener('click', more);
initMap();
init().catch(e => { $('updated').textContent = '載入失敗'; console.error(e); });
