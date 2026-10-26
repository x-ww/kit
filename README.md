# media-toolbox

个人媒体工具箱。

## IPTV 直播源

`iptv/live.m3u` — Jellyfin 直播频道列表，基于 [iptv-org](https://github.com/iptv-org/iptv) 公开源**逐条实测**筛选生成（2026-10-26：中文频道 66 + 国际新闻 24 = 90 个，仅保留实测可播的频道）。

### 订阅地址

- jsDelivr CDN（推荐）：https://cdn.jsdelivr.net/gh/x-ww/media-toolbox@main/iptv/live.m3u
- GitHub Raw：https://raw.githubusercontent.com/x-ww/media-toolbox/main/iptv/live.m3u

### 节目单（EPG / XMLTV）

https://epg.pw/xmltv/epg_CN.xml

### Jellyfin 配置

控制台 → 直播电视 → 调谐器设备 → M3U，填上方任一订阅地址；
节目指南数据提供程序 → XMLTV，填上方 EPG 地址。

### 维护

`iptv/tools/` 内为筛选脚本：拉取候选列表 → 并发实测每条流的可用性 → 生成精选 m3u。频道失效后重跑即可重新筛选。

## 其他

- `MovieRatingIntegrator/` — 影片评分整合脚本
