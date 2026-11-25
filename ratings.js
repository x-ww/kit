// ==UserScript==
// @name         影评聚合
// @version      2.0.0
// @match        *://movie.douban.com/subject/*
// @match        *://www.douban.com/personage/*
// @match        *://*.imdb.com/title/*
// @connect      movie.douban.com
// @connect      www.douban.com
// @connect      query.wikidata.org
// @connect      www.omdbapi.com
// @connect      p.media-imdb.com
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @downloadURL  https://github.com/x-ww/kit/raw/main/ratings.js
// ==/UserScript==
"use strict";

(() => {
  const HOST = location.hostname;
  const STYLE_ID = "movie-rating-integrator-style";
  const BADGE_ID = "movie-rating-integrator-douban";
  const PANEL_ID = "movie-rating-integrator-extra";
  const SEARCH_ID = "movie-rating-integrator-search";
  const CACHE_KEY = "movie-rating-integrator-cache";
  const MINUTE = 6e4;
  const DAY = 864e5;

  const OMDB_KEYS = [
    "40700ff1",
    "4ee790e0",
    "d82cb888",
    "386234f9",
    "d58193b6",
    "15c0aa3f",
  ];

  const ICONS = {
    download:
      '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 21h16"/>',
    search:
      '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-5-5"/><path d="M10.5 7.5v6M7.5 10.5h6"/>',
  };

  const SITES = [
    {
      label: "BT4G",
      icon: ICONS.download,
      color: "#2ea44f",
      url: (title, year) =>
        `https://bt4gprx.com/search?${new URLSearchParams({ q: searchQuery(title, year) })}`,
    },
    {
      label: "UIndex",
      icon: ICONS.search,
      color: "#0969da",
      url: (title, year) =>
        `https://uindex.org/search.php?${new URLSearchParams({ search: searchQuery(title, year) })}`,
    },
  ];

  const TOMATO = { fresh: "🍅", rotten: "🟢", liked: "🍿", disliked: "💤" };

  const ROMAN = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const scheduleIdle =
    typeof window.requestIdleCallback === "function"
      ? window.requestIdleCallback.bind(window)
      : (fn) => setTimeout(fn, 0);

  const escapeHtml = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (ch) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
    );

  const safeUrl = (value) => {
    if (!value) return "";
    try {
      const url = new URL(value, location.href);
      return /^https?:$/.test(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  };

  const isBlank = (value) => value == null || value === "" || value === "N/A";

  const formatCount = (value) => {
    const number = Number(String(value ?? "").replace(/,/g, ""));
    return Number.isFinite(number) && number > 0
      ? new Intl.NumberFormat("en-US").format(number)
      : "";
  };

  const normalizeTitle = (value) =>
    String(value || "")
      .normalize("NFKC")
      .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, "")
      .toLowerCase()
      .replace(/[’'`´]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();

  function searchQuery(title, year) {
    const name = String(title || "").trim();
    if (!name) return "";
    const stamp = String(year || "").trim();
    return stamp && !/\d{4}$/.test(name) ? `${name} ${stamp}` : name;
  }

  const cache = {
    read() {
      try {
        return JSON.parse(GM_getValue(CACHE_KEY, "{}")) || {};
      } catch {
        return {};
      }
    },
    get(key) {
      const entry = this.read()[key];
      return entry && Date.now() - entry.at < entry.ttl ? entry.value : null;
    },
    set(key, value, ttl = DAY) {
      try {
        const data = this.read();
        data[key] = { value, at: Date.now(), ttl };
        const keys = Object.keys(data);
        if (keys.length > 120) {
          keys
            .sort((a, b) => data[a].at - data[b].at)
            .slice(0, 20)
            .forEach((old) => delete data[old]);
        }
        GM_setValue(CACHE_KEY, JSON.stringify(data));
      } catch (error) {
        console.warn("[影评聚合] 缓存写入失败:", error);
      }
    },
  };

  const GM_XHR =
    typeof GM !== "undefined" && GM?.xmlHttpRequest
      ? GM.xmlHttpRequest.bind(GM)
      : typeof GM_xmlhttpRequest !== "undefined"
        ? GM_xmlhttpRequest
        : null;

  function xhr(url) {
    return new Promise((resolve) => {
      if (!GM_XHR) {
        resolve({ error: true });
        return;
      }
      GM_XHR({
        method: "GET",
        url,
        onload: (response) => {
          const status = response.status;
          if (status >= 200 && status < 300) {
            resolve({ text: response.responseText });
            return;
          }
          let retryAfter = 0;
          try {
            retryAfter = Number(response.getResponseHeader("Retry-After")) || 0;
          } catch {}
          resolve({
            retry: status === 429 || status >= 500,
            wait: status === 429
              ? Math.min(8000, Math.max(1500, retryAfter * 1000))
              : 800,
            status,
          });
        },
        onerror: () => resolve({ retry: true, wait: 800 }),
      });
    });
  }

  async function getText(url, attempts = 2) {
    for (let i = 0; i < attempts; i++) {
      const result = await xhr(url);
      if (result.text !== undefined) return result.text;
      if (!result.retry) return null;
      if (i < attempts - 1) await sleep(result.wait);
    }
    return null;
  }

  async function getJson(url) {
    const text = await getText(url);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function parseSearchRows(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return qsa(".result", doc).flatMap((node) => {
      const id = node
        .querySelector("[onclick*='sid:']")
        ?.getAttribute("onclick")
        ?.match(/sid:\s*(\d+)/)?.[1];
      const link = node.querySelector(".title h3 a");
      if (!id || !link) return [];
      const cast = node.querySelector(".subject-cast")?.textContent || "";
      const kind = qsa(".title h3 span", node)
        .map((span) => span.textContent.trim())
        .find((text) => /^\[(电影|电视剧)\]$/.test(text));
      return [
        {
          id,
          title: link.textContent.trim(),
          original: cast.match(/原名[:：]\s*([^/]+)/)?.[1]?.trim() || "",
          year: cast.match(/\b(?:18|19|20)\d{2}\s*$/)?.[0]?.trim() || "",
          kind: kind ? kind.replace(/[[\]]/g, "") : "",
          rate: node.querySelector(".rating_nums")?.textContent.trim() || "",
          votes:
            Number(
              (node.querySelector(".rating-info")?.textContent || "")
                .match(/([\d,]+)\s*人评价/)?.[1]
                ?.replace(/,/g, ""),
            ) || 0,
        },
      ];
    });
  }

  function pickRow(rows, title, year, kind) {
    const want = normalizeTitle(title);
    const wantedKind = kind === "tv" ? "电视剧" : "电影";
    return (
      rows
        .filter(
          (row) =>
            normalizeTitle(row.original) === want ||
            normalizeTitle(row.title) === want,
        )
        .filter((row) => !row.kind || row.kind === wantedKind)
        .filter((row) => !year || row.year === String(year))
        .sort((a, b) => b.votes - a.votes)[0] || null
    );
  }

  function entryFromRow(row) {
    return {
      url: `https://movie.douban.com/subject/${row.id}/`,
      title: row.title || row.original,
      rate: row.rate || "",
      votes: row.votes ? String(row.votes) : "",
    };
  }

  let doubanThrottled = false;

  async function searchDouban(title, year, kind) {
    if (doubanThrottled) return null;
    const key = `search:${normalizeTitle(title)}|${year || ""}|${kind || ""}`;
    const cached = cache.get(key);
    if (cached) return cached.miss ? null : cached.entry;

    const url = `https://www.douban.com/search?cat=1002&q=${encodeURIComponent(title)}`;
    const isBlocked = (text) => !text || /异常请求|sec\.douban\.com/.test(text);
    let html = await getText(url);
    if (isBlocked(html)) {
      await sleep(1500);
      html = await getText(url);
    }
    const blocked = isBlocked(html);
    const row = blocked
      ? null
      : pickRow(parseSearchRows(html), title, year, kind);
    const entry = row ? entryFromRow(row) : null;

    cache.set(
      key,
      entry ? { entry } : { miss: true },
      entry ? DAY : blocked ? 5 * MINUTE : 30 * MINUTE,
    );
    return entry;
  }

  async function doubanById(id) {
    const json = await getJson(
      `https://movie.douban.com/j/subject_abstract?subject_id=${id}`,
    );
    const subject = json?.subject;
    if (!subject) return null;
    return {
      url: `https://movie.douban.com/subject/${id}/`,
      title: subject.title || "",
      rate: subject.rate || "",
      votes: "",
      year: subject.release_year || "",
      isTv: typeof subject.is_tv === "boolean" ? subject.is_tv : null,
    };
  }

  async function suggestDouban(title, year) {
    const key = `suggest:${normalizeTitle(title)}|${year || ""}`;
    const cached = cache.get(key);
    if (cached) return cached.miss ? null : cached.entry;

    const list = await getJson(
      `https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(title)}`,
    );
    let entry = null;
    if (Array.isArray(list) && list.length) {
      const want = normalizeTitle(title);
      const named = list.filter(
        (item) =>
          normalizeTitle(item.title) === want ||
          normalizeTitle(item.sub_title) === want,
      );
      const hit = year
        ? named.find((item) => item.year === String(year))
        : named[0];
      if (hit?.id) entry = await doubanById(hit.id);
    }

    cache.set(key, entry ? { entry } : { miss: true }, entry ? DAY : 30 * MINUTE);
    return entry;
  }

  async function wikidataLookup(imdbId) {
    const key = `wikidata:${imdbId}`;
    const cached = cache.get(key);
    if (cached) return cached.miss ? null : cached.data;

    const query = `SELECT ?douban ?zh ?en ?enwiki WHERE {
      VALUES ?imdb { "${imdbId}" }
      ?item wdt:P345 ?imdb .
      OPTIONAL { ?item wdt:P4529 ?douban }
      OPTIONAL { ?item rdfs:label ?zh FILTER(LANG(?zh) IN ("zh", "zh-cn", "zh-hans")) }
      OPTIONAL { ?item rdfs:label ?en FILTER(LANG(?en) = "en") }
      OPTIONAL {
        ?enwiki schema:about ?item ;
          schema:isPartOf <https://en.wikipedia.org/> ;
          schema:name ?enwikiTitle .
      }
    }`;

    const json = await getJson(
      `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`,
    );
    const rows = json?.results?.bindings || [];

    const doubanIds = [];
    const titles = [];
    const clean = (value) =>
      String(value || "")
        .replace(/\s*[（(][^)）]*[)）]\s*$/, "")
        .trim();

    for (const row of rows) {
      if (row.douban?.value) doubanIds.push(String(row.douban.value));
      for (const field of ["zh", "en", "enwikiTitle"]) {
        if (row[field]?.value) titles.push(row[field].value);
      }
    }

    const unique = [
      ...new Set(titles.map(clean).filter((title) => title.length > 1)),
    ].sort((a, b) => b.length - a.length);
    const ids = [...new Set(doubanIds)];

    const data = ids.length || unique.length ? { doubanIds: ids, titles: unique } : null;
    cache.set(key, data ? { data } : { miss: true }, data ? 3 * DAY : DAY);
    return data;
  }

  function subjectMatches(subject, year, kind) {
    if (!subject) return false;
    if (
      year &&
      subject.year &&
      Math.abs(Number(subject.year) - Number(year)) > 1
    ) {
      return false;
    }
    if (kind && subject.isTv !== null && subject.isTv !== (kind === "tv")) {
      return false;
    }
    return true;
  }

  async function resolveDouban({ imdbId, title, year, kind }) {
    const key = `match:${imdbId || normalizeTitle(title)}|${year || ""}|${kind || ""}`;
    const cached = cache.get(key);
    if (cached) return cached.miss ? null : cached.entry;

    const [wiki, byTitle] = await Promise.all([
      imdbId ? wikidataLookup(imdbId) : null,
      searchDouban(title, year, kind),
    ]);

    let entry = null;

    for (const id of wiki?.doubanIds || []) {
      const subject = await doubanById(id);
      if (subject) {
        if (subjectMatches(subject, year, kind)) entry = subject;
        if (entry) break;
        continue;
      }
      entry = {
        url: `https://movie.douban.com/subject/${id}/`,
        title,
        rate: "",
        votes: "",
      };
      break;
    }

    if (!entry) entry = byTitle;

    if (!entry && wiki?.titles?.length) {
      const tried = new Set([normalizeTitle(title)]);
      for (const candidate of wiki.titles.slice(0, 4)) {
        const normalized = normalizeTitle(candidate);
        if (!normalized || tried.has(normalized)) continue;
        tried.add(normalized);
        entry = await searchDouban(candidate, year, kind);
        if (entry) break;
      }
    }

    if (!entry) entry = await suggestDouban(title, year);

    cache.set(key, entry ? { entry } : { miss: true }, entry ? DAY : 20 * MINUTE);
    return entry;
  }

  function searchFallbackEntry(title, year) {
    return {
      url: `https://www.douban.com/search?cat=1002&q=${encodeURIComponent(
        searchQuery(title, year),
      )}`,
      title: title || "",
      rate: "",
      votes: "",
      fallback: true,
    };
  }

  const WIDGET_CSS = `
    .mri-top250 {
      display: inline-flex; align-items: center; gap: 6px;
      margin: 8px 0; padding: 5px 10px; border-radius: 4px;
      background: #f5c518; font: 12px/1.4 Helvetica, Arial, sans-serif;
    }
    .mri-top250-no { font-weight: 700; color: #000; }
    .mri-top250 a { color: #000; text-decoration: underline; }

    #movie-rating-integrator-douban {
      --mri-accent: #f5c518;
      --mri-muted: #a2a2a2;
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; margin-inline-start: 32px; padding-inline-start: 32px;
      border-inline-start: 1px solid rgb(255 255 255 / 0.15);
      color: inherit; font-family: inherit; line-height: 1.3;
      text-align: center; text-decoration: none;
    }
    #movie-rating-integrator-douban .mri-badge-label {
      font-size: 13px; font-weight: 600; letter-spacing: 0.08em;
      color: var(--mri-muted); white-space: nowrap;
    }
    #movie-rating-integrator-douban .mri-badge-row {
      display: flex; align-items: center; gap: 6px; margin-top: 6px;
    }
    #movie-rating-integrator-douban .mri-mark {
      display: inline-flex; align-items: center; justify-content: center;
      width: 18px; height: 18px; border-radius: 4px; flex-shrink: 0;
      background: #2ea44f; color: #fff; font-size: 11px; font-weight: 700; line-height: 1;
    }
    #movie-rating-integrator-douban .mri-score {
      font-size: 26px; font-weight: 700; color: var(--mri-accent);
    }
    #movie-rating-integrator-douban .mri-score-total {
      font-size: 14px; color: var(--mri-muted);
    }
    #movie-rating-integrator-douban .mri-title {
      display: inline-block; max-width: 120px; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; font-size: 16px;
      font-weight: 700; color: var(--mri-accent);
    }
    #movie-rating-integrator-douban .mri-pending {
      font-size: 12px; color: var(--mri-muted); white-space: nowrap;
    }

    #movie-rating-integrator-search {
      display: flex; flex-direction: column; align-items: stretch;
      gap: 8px; padding: 12px 0 4px; margin-top: 12px;
      border-top: 1px solid #eaeaea;
    }
    #movie-rating-integrator-search > a {
      display: flex; align-items: center; justify-content: center;
      gap: 6px; padding: 5px 12px; border-radius: 4px; box-sizing: border-box;
      background: var(--mri-site-color, #2ea44f); color: #fff;
      font-size: 13px; line-height: 1.6; text-decoration: none;
    }
    #movie-rating-integrator-search svg { display: block; flex-shrink: 0; }

    .mri-ratings { padding: 15px 0; border-top: 1px solid #eaeaea; }
    #interest_sectl.mri-pushed { margin-top: 96px; }
    .mri-info-link { text-decoration: none; }
    .mri-info-link + .mri-info-link { margin-inline-start: 8px; }
    .mri-metascore {
      display: inline-block; width: 24px; height: 24px; border-radius: 2px;
      background: var(--mri-metascore-color); color: #fff;
      font-weight: 700; line-height: 24px; text-align: center; vertical-align: middle;
    }
    .mri-tomato-icon { font-size: 14px; vertical-align: middle; margin: 0 2px; }
    #interest_sectl .rating_sum,
    #movie-rating-integrator-extra .rating_sum { clear: both; }
  `;

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = WIDGET_CSS;
    document.head.appendChild(style);
  }

  const observers = [];

  function stopObserver(observer) {
    observer.disconnect();
    const index = observers.indexOf(observer);
    if (index !== -1) observers.splice(index, 1);
  }

  function waitForAny(selectors, timeout = 10000) {
    const find = () => selectors.map((selector) => qs(selector)).find(Boolean);
    return new Promise((resolve) => {
      const existing = find();
      if (existing) {
        resolve(existing);
        return;
      }
      let pending = false;
      const observer = new MutationObserver(() => {
        if (pending) return;
        pending = true;
        scheduleIdle(() => {
          pending = false;
          const node = find();
          if (node) {
            stopObserver(observer);
            resolve(node);
          }
        });
      });
      observers.push(observer);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => {
        stopObserver(observer);
        resolve(find() || null);
      }, timeout);
    });
  }

  function waitForElement(selector, timeout = 8000) {
    return waitForAny([selector], timeout);
  }

  function heroTitle() {
    const node = qs("h1, [data-testid='hero__pageTitle']");
    return (node?.textContent || "").trim().replace(/\s+/g, " ");
  }

  function heroYear() {
    const pattern = /\b(?:18|19|20)\d{2}\b/;
    const fromLink = qs(
      '[data-testid="hero-title-block__metadata"] a[href*="releaseinfo"]',
    )?.textContent.match(pattern)?.[0];
    if (fromLink) return fromLink;
    const inParens = document.title.match(/\(([^)]*)\)/)?.[1];
    const fromTitle = inParens?.match(pattern)?.[0];
    if (fromTitle) return fromTitle;
    return qs('[data-testid="hero-title-block__metadata"]')?.textContent.match(
      /(?:18|19|20)\d{2}/,
    )?.[0];
  }

  function heroKind() {
    const meta =
      qs('[data-testid="hero-title-block__metadata"]')?.textContent || "";
    return /TV (?:Mini )?Series/i.test(`${document.title} ${meta}`)
      ? "tv"
      : "movie";
  }

  function badgeAnchor() {
    const selectors = [
      '[data-testid="hero-rating-bar__aggregate-rating"]',
      '[data-testid="aggregateRating"]',
      '[data-testid="titleRatingAndRatingCount"]',
      ".rating-bar__base-button",
      '[class*="AggregateRating"]',
    ];
    const hit = selectors.map((selector) => qs(selector)).find(Boolean);
    if (hit) return hit;

    const root =
      qs('[data-testid="hero"]') || qs('[data-testid="title-hero"]') || document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.textContent && node.textContent.length < 64
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });
    let scanned = 0;
    let node;
    while ((node = walker.nextNode())) {
      if (/^\s*\d\.\d\s*\/\s*10\s*$/.test(node.textContent)) {
        return node.parentElement?.closest("div,span") || null;
      }
      if (++scanned >= 200) break;
    }
    return null;
  }

  function buildBadge(entry) {
    const rating = Number(entry.rate);
    const score = entry.rate && Number.isFinite(rating) ? rating.toFixed(1) : "";
    const label = entry.fallback ? "豆瓣" : "豆瓣评分";
    const body = score
      ? '<span class="mri-mark">豆</span>' +
        `<span class="mri-score">${escapeHtml(score)}</span>` +
        '<span class="mri-score-total">/10</span>'
      : entry.fallback
        ? '<span class="mri-title">去搜索</span>' +
          '<span class="mri-pending">未匹配到条目</span>'
        : `<span class="mri-title">${escapeHtml(entry.title)}</span>` +
          '<span class="mri-pending">暂无评分</span>';

    const badge = document.createElement("a");
    badge.id = BADGE_ID;
    badge.href = safeUrl(entry.url);
    badge.target = "_blank";
    badge.rel = "noopener noreferrer";
    badge.title = entry.fallback
      ? `在豆瓣搜索「${entry.title}」`
      : `豆瓣：${entry.title}${score ? `（${score}）` : "（暂无评分）"}`;
    badge.setAttribute(
      "aria-label",
      entry.fallback
        ? `豆瓣未匹配到条目，点击在豆瓣搜索 ${entry.title}`
        : `豆瓣评分：${entry.title} ${score ? `${score} / 10` : "暂无评分"}`,
    );
    badge.innerHTML =
      `<span class="mri-badge-label">${label}</span>` +
      `<span class="mri-badge-row">${body}</span>`;
    return badge;
  }

  function insertBadge(anchor, entry) {
    const badge = buildBadge(entry);
    (anchor.parentElement || anchor).appendChild(badge);
  }

  function keepBadge(entry) {
    let retries = 0;
    let pending = false;
    const observer = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      scheduleIdle(() => {
        pending = false;
        if (document.getElementById(BADGE_ID)) return;
        const anchor = badgeAnchor();
        if (!anchor) return;
        if (retries++ >= 8) {
          stopObserver(observer);
          return;
        }
        insertBadge(anchor, entry);
      });
    });
    observers.push(observer);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => stopObserver(observer), 30000);
  }

  async function handleImdbPage() {
    const imdbId = location.pathname.match(/tt\d+/)?.[0];
    if (!imdbId) return;

    await waitForAny(['[data-testid="hero__pageTitle"]', "h1"], 10000);
    const anchor = await waitForAny(
      [
        '[data-testid="hero-rating-bar__aggregate-rating"]',
        '[data-testid="aggregateRating"]',
        '[data-testid="titleRatingAndRatingCount"]',
        ".rating-bar__base-button",
        '[class*="AggregateRating"]',
      ],
      12000,
    );

    const title = heroTitle();
    if (!title) {
      console.warn("[影评聚合] 未能从页面取到片名");
      return;
    }

    const year = heroYear();
    const kind = heroKind();
    const entry =
      (await resolveDouban({ imdbId, title, year, kind })) ||
      searchFallbackEntry(title, year);

    if (document.getElementById(BADGE_ID)) return;
    const target = anchor || badgeAnchor();
    if (!target) {
      console.warn("[影评聚合] 未找到 IMDb 评分块，跳过插入");
      return;
    }

    insertBadge(target, entry);
    console.log(
      "[影评聚合] 豆瓣:",
      entry.fallback ? "未匹配，提供搜索入口" : `${entry.title} ${entry.rate || "暂无评分"}`,
      entry.url,
    );
    keepBadge(entry);
  }

  function linkify(node, base) {
    if (!node) return null;
    if (node.nodeName === "A") return node.textContent.trim() || null;
    const id = node.textContent?.trim();
    if (!id) return null;
    const anchor = Object.assign(document.createElement("a"), {
      href: base + id,
      target: "_blank",
      rel: "noopener noreferrer",
      textContent: id,
    });
    node.replaceWith(anchor);
    anchor.insertAdjacentText("beforebegin", " ");
    return id;
  }

  function insertDoubanRating(parent, title, rating, link, numRaters) {
    const numeric = Number(rating);
    const stars = (5 * Math.round(numeric)).toString().padStart(2, "0");
    const shown = Number.isFinite(numeric) ? numeric.toFixed(1) : rating;
    const votes = formatCount(numRaters);
    const voterHtml = votes
      ? `<a href="${safeUrl(link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(votes)}人评价</a>`
      : "";
    parent.insertAdjacentHTML(
      "beforeend",
      `
            <div class="rating_logo">${escapeHtml(title)}</div>
            <div class="rating_self clearfix">
                <strong class="ll rating_num">${escapeHtml(shown)}</strong>
                <div class="rating_right">
                    <div class="ll bigstar${stars}"></div>
                    <div class="rating_sum">${voterHtml}</div>
                </div>
            </div>`,
    );
  }

  function insertDoubanInfo(name, value) {
    const info = qs("#info");
    if (!info) return;
    if (info.lastElementChild?.nodeName !== "BR") {
      info.insertAdjacentHTML("beforeend", "<br>");
    }
    info.insertAdjacentHTML(
      "beforeend",
      `<span class="pl">${escapeHtml(name)}:</span> ${escapeHtml(value)}<br>`,
    );
  }

  function metacriticSlug(title) {
    return title
      .toLowerCase()
      .replace(/[:'".,?!&]/g, "")
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/^-+|-+$/g, "")
      .replace(/-(ii|iii|iv|v|vi|vii|viii|ix|x)$/, (_, roman) => `-${ROMAN[roman]}`);
  }

  const tomatoIcon = (icon) => `<span class="mri-tomato-icon">${icon}</span>`;

  let omdbKeyIndex = 0;

  async function getImdbInfo(imdbId) {
    const key = OMDB_KEYS[omdbKeyIndex++ % OMDB_KEYS.length];
    const [omdbResult, ratingsResult] = await Promise.allSettled([
      getJson(`https://www.omdbapi.com/?tomatoes=true&apikey=${key}&i=${imdbId}`),
      getText(
        `https://p.media-imdb.com/static-content/documents/v1/title/${imdbId}/ratings%3Fjsonp=imdb.rating.run:imdb.api.title.ratings/data.json`,
      ),
    ]);

    const data = (omdbResult.status === "fulfilled" && omdbResult.value) || {};
    const text = ratingsResult.status === "fulfilled" ? ratingsResult.value : "";
    const match = text?.match(/^[^(]+\(([\s\S]+)\)\s*;?\s*$/);

    if (match) {
      try {
        const resource = JSON.parse(match[1])?.resource;
        if (resource?.rating) data.imdbRating = resource.rating;
        if (resource?.ratingCount) data.imdbVotes = resource.ratingCount;
        if (resource?.topRank) data.topRank = resource.topRank;
      } catch {}
    }

    return data;
  }

  function renderMetascore(container, data) {
    if (isBlank(data.Metascore) || !data.Title) return;
    const metascore = parseInt(data.Metascore, 10);
    if (!Number.isFinite(metascore)) return;
    const color = metascore >= 60 ? "#6c3" : metascore >= 40 ? "#fc3" : "#f00";
    const url = safeUrl(
      `https://www.metacritic.com/movie/${metacriticSlug(data.Title)}/`,
    );
    if (!url) return;
    container.insertAdjacentHTML(
      "beforeend",
      `<br>Metascore: <a class="mri-info-link" href="${url}" target="_blank" rel="noopener noreferrer"><span class="mri-metascore" style="--mri-metascore-color:${color}">${escapeHtml(String(metascore))}</span></a>`,
    );
  }

  function renderRottenTomatoes(container, data) {
    const rt = data.Ratings?.find((item) => item.Source === "Rotten Tomatoes");
    if (!rt?.Value) return;
    const fresh = parseInt(rt.Value, 10) >= 60;
    const url = safeUrl((data.tomatoURL || "").replace("http://", "https://"));
    container.insertAdjacentHTML(
      "beforeend",
      `<br><a class="mri-info-link" href="${url}" target="_blank" rel="noopener noreferrer">${tomatoIcon(fresh ? TOMATO.fresh : TOMATO.rotten)}<span>${escapeHtml(rt.Value)} 烂番茄新鲜度</span></a>`,
    );
    if (isBlank(data.tomatoUserMeter)) return;
    const liked = parseFloat(data.tomatoUserRating) >= 3.5;
    container.insertAdjacentHTML(
      "beforeend",
      `<a class="mri-info-link" href="${url}" target="_blank" rel="noopener noreferrer">${tomatoIcon(liked ? TOMATO.liked : TOMATO.disliked)}<span>${escapeHtml(String(data.tomatoUserMeter))}% 观众爆米花</span></a>`,
    );
  }

  function collectSearchTitle(year) {
    const raw = (qs("[property='v:itemreviewed']")?.textContent || "").trim();
    let source = raw;
    if (!source) {
      const h1 = qs("h1");
      try {
        const clone = h1.cloneNode(true);
        qsa(".year", clone).forEach((node) => node.remove());
        source = (clone.textContent || "").trim();
      } catch {
        source = (h1?.textContent || "").trim();
      }
    }

    const stripYear = (text) => {
      let out = String(text || "")
        .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, "")
        .replace(/^(又名|譯名|译名)\s*[:：]/, "")
        .replace(/\s*[(（]\s*\d{4}\s*[)）]\s*$/, "");
      if (year) out = out.replace(new RegExp(`\\s+${year}\\s*$`), "");
      return out.replace(/\s+/g, " ").trim();
    };

    source = stripYear(source);
    if (!source) return "";

    const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
    const KANA = /[\u3040-\u30ff\u31f0-\u31ff]/;
    const HANGUL = /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7af]/;
    const CJK_PUNCT = /[\u3000-\u303e\uff01-\uff0f\uff1b-\uff65]/;

    const kindOf = (char) => {
      if (HAN.test(char)) return "han";
      if (KANA.test(char)) return "kana";
      if (HANGUL.test(char)) return "hangul";
      return "latin";
    };

    const segments = [];
    for (const char of source) {
      const kind =
        CJK_PUNCT.test(char) && segments.length
          ? segments[segments.length - 1].kind
          : kindOf(char);
      const last = segments[segments.length - 1];
      if (last && last.kind === kind) last.text += char;
      else segments.push({ kind, text: char });
    }

    const segStart = [];
    let cursor = 0;
    for (const segment of segments) {
      segStart.push(cursor);
      cursor += segment.text.length;
    }
    for (let i = 1; i < segments.length; i++) {
      const segment = segments[i];
      const previous = segments[i - 1];
      if (segment.kind !== "latin" || previous.kind !== "han") continue;
      const digits = segment.text.match(/^(\d*\.\d+|\d+\.?)/)?.[0];
      if (!digits) continue;
      const after = segStart[i] + digits.length;
      if (/[A-Za-z]/.test(source[after] || "")) continue;
      previous.text += digits;
      segment.text = segment.text.slice(digits.length);
      segStart[i] = after;
    }

    for (const segment of segments) {
      if (segment.kind === "latin" && /^[\u2e80-\u2fff]+$/.test(segment.text)) {
        segment.kind = "han";
      }
    }

    const trimEdges = (text) =>
      text.replace(
        /^[\s:：,，.。、！？!?·\-—/|～~]+|[\s:：,，.。、！？!?·\-—/|～~]+$/g,
        "",
      );

    const join = (kind, separator) =>
      trimEdges(
        segments
          .filter((segment) => segment.kind === kind && segment.text)
          .map((segment) => trimEdges(segment.text))
          .filter(Boolean)
          .join(separator),
      );

    const stripSeason = (text) =>
      text
        .replace(/\s+season\s+\d+\s*$/i, "")
        .replace(/\s*第\s*[0-9一二三四五六七八九十]+\s*季\s*$/, "")
        .trim();

    const latin = stripSeason(join("latin", " "));
    const hangul = join("hangul", " ");
    const eastAsian = stripSeason(
      trimEdges(
        source.split(/\s+/).find((part) => HAN.test(part) || KANA.test(part)) || "",
      ),
    );

    return latin || hangul || eastAsian || source;
  }

  function subjectYear() {
    const toYear = (text) =>
      String(text || "").match(/\b(?:18|19|20)\d{2}\b/)?.[0] || "";

    const fromSpan = toYear(qs("h1 .year")?.textContent);
    if (fromSpan) return fromSpan;

    for (const label of qsa("#info > span.pl")) {
      if (/上映(日期|时间)|首播/.test(label.textContent.trim())) {
        const year = toYear(label.nextSibling?.textContent);
        if (year) return year;
      }
    }

    const fromHeading = toYear(
      (qs("h1")?.textContent || "").match(/[(（]\s*((?:18|19|20)\d{2})\s*[)）]/)?.[1],
    );
    if (fromHeading) return fromHeading;

    const fromDocTitle = toYear(
      document.title.match(/[(（]\s*((?:18|19|20)\d{2})\s*[)）]/)?.[1],
    );
    if (fromDocTitle) return fromDocTitle;

    return toYear(qs("#info")?.textContent);
  }

  function renderSearchSection(container, title, year) {
    if (document.getElementById(SEARCH_ID)) return;
    const topic = searchQuery(title, year);
    if (!topic) return;

    const links = SITES.map((site) => {
      const href = safeUrl(site.url(title, year));
      return href ? { site, href } : null;
    }).filter(Boolean);
    if (!links.length) return;

    const section = document.createElement("div");
    section.id = SEARCH_ID;
    const icon = (path) =>
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      path +
      "</svg>";
    section.innerHTML = links
      .map(
        ({ site, href }) =>
          `<a href="${href}" target="_blank" rel="noopener noreferrer" ` +
          `style="--mri-site-color:${site.color}" ` +
          `title="在 ${escapeHtml(site.label)} 搜索「${escapeHtml(topic)}」的资源（新标签页打开）">` +
          `${icon(site.icon)}去 ${escapeHtml(site.label)} 搜索` +
          "</a>",
      )
      .join("");
    container.appendChild(section);
  }

  function ensureRecoveredRating(dbId) {
    const wrap = qs(".subjectwrap");
    const subject = qs(".subject");
    if (!wrap || !subject) return null;

    const section = document.createElement("div");
    section.id = "interest_sectl";
    wrap.insertBefore(section, subject.nextSibling);

    const ratings = document.createElement("div");
    ratings.className = "rating_wrap";
    section.appendChild(ratings);

    doubanById(dbId).then((entry) => {
      if (entry?.rate) {
        insertDoubanRating(
          ratings,
          "豆瓣评分",
          entry.rate,
          `https://movie.douban.com/subject/${dbId}/collections`,
          "",
        );
      }
    });

    if (qs("#movie-rating-iframe")) section.classList.add("mri-pushed");
    return section;
  }

  async function handleDoubanMoviePage() {
    await waitForElement("#info");

    const dbId = location.href.match(/douban\.com\/subject\/(\d+)/)?.[1];
    let section = document.getElementById("interest_sectl");
    if (!section) {
      if (!dbId) return;
      section = ensureRecoveredRating(dbId);
      if (!section) return;
    }
    if (document.getElementById(PANEL_ID)) return;

    const imdbLabel = qsa("#info > span.pl").find(
      (node) => node.textContent.trim() === "IMDb:",
    );
    const imdbId = linkify(imdbLabel?.nextSibling, "https://www.imdb.com/title/");

    const data = imdbId ? await getImdbInfo(imdbId) : null;
    const hasRottenTomatoes = Boolean(
      data?.Ratings?.find((item) => item.Source === "Rotten Tomatoes")?.Value,
    );
    const hasExtra = !isBlank(data?.Rated) || !isBlank(data?.BoxOffice);
    const hasRatings =
      Boolean(data) &&
      (!isBlank(data.imdbRating) ||
        !isBlank(data.Metascore) ||
        hasRottenTomatoes ||
        hasExtra);

    const year = subjectYear();
    const title = collectSearchTitle(year);
    if (!hasRatings && !title) return;

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = "rating_wrap clearbox mri-ratings";

    const ratingWrap = qs(".friends_rating_wrap") || qs(".rating_wrap");
    section.insertBefore(panel, ratingWrap?.nextSibling || null);
    section.style.marginBottom = qs(".colbutt") ? "-136px" : "-154px";

    const recommendation = qs(".rec-sec, #interest_sect_level");
    if (recommendation) recommendation.style.width = "488px";

    if (hasRatings) {
      if (!isBlank(data.imdbRating)) {
        insertDoubanRating(
          panel,
          "IMDb评分",
          data.imdbRating,
          `https://www.imdb.com/title/${imdbId}/ratings`,
          data.imdbVotes,
        );

        if (!isBlank(data.topRank) && data.topRank <= 250 && !qs(".mri-top250")) {
          (
            document.getElementById("dale_movie_subject_top_icon") || qs("h1")
          )?.insertAdjacentHTML(
            "beforebegin",
            `<div class="mri-top250"><span class="mri-top250-no">No.${data.topRank}</span><a href="https://www.imdb.com/chart/top">IMDb Top 250</a></div>`,
          );
        }
      }
      renderMetascore(panel, data);
      renderRottenTomatoes(panel, data);
    }

    renderSearchSection(panel, title, year);

    if (hasRatings) {
      if (!isBlank(data.Rated)) insertDoubanInfo("MPAA评级", data.Rated);
      if (!isBlank(data.BoxOffice)) insertDoubanInfo("票房", data.BoxOffice);
    }
  }

  function handleDoubanPersonPage() {
    const node = qsa("span.value").find((item) =>
      /^nm\d+/.test(item.textContent.trim()),
    );
    if (node) linkify(node, "https://www.imdb.com/name/");
  }

  window.addEventListener("beforeunload", () => {
    while (observers.length) stopObserver(observers[observers.length - 1]);
  });

  function init() {
    ensureStyles();
    if (HOST === "movie.douban.com") handleDoubanMoviePage();
    else if (HOST === "www.douban.com") handleDoubanPersonPage();
    else if (HOST === "www.imdb.com" || HOST === "imdb.com") handleImdbPage();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
