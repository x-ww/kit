import re, json, subprocess, os
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urljoin

BASE = "/tmp/iptv-probe"

def parse(path):
    entries = []
    attrs, name = {}, None
    for raw in open(path, encoding="utf-8", errors="replace"):
        line = raw.strip()
        if line.startswith("#EXTINF"):
            rest = line[len("#EXTINF:"):].strip()
            parts = rest.split(None, 1)
            rest = parts[1] if len(parts) > 1 else ""
            attrs = dict(re.findall(r'([A-Za-z0-9_-]+)="([^"]*)"', rest))
            name = rest.rsplit(",", 1)[-1].strip() if "," in rest else rest.strip()
        elif line and not line.startswith("#"):
            if name:
                entries.append({"name": name, "url": line,
                                "tvg_id": attrs.get("tvg-id", ""),
                                "logo": attrs.get("tvg-logo", ""),
                                "group": attrs.get("group-title", "")})
            attrs, name = {}, None
    return entries

def fetch(url, timeout=8):
    try:
        r = subprocess.run(["curl", "-skL", "-m", str(timeout), "--connect-timeout", "5", url],
                           capture_output=True, timeout=timeout + 4)
        return r.stdout
    except Exception:
        return b""

def playable(e):
    body = fetch(e["url"])
    if not body or b"#EXTM3U" not in body[:4000]:
        return None
    if b"#EXT-X-STREAM-INF" in body:
        m = re.search(rb"#EXT-X-STREAM-INF[^\n]*\n(?!#)([^\s]+)", body)
        if not m:
            return None
        u = urljoin(e["url"], m.group(1).decode("utf-8", "replace"))
        v = fetch(u)
        if b"#EXTINF" not in v and b"#EXT-X-TARGETDURATION" not in v:
            return None
    return e

def run(path, label, brand_filter=False):
    es = parse(path)
    if brand_filter:
        es = [e for e in es if "Geo-blocked" not in e["name"] and "Not 24/7" not in e["name"]]
        brands = ["DW", "France 24", "Al Jazeera", "Euronews", "Sky News", "Bloomberg", "CNBC",
                  "ABC News", "CBS", "NBC", "NASA", "CNA", "TRT", "i24", "CGTN", "Arirang",
                  "NHK World", "TV5Monde", "Arabiya", "PTV World", "Africanews", "WION",
                  "Newsmax", "Fox Weather", "TVP World"]
        es = [e for e in es if any(b.lower() in e["name"].lower() for b in brands)]
    with ThreadPoolExecutor(max_workers=32) as ex:
        out = list(ex.map(playable, es))
    ok = [e for e in out if e]
    print(f"[{label}] 候选 {len(es)} 个，实测可播 {len(ok)} 个", flush=True)
    return ok

cn = run(f"{BASE}/cn.m3u", "cn")
news = run(f"{BASE}/news.m3u", "news", brand_filter=True)
json.dump({"cn": cn, "news": news}, open(f"{BASE}/result.json", "w"), ensure_ascii=False, indent=1)

print("=== 可播的中文频道 ===")
for e in cn:
    print(f'  {e["name"]}  [{e["group"]}]')
print("=== 可播的国际新闻 ===")
for e in news:
    print(f'  {e["name"]}  [{e["group"]}]')

# ---- epg.pw 节目单：下载并分析频道 id 格式 ----
print("=== epg.pw 分析 ===", flush=True)
try:
    subprocess.run(["curl", "-skL", "-m", "120", "-o", f"{BASE}/epg_cn.xml",
                    "https://epg.pw/xmltv/epg_CN.xml"], timeout=150)
    size = os.path.getsize(f"{BASE}/epg_cn.xml")
    txt = open(f"{BASE}/epg_cn.xml", encoding="utf-8", errors="replace").read()
    chans = []
    for cid, block in re.findall(r'<channel id="([^"]+)"[^>]*>(.*?)</channel>', txt, re.S):
        dn = re.search(r"<display-name[^>]*>([^<]+)</display-name>", block)
        chans.append([cid, dn.group(1).strip() if dn else ""])
    print(f"epg_cn.xml {size/1e6:.1f}MB, 频道 {len(chans)} 个，样例:")
    for cid, dn in chans[:30]:
        print(f"   id={cid!r}  name={dn!r}")
    json.dump(chans, open(f"{BASE}/epg_channels.json", "w"), ensure_ascii=False)
except Exception as ex:
    print("epg.pw 分析失败:", ex)
