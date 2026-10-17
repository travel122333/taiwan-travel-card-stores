#!/usr/bin/env python3
"""data/stores_active.csv → docs/data/*.json（依縣市拆檔；計程車收合成車隊；與上一版比對產生 changes.json）。"""
import csv, json, re, unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).parent
CSV = ROOT / 'data' / 'stores_active.csv'
PREV = ROOT / 'data' / 'prev' / 'stores_active.csv'
CATS = ROOT / 'data' / 'categories.json'
OUT = ROOT / 'docs' / 'data'
TAXI = '計程車'
CITIES = ['台北市', '新北市', '基隆市', '桃園市', '新竹市', '新竹縣', '苗栗縣', '台中市', '彰化縣', '南投縣',
          '雲林縣', '嘉義市', '嘉義縣', '台南市', '高雄市', '屏東縣', '宜蘭縣', '花蓮縣', '台東縣', '澎湖縣',
          '金門縣', '連江縣']
OTHER = '其他'  # 來源地址打錯字、拆不出縣市者


def read(path):
    with open(path, encoding='utf-8-sig', newline='') as f:
        return list(csv.DictReader(f))


def city_of(r):
    return r['city'] if r['city'] in CITIES else OTHER


def fleet(name):
    """計程車店名 → 車隊名。以店名前綴判斷（地址不可靠：4 萬筆是台灣大車隊總部）。"""
    n = unicodedata.normalize('NFKC', name).strip()
    if n.startswith(('台灣大車', '大車隊')):
        return '台灣大車隊'
    if n.lower().startswith('yoxi'):
        return 'yoxi'
    if n.startswith('大都會平台'):
        return '大都會平台（TAIX）'
    return re.sub(r'[\s\d\-－—﹣]+$', '', n)  # 其他：店名去掉尾端編號


def phone_of(s):
    return re.sub(r'\s+', '', s).rstrip('-')


def main():
    rows = read(CSV)
    cats = json.loads(CATS.read_text(encoding='utf-8'))
    gcode = {g[1]: g[0] for g in cats}
    tcode = {(g[1], t[1]): t[0] for g in cats for t in g[2]}
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob('*.json'):
        old.unlink()

    by_city, taxi = {}, {}
    for r in rows:
        if r['tcc'] == TAXI:
            taxi[fleet(r['name'])] = taxi.get(fleet(r['name']), 0) + 1
            continue
        rec = {'n': r['name'], 'a': unicodedata.normalize('NFKC', r['address']), 'd': r['district'],
               'g': gcode[r['gmcc']], 't': tcode[(r['gmcc'], r['tcc'])], 'i': r['id']}
        p = phone_of(r['phone'])
        if p:
            rec['p'] = p
        by_city.setdefault(city_of(r), []).append(rec)

    dump = lambda path, obj: path.write_text(json.dumps(obj, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    for c, lst in by_city.items():
        dump(OUT / f'{c}.json', lst)
    # 全國索引：未選縣市時用店名／電話搜尋全國（欄位順序同 app.js loadAll）
    dump(OUT / 'index.json', [[r['n'], r['a'], r['d'], r['g'], r['t'], r.get('p', ''), r['i']]
                              for c in CITIES + [OTHER] for r in by_city.get(c, [])])
    fleets = sorted(({'n': k, 'c': v} for k, v in taxi.items()), key=lambda x: -x['c'])
    dump(OUT / 'taxi.json', {'total': sum(taxi.values()), 'fleets': fleets})

    # 與上一版比對（計程車不逐筆列出）
    added, removed = [], []
    if PREV.exists():
        cur = {r['id']: r for r in rows}
        old = {r['id']: r for r in read(PREV)}
        brief = lambda r: {'n': r['name'], 'a': r['address'], 'g': gcode.get(r['gmcc'], ''), 'i': r['id']}
        added = [brief(cur[i]) for i in cur if i not in old and cur[i]['tcc'] != TAXI]
        removed = [brief(old[i]) for i in old if i not in cur and old[i]['tcc'] != TAXI]
    date = datetime.fromtimestamp(CSV.stat().st_mtime, timezone(timedelta(hours=8))).strftime('%Y-%m-%d')
    dump(OUT / 'changes.json', {'date': date, 'added': added, 'removed': removed})

    counts = {c: len(by_city[c]) for c in CITIES + [OTHER] if c in by_city}
    dump(OUT / 'meta.json', {
        'updated': date, 'total': len(rows), 'taxi': sum(taxi.values()), 'counts': counts,
        'cats': [{'g': g[0], 'n': g[1], 't': [{'c': t[0], 'n': t[1]} for t in g[2] if t[1] != TAXI]} for g in cats],
    })
    sizes = sorted(((p.stat().st_size, p.name) for p in OUT.glob('*.json')), reverse=True)
    print(f'共 {len(rows)} 筆；計程車 {sum(taxi.values())} 筆 → {len(fleets)} 車隊；新增 {len(added)}／消失 {len(removed)}')
    print(f'docs/data 合計 {sum(s for s, _ in sizes) / 1e6:.2f} MB，最大 {sizes[0][1]} {sizes[0][0] / 1e6:.2f} MB')


if __name__ == '__main__':
    main()
