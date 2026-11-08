# 任务剩余时间预估 (DSH plugin)

DeepSeek Harness 的 Web UI 插件：任务运行期间在输入框下方显示「预计剩余 ≈ …」胶囊，
与自带的「深度求索中，用时 …」互补。

## 安装到其他机器 / Install on another machine

**不需要手动克隆。** `install_bundle` 支持 git 来源，一行即可：

```
plugin_manager: action=install_bundle
                target=github:x-ww/kit#path:dsh-plugins/eta-estimate
```

或在 Web 插件管理页的「安装」框里粘贴：

```
github:x-ww/kit#path:dsh-plugins/eta-estimate
```

`#path:` 是 pnpm 的 git 子目录语法——因为本包位于 kit 仓库的
`dsh-plugins/eta-estimate/` 而非仓库根，pnpm 会只取出该子目录作为包。
直接写 `github:x-ww/kit` 会指向仓库根（那里没有 `package.json`），会安装失败。

已实测（pnpm 11.28.5 + DSH 0.2.2-rc.1）：解析为 `@local/eta-estimate 1.2.0`，
解包后只含插件的 14 个文件，不会带入仓库根的 EPG/播放列表等文件。

也可用完整 URL，等价：

```
https://github.com/x-ww/kit#path:dsh-plugins/eta-estimate
```

安装后**刷新 Web 页面**加载客户端模块。插件只在「任务运行中」时出现，空闲时隐藏。

### 备选：手动克隆

如果需要改代码或在离线环境使用，可以克隆后指向本地目录（必须用绝对路径）：

```bash
git clone https://github.com/x-ww/kit.git
```

```
plugin_manager: action=install_bundle
                target=/绝对路径/kit/dsh-plugins/eta-estimate
```

这种方式装为 `link:` 链接，改本地文件后需重装一次并刷新页面。

### 更新

git 方式安装的包固定到某个 commit。仓库更新后，在插件管理页先卸载再重新安装
（`plugin_manager: remove_bundle` → `install_bundle`），或在 Web 页面使用更新入口。

依赖：无需 npm 依赖、无需构建步骤；Host 半是空实现，全部逻辑在 `client.js`。

## 实测依据 / Measured basis

估算表不是拍脑袋调的，而是从 **95 个会话、239 个已完成轮次、4913 个步骤** 的日志中
提取真实耗时回测得出（在每轮 15%/25%/35%/50%/65%/80%/90% 七个时点比对预测与真实剩余时间）。

实测分布：

| 指标 | p25 | p50 | p75 | p90 | max |
|---|---|---|---|---|---|
| 轮次耗时 | 24 秒 | 89 秒 | 5.8 分 | 12 分 | 73 分 |
| 单步耗时 | 4.2 秒 | 6.4 秒 | 13 秒 | 26.5 秒 | — |

回测结果（中位相对误差，越低越好）：

| 模型 | 中位误差 | 区间覆盖率 |
|---|---|---|
| `历史每步 × 期望步数`（移动靶） | 预测终点随步数后退 | — |
| `会话 p50 − 已用时` | 121% | 46% |
| **按已完成步数查实测表（当前）** | **79%** | 62% |

理论上限：即便假定能未卜先知「还剩多少步」（现实中不可知），中位误差仍有 **40%**。
所以 79% 已接近这条路的极限。

## 做法 / How it works

1. 内置由实测数据预计算的表：`已完成步数 k → 剩余步数 P25/P50/P75`（k = 0…60）。
2. 每秒读取当前轮实时步号（流式 `partial.step`，已定稿 assistant 节点兜底），
   乘实测单步中位耗时 6.4 秒得到剩余区间。
3. 区间向外放宽 1.3 倍，把覆盖率提到约三分之二——宁可给宽区间，也不给假精度。
4. 粗粒度单位显示（`1–2 分钟`、`≈ 5 分钟`）。
5. 三种诚实兜底：`预计即将完成`、`可能还要一会儿`、`剩余时间难以预估`。
6. tooltip 标注同类任务第几步的常见耗时、历史样本数、是否超出样本范围、仅供参考。

只读取 Harness 已维护的 Client 投影，不写会话事件、不读其他插件 DOM。
支持 8 种语言（中/英/日/西/法/德/俄/葡），样式仅用 `--dsw-alias-*` 主题令牌。

## 已知限制 / Limits

- 中位误差约 79%，**典型情况下仍会差近一倍**，长任务尤其容易低估。
- 估算表基于作者本机历史；任务类型分布差异较大时精度会下降（不联网、不自学习）。
- 这个量原理上高度不可预测，插件给的是经验区间而非承诺。

## 文件 / Files

- `index.js` — Host 半（空实现）
- `client.js` — 客户端模块：字典、估算表与胶囊渲染
- `cordis.patch.yml` — 插入插件行
- `locale/*.json` — 插件管理页显示元数据
- `icon.svg` — 原创计时器图标
