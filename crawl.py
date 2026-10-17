#!/usr/bin/env python3
"""國旅卡特約商店爬蟲：依「大類→細類」逐頁抓 NCCC 查詢系統，輸出 data/stores_active.csv。

用法：python3 crawl.py [RequestType]   # 0=有效店（預設）、2=解約店
"""
import csv, html, json, re, sys, time, urllib.parse, urllib.request
from pathlib import Path

BASE = 'https://travel.nccc.com.tw/NASApp/NTC/servlet/com.du.mvc.EntryServlet'
UA = 'Mozilla/5.0 (research; low-rate crawler)'
PAGE = 1000
SLEEP = 1.0
OUT = Path(__file__).parent / 'data'


def get(url, data=None):
    for i in range(4):
        try:
            req = urllib.request.Request(url, data=data, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read().decode('big5', errors='replace')
        except Exception as e:
            print('  retry', i + 1, e, file=sys.stderr)
            time.sleep(2 ** (i + 1))
    raise RuntimeError(url)


def js_array(src, name):
    m = re.search(name + r' = new Array\((.*?)\);', src)
    return re.findall(r'"(.*?)"', m.group(1))


def categories(src):
    """從查詢頁的 JS 解析 大類/細類 清單（索引 0 是空白選項）。"""
    gname, gcode = js_array(src, 'GMccList'), js_array(src, 'GMccCode')
    cats = []
    for i in range(1, len(gcode)):
        tname, tcode = js_array(src, rf'TccList\[{i}\]'), js_array(src, rf'TccCode\[{i}\]')
        cats.append((gcode[i], gname[i], list(zip(tcode[1:], tname[1:]))))
    return cats


def clean(s):
    s = re.sub(r'<[^>]+>', ' ', s)
    return re.sub(r'\s+', ' ', html.unescape(s).replace('\xa0', ' ')).strip()


OLD_COUNTY = {'桃園縣': '桃園市', '台北縣': '新北市', '台中縣': '台中市', '台南縣': '台南市', '高雄縣': '高雄市'}
ADDR_RE = re.compile(r'^(.{2}[縣市])(.{1,3}?[區鄉鎮市])?')


def split_addr(addr):
    """'臺中市沙鹿區中山路…' → ('台中市', '沙鹿區')；臺→台、舊縣名→升格後市名。"""
    a = addr.replace('臺', '台')
    for old, new in OLD_COUNTY.items():
        a = a.replace(old, new, 1) if a.startswith(old) else a
    m = ADDR_RE.match(a)
    return (m.group(1), m.group(2) or '') if m else ('', '')


def parse_rows(page):
    for r in re.findall(r'<TR BGCOLOR=#FAFAF5 VALIGN="TOP">(.*?)</TR>', page, re.S):
        tds = re.findall(r'<TD[^>]*>(.*?)</TD>', r, re.S)
        if len(tds) < 7:
            continue
        web = re.search(r'<A HREF=(\S+?)[\s>]', tds[0])
        sid = re.search(r'Id=(\d+)', tds[6])
        addr = clean(tds[3]).replace(' ', '')
        city, district = split_addr(addr)
        yield {
            'id': sid.group(1) if sid else '',
            'name': clean(tds[0]),
            'industry': clean(tds[1]),
            'phone': clean(tds[2]),
            'city': city,
            'district': district,
            'address': addr,
            'discount': clean(tds[4]),
            'eco': clean(tds[5]),
            'website': web.group(1) if web else '',
        }


def crawl_query(gmcc, tcc, rtype):
    """回傳 (總筆數, rows)。先 POST 拿總數，再用 GET Request 參數大頁抓。"""
    form = urllib.parse.urlencode({'AcqFID': '', 'Type': 'GetFull', 'WebMode': '', 'RetlName': '',
                                   'Group': '', 'ZipCode': '', 'Addr': '', 'GMCC': gmcc,
                                   'TCC': tcc, 'RequestType': rtype}).encode()
    first = get(BASE + '?Action=RetailerList', form)
    m = re.search(r'總筆數：(\d+)', first)
    total = int(m.group(1)) if m else 0
    rows = []
    for p in range(1, (total + PAGE - 1) // PAGE + 1):
        req = f'NULL_NULL_NULL_NULL_NULL_NULL_{gmcc or "NULL"}_{tcc or "NULL"}_NULL_{rtype}_0_{p}_{PAGE}_{total}'
        time.sleep(SLEEP)
        rows += list(parse_rows(get(f'{BASE}?Action=RetailerList&Type=GetFull&WebMode=&Request={req}')))
    return total, rows


def main():
    rtype = sys.argv[1] if len(sys.argv) > 1 else '0'
    OUT.mkdir(exist_ok=True)
    cats = categories(get(BASE + '?Action=RetailerInquiry&Type=GetFull'))
    (OUT / 'categories.json').write_text(json.dumps(cats, ensure_ascii=False, indent=1))
    stores, report = {}, []
    for gcode, gname, subs in cats:
        for tcode, tname in subs:
            total, rows = crawl_query(gcode, tcode, rtype)
            for r in rows:
                stores[r['id']] = {**r, 'gmcc': gname, 'tcc': tname}
            report.append((gname, tname, total, len(rows)))
            print(f'{gname}/{tname}: {total} 筆，抓到 {len(rows)}', flush=True)

    suffix = 'active' if rtype == '0' else 'terminated'
    fields = ['id', 'name', 'gmcc', 'tcc', 'industry', 'phone', 'city', 'district', 'address',
              'discount', 'eco', 'website']
    with open(OUT / f'stores_{suffix}.csv', 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fields, extrasaction='ignore')
        w.writeheader()
        w.writerows(sorted(stores.values(), key=lambda r: (r['city'], r['district'], r['gmcc'], r['name'])))
    with open(OUT / f'crawl_report_{suffix}.csv', 'w', newline='', encoding='utf-8-sig') as f:
        csv.writer(f).writerows([('大類', '細類', '網站總筆數', '實際抓到')] + report)
    print('完成，共', len(stores), '筆（不重複 Id）')


if __name__ == '__main__':
    main()
