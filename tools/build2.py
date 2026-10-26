import json, re, os

BASE = "/tmp/iptv-probe"
OUT_DIR = "/Users/pqw/docker/jellyfin/config/iptv"
OUT = f"{OUT_DIR}/live.m3u"

data = json.load(open(f"{BASE}/result.json"))
epg = json.load(open(f"{BASE}/epg_channels.json"))
name2id = {}
for cid, n in epg:
    name2id.setdefault(n, cid)   # 同名取第一个

# 原频道名 -> epg.pw 频道名（必须精确存在，否则不映射）
EXACT = {
    "CCTV-1 (720p)": "CCTV-1 综合",
    "CCTV-2 (720p)": "CCTV-2 财经",
    "CCTV-3 (720p)": "CCTV-3 综艺",
    "CCTV-6 HD (1080p)": "CCTV-6 电影",
    "CCTV-7 (720p)": "CCTV-7 国防军事",
    "CCTV-8 (720p)": "CCTV-8 电视剧",
    "CCTV-9 (576i)": "CCTV-9 纪录",
    "CCTV-10 (720p)": "CCTV-10 科教",
    "CCTV-11 (720p)": "CCTV-11 戏曲",
    "CCTV-12 (720p)": "CCTV-12 社会与法",
    "CCTV-13 (720p)": "CCTV-13 新闻",
    "CCTV-14 HD (1080p)": "CCTV-14 少儿",
    "CCTV-15 (720p)": "CCTV-15 音乐",
    "CCTV-17 HD (1080p)": "CCTV-17（农业农村）",
    "CCTV-8K HD (1080p)": "CCTV-8K",
    "CCTV-Golf & Tennis (1080p)": "高尔夫网球",
    "CCTV-Health (1080p)": "卫生健康",
    "CCTV-Nostalgia Theater (1080p)": "CCTV怀旧剧场",
    "CCTV-Storm Theater (1080p)": "CCTV风云剧场",
    "CCTV-The First Theater (1080p)": "CCTV第一剧场",
    "Anhui TV": "安徽卫视",
    "Dragon TV International": "东方卫视",
    "Guangdong Satellite TV": "广东卫视",
    "Guangxi Variety & Travel Channel": "广西综艺旅游",
    "Hebei TV (2160p)": "河北卫视",
    "Hunan TV (2160p)": "湖南卫视",
    "Hunan Economy Channel": "湖南经视",
    "Nei Monggol TV (960p)": "内蒙古卫视",
    "Xizang TV Chinese": "西藏卫视",
    "Kangba TV": "康巴卫视",
    "Xinjiang TV 3": "新疆汉语综艺",
    "Xinjiang TV 8": "新疆汉语影视",
    "Zhejiang International Channel": "浙江国际",
    "Lanzhou Comprehensive News Channel": "兰州新闻综合",
    "Lanzhou Culture & Tourism Channel": "兰州文旅",
    "Guangzhou TV": "广州综合台",
    "Dongguan Comprehensive News Channel": "东莞新闻",
    "Jilin City Channel": "吉林市新闻",
    "Jilin Lifestyle Channel": "吉林生活",
    "Jilin Movie Channel": "吉林影视",
    "Jilin Rural Channel": "吉林乡村",
}

cn = [e for e in data["cn"] if e["group"] != "Religious" and "Not 24/7" not in e["name"]]
KEEP_NEWS = ["ABC News (720p)", "Africanews English (720p)", "Al Arabiya English (1080p)",
             "Al Jazeera English (1080p)", "Al Jazeera (1080p)", "Arirang TV (1080p)",
             "CBS News Baltimore (720p)", "CGTN (1080p)", "CNA International (576p)",
             "CNBC UK (1080p)", "DW English (1080p)", "Euronews (720p)",
             "France 24 (1080p)", "France 24 English (1080p)", "i24NEWS English World (1080p)",
             "NBC News NOW (1080p)", "Newsmax TV (720p)", "Newsmax 2 (1080p)",
             "NHK World-Japan (1080p)", "Sky News Arabia (1080p)", "Sky News Extra 3 (1080p)",
             "TRT World (720p)", "TVP World", "WION (1080p)"]
news = [e for e in data["news"] if e["name"] in KEEP_NEWS]

mapped = 0
for e in cn:
    target = EXACT.get(e["name"])
    if target and target in name2id:
        e["display"] = target
        e["tvg_id"] = name2id[target]
        mapped += 1
    else:
        e["display"] = e["name"]
        e["tvg_id"] = ""
print(f"中文频道 {len(cn)} 个，EPG 精确映射 {mapped} 个")

def clean_logo(u):
    return "" if ("imgur.com" in u or "ibb.co" in u) else u

def esc(s):
    return s.replace('"', "'")

lines = ["#EXTM3U 由iptv-org公开源实测筛选生成 2026-10-26"]
for e in cn:
    lines.append(f'#EXTINF:-1 tvg-id="{e["tvg_id"]}" tvg-name="{esc(e["display"])}" '
                 f'tvg-logo="{clean_logo(e["logo"])}" group-title="中文频道",{e["display"]}')
    lines.append(e["url"])
for e in news:
    nm = re.sub(r"\s*\((\d+p|i|576i)\)\s*", " ", e["name"]).strip()
    lines.append(f'#EXTINF:-1 tvg-name="{esc(nm)}" tvg-logo="{clean_logo(e["logo"])}" '
                 f'group-title="国际新闻",{nm}')
    lines.append(e["url"])

os.makedirs(OUT_DIR, exist_ok=True)
open(OUT, "w", encoding="utf-8").write("\n".join(lines) + "\n")
print(f"已写入 {OUT}: 共 {len(cn) + len(news)} 个频道")
