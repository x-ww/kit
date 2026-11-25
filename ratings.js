// ==UserScript==
// @name         影评聚合
// @name:en      Movie Ratings
// @name:zh-CN   影评聚合
// @namespace    https://github.com/x-ww/kit
// @version      1.9.0
// @description  豆瓣/IMDb 多平台评分聚合，附 BT4G 搜索
// @description:en  Movie ratings aggregator for Douban/IMDb
// @description:zh-CN  豆瓣/IMDb 多平台评分聚合，附 BT4G 搜索
// @author       x-ww
// @match        *://movie.douban.com/subject/*
// @match        *://www.douban.com/personage/*
// @match        *://www.imdb.com/title/*
// @match        *://imdb.com/title/*
// @connect      movie.douban.com
// @connect      www.douban.com
// @connect      www.omdbapi.com
// @connect      p.media-imdb.com
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @homepageURL  https://github.com/x-ww/kit
// @supportURL   https://github.com/x-ww/kit/issues
// @updateURL    https://github.com/x-ww/kit/raw/main/ratings.js
// @downloadURL  https://github.com/x-ww/kit/raw/main/ratings.js
// @noframes
// @run-at       document-end
// ==/UserScript==
"use strict";

(() => {
  const GM_REQUEST =
    typeof GM !== "undefined" && GM?.xmlHttpRequest
      ? GM.xmlHttpRequest
      : typeof GM_xmlhttpRequest !== "undefined"
        ? GM_xmlhttpRequest
        : null;
  const OMDB_KEYS = [
    "40700ff1",
    "4ee790e0",
    "d82cb888",
    "386234f9",
    "d58193b6",
    "15c0aa3f",
  ];
  const STYLE_ID = "movie-rating-integrator-style";
  const DOUBAN_RECOVERED_TITLE = "Rating recovered by script.";
  const host = location.hostname;

  const SEARCH_BUTTON_ID = "movie-rating-integrator-search";
  const ICON_SVG = {
    download:
      '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 21h16"/>',
    search:
      '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-5-5"/><path d="M10.5 7.5v6M7.5 10.5h6"/>',
  };
  const SEARCH_SITES = [
    {
      id: "bt4g",
      label: "BT4G",
      icon: ICON_SVG.download,
      color: "#2ea44f",
      buildUrl: (title, year) => {
        const params = new URLSearchParams();
        params.set("q", buildSearchQuery(title, year));
        return `https://bt4gprx.com/search?${params.toString()}`;
      },
    },
    {
      id: "uindex",
      label: "UIndex",
      icon: ICON_SVG.search,
      color: "#0969da",
      buildUrl: (title, year) => {
        const params = new URLSearchParams();
        params.set("search", buildSearchQuery(title, year));
        return `https://uindex.org/search.php?${params.toString()}`;
      },
    },
  ];

  const TOMATO_ICON_FRESH = "🍅";
  const TOMATO_ICON_ROTTEN = "🟢";
  const TOMATO_USER_ICON_POSITIVE = "🍿";
  const TOMATO_USER_ICON_NEGATIVE = "💤";

  const isNA = (value) => value == null || value === "" || value === "N/A";
  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => [
    ...root.querySelectorAll(selector),
  ];

  const CACHE_KEY = "movie-rating-integrator-cache";
  const CACHE_TTL = 24 * 60 * 60 * 1000;
  const PENDING_CACHE_TTL = 60 * 60 * 1000;
  const EMPTY_CACHE_TTL = 5 * 60 * 1000;
  const NO_MATCH_TTL = 10 * 60 * 1000;
  const CACHE_MAX_SIZE = 100;
  const CACHE_EVICT_COUNT = 10;

  function getCached(key) {
    try {
      const cache = JSON.parse(GM_getValue(CACHE_KEY, "{}"));
      const entry = cache[key];
      if (entry && Date.now() - entry.timestamp < (entry.ttl ?? CACHE_TTL)) {
        return entry.data;
      }
    } catch (error) {
      console.warn("[影评聚合] 读取缓存失败，本次请求将不命中缓存:", error);
    }
    return null;
  }

  function setCache(key, data, ttl) {
    try {
      const cache = JSON.parse(GM_getValue(CACHE_KEY, "{}"));
      cache[key] = { data, timestamp: Date.now(), ttl };

      const keys = Object.keys(cache);
      if (keys.length > CACHE_MAX_SIZE) {
        keys
          .sort((a, b) => cache[a].timestamp - cache[b].timestamp)
          .slice(0, CACHE_EVICT_COUNT)
          .forEach((k) => delete cache[k]);
      }

      GM_setValue(CACHE_KEY, JSON.stringify(cache));
    } catch (error) {
      console.warn("[影评聚合] 写入缓存失败，下次访问会重新请求:", error);
    }
  }

  function resolveCacheTtl(result) {
    if (Array.isArray(result) && result.length === 0) return EMPTY_CACHE_TTL;
    const isUnrated = result?.subject && !result.subject.rate;
    return isUnrated ? PENDING_CACHE_TTL : CACHE_TTL;
  }

  function escapeHtml(value) {
    if (value == null) return "";
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/\n/g, "&#10;")
      .replace(/\r/g, "&#13;");
  }

  function safeUrl(url) {
    if (!url) return "";
    try {
      const parsed = new URL(url, location.href);
      return /^https?:$/.test(parsed.protocol) ? parsed.href : "";
    } catch {
      return "";
    }
  }

  const activeObservers = [];
  const scheduleIdle =
    typeof window !== "undefined" && window.requestIdleCallback
      ? window.requestIdleCallback.bind(window)
      : (fn) => setTimeout(fn, 0);

  function finishObserver(observer) {
    try {
      observer.disconnect();
    } catch {}
    const idx = activeObservers.indexOf(observer);
    if (idx !== -1) activeObservers.splice(idx, 1);
  }

  function gmRequestSingle(url) {
    return new Promise((resolve) => {
      if (!GM_REQUEST) {
        console.error("GM.xmlHttpRequest is unavailable.");
        resolve({ text: undefined, shouldRetry: false });
        return;
      }

      GM_REQUEST({
        method: "GET",
        url,
        onload: (response) => {
          if (response.status >= 200 && response.status < 400) {
            resolve({ text: response.responseText, shouldRetry: false });
            return;
          }
          const status = response.status;
          if (status === 429) {
            let retryAfterHeader = "";
            try {
              retryAfterHeader =
                response.getResponseHeader("Retry-After") || "";
            } catch {
              retryAfterHeader = "";
            }
            const retryAfter = Math.max(
              30000,
              (parseInt(retryAfterHeader, 10) || 0) * 1000,
            );
            console.error(
              `Rate limited (429) ${url}: retry in ${retryAfter}ms`,
            );
            resolve({ text: undefined, shouldRetry: true, status, retryAfter });
            return;
          }
          const shouldRetry = status >= 500;
          console.error(
            `Error ${url}:`,
            status,
            response.responseText,
          );
          resolve({ text: undefined, shouldRetry, status });
        },
        onerror: (response) => {
          console.error(`GM error ${url}:`, response.statusText || response);
          resolve({ text: undefined, shouldRetry: true });
        },
      });
    });
  }

  async function gmRequest(url, maxRetries = 2) {
    for (let i = 0; i <= maxRetries; i++) {
      const { text, shouldRetry, status, retryAfter } =
        await gmRequestSingle(url);
      if (text !== undefined) return text;
      if (!shouldRetry) return undefined;

      if (i < maxRetries) {
        const delay = retryAfter ?? 1000 * (i + 1);
        console.warn(
          `Retry ${i + 1}/${maxRetries} for ${url} after ${delay}ms` +
            (status === 429 ? " (rate limited)" : ""),
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    return undefined;
  }

  async function gmJson(url) {
    const cacheKey = url;
    const cached = getCached(cacheKey);
    if (cached !== null) {
      console.log(`[Cache hit] ${url}`);
      return cached;
    }

    const text = await gmRequest(url);
    if (!text) return undefined;

    try {
      const result = JSON.parse(text);
      if (result) {
        setCache(cacheKey, result, resolveCacheTtl(result));
      }
      return result;
    } catch (error) {
      console.error(`JSON parse ${url}:`, error);
      return undefined;
    }
  }

  async function gmJsonp(url) {
    const text = await gmRequest(url);
    if (!text) return undefined;

    try {
      const match = text.match(/^[^(]+\(([\s\S]+)\)\s*;?\s*$/);
      return match ? JSON.parse(match[1]) : undefined;
    } catch (error) {
      console.error(`JSONP parse ${url}:`, error);
      return undefined;
    }
  }

  function waitForElement(selector, timeout = 8000) {
    return new Promise((resolve) => {
      const existing = qs(selector);
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
          const node = qs(selector);
          if (node) {
            finishObserver(observer);
            resolve(node);
          }
        });
      });

      activeObservers.push(observer);

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });

      setTimeout(() => {
        finishObserver(observer);
        resolve(qs(selector) ?? null);
      }, timeout);
    });
  }

  function waitForAny(selectors, timeout = 10000) {
    return new Promise((resolve) => {
      const find = () => {
        for (const sel of selectors) {
          const node = qs(sel);
          if (node) return node;
        }
        return null;
      };
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
            finishObserver(observer);
            resolve(node);
          }
        });
      });
      activeObservers.push(observer);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      setTimeout(() => {
        finishObserver(observer);
        resolve(find());
      }, timeout);
    });
  }

  function formatVoterCount(value) {
    if (value == null || value === "") return "";
    const numeric = Number(String(value).replace(/,/g, ""));
    if (!Number.isFinite(numeric) || numeric === 0) return "";
    return new Intl.NumberFormat("en-US").format(numeric);
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
    #movie-rating-integrator-douban .mri-badge-row { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
    #movie-rating-integrator-douban .mri-mark {
      display: inline-flex; align-items: center; justify-content: center;
      width: 18px; height: 18px; border-radius: 4px; flex-shrink: 0;
      background: #2ea44f; color: #fff; font-size: 11px; font-weight: 700; line-height: 1;
    }
    #movie-rating-integrator-douban .mri-score { font-size: 26px; font-weight: 700; color: var(--mri-accent); }
    #movie-rating-integrator-douban .mri-score-total { font-size: 14px; color: var(--mri-muted); }
    #movie-rating-integrator-douban .mri-title {
      display: inline-block; max-width: 120px; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; font-size: 16px;
      font-weight: 700; color: var(--mri-accent);
    }
    #movie-rating-integrator-douban .mri-pending { font-size: 12px; color: var(--mri-muted); white-space: nowrap; }

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
    .mri-histogram .stars { display: inline-block; width: 18px; text-align: center; }
    .mri-histogram .power {
      display: inline-block; width: var(--mri-bar); height: 12px;
      background: #f2b134; vertical-align: middle;
    }
    .mri-histogram .rating_per { margin-inline-start: 4px; }
  `;

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = WIDGET_CSS;
    document.head.appendChild(style);
  }

  const ROMAN_TO_ARABIC = {
    ii: 2,
    iii: 3,
    iv: 4,
    v: 5,
    vi: 6,
    vii: 7,
    viii: 8,
    ix: 9,
    x: 10,
  };

  function buildMetacriticSlug(title) {
    return title
      .toLowerCase()
      .replace(/[:'".,?!&]/g, "")
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/^-+|-+$/g, "")
      .replace(
        /-(ii|iii|iv|v|vi|vii|viii|ix|x)$/,
        (_, roman) => `-${ROMAN_TO_ARABIC[roman]}`,
      );
  }

  function buildTomatoIcon(icon) {
    return `<span class="mri-tomato-icon">${icon}</span>`;
  }

  let omdbKeyIndex = 0;
  function getNextOmdbKey() {
    return OMDB_KEYS[omdbKeyIndex++ % OMDB_KEYS.length];
  }

  async function getIMDbInfo(id) {
    const key = getNextOmdbKey();
    const [omdbResult, imdbResult] = await Promise.allSettled([
      gmJson(`https://www.omdbapi.com/?tomatoes=true&apikey=${key}&i=${id}`),
      gmJsonp(
        `https://p.media-imdb.com/static-content/documents/v1/title/${id}/ratings%3Fjsonp=imdb.rating.run:imdb.api.title.ratings/data.json`,
      ),
    ]);
    const omdb = omdbResult.status === "fulfilled" ? omdbResult.value : null;
    const imdb = imdbResult.status === "fulfilled" ? imdbResult.value : null;
    const data = omdb || {};
    const resource = imdb?.resource;

    if (resource) {
      if (resource.rating) data.imdbRating = resource.rating;
      if (resource.ratingCount) data.imdbVotes = resource.ratingCount;
      if (resource.ratingsHistograms?.["IMDb Users"])
        data.histogram = resource.ratingsHistograms["IMDb Users"].histogram;
      if (resource.topRank) data.topRank = resource.topRank;
    }

    return data;
  }

  const normalizeTitle = (value) =>
    String(value || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[’'`´]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();

  function getImdbYear() {
    const yearPattern = /\b(?:19|20)\d{2}\b/;
    const linkYear = qs(
      '[data-testid="hero-title-block__metadata"] a[href*="releaseinfo"]',
    )?.textContent.match(yearPattern)?.[0];
    if (linkYear) return linkYear;
    const inParens = document.title.match(/\(([^)]*)\)/)?.[1];
    const fromTitle = inParens?.match(yearPattern)?.[0];
    if (fromTitle) return fromTitle;
    return qs('[data-testid="hero-title-block__metadata"]')?.textContent.match(
      /(?:19|20)\d{2}/,
    )?.[0];
  }

  function parseDoubanSearch(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const rows = [];
    for (const el of doc.querySelectorAll(".result")) {
      const sid = el
        .querySelector("[onclick*='sid:']")
        ?.getAttribute("onclick")
        ?.match(/sid:\s*(\d+)/)?.[1];
      const link = el.querySelector(".title h3 a");
      if (!sid || !link) continue;
      const cast = el.querySelector(".subject-cast")?.textContent || "";
      rows.push({
        sid,
        title: link.textContent.trim(),
        original: cast.match(/原名[:：]\s*([^/]+)/)?.[1]?.trim() || "",
        year: cast.match(/\b(?:19|20)\d{2}\s*$/)?.[0]?.trim() || "",
        rate: el.querySelector(".rating_nums")?.textContent.trim() || "",
        votes:
          Number(
            (el.querySelector(".rating-info")?.textContent || "")
              .match(/([\d,]+)\s*人评价/)?.[1]
              ?.replace(/,/g, ""),
          ) || 0,
      });
    }
    return rows;
  }

  function pickDoubanRow(rows, title, year) {
    const want = normalizeTitle(title);
    const named = rows.filter(
      (row) =>
        normalizeTitle(row.original) === want ||
        normalizeTitle(row.title) === want,
    );
    if (!named.length) return null;

    if (year) {
      const target = Number(year);
      named.sort((a, b) => {
        const distA = a.year ? Math.abs(Number(a.year) - target) : 99;
        const distB = b.year ? Math.abs(Number(b.year) - target) : 99;
        return distA - distB || b.votes - a.votes;
      });
      if (named[0].year && Math.abs(Number(named[0].year) - target) > 2) {
        return null;
      }
    } else {
      named.sort((a, b) => b.votes - a.votes);
    }
    return named[0];
  }

  async function searchDoubanPage(title, year) {
    const text = await gmRequest(
      `https://www.douban.com/search?cat=1002&q=${encodeURIComponent(title)}`,
    );
    if (!text) return undefined;
    if (/异常请求|sec\.douban\.com/.test(text)) {
      console.warn("[影评聚合] 豆瓣搜索页被限流/验证拦截:", title);
      return undefined;
    }
    const hit = pickDoubanRow(parseDoubanSearch(text), title, year);
    if (!hit) return undefined;
    return {
      url: `https://movie.douban.com/subject/${hit.sid}/`,
      rating: {
        numRaters: hit.votes ? String(hit.votes) : "",
        max: 10,
        average: hit.rate || "",
      },
      title: hit.title || hit.original,
    };
  }

  async function searchDoubanSuggest(title, year) {
    const suggestions = await gmJson(
      `https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(title)}`,
    );
    if (!Array.isArray(suggestions) || !suggestions.length) return undefined;
    const want = normalizeTitle(title);
    const named = suggestions.filter(
      (s) =>
        normalizeTitle(s.title) === want || normalizeTitle(s.sub_title) === want,
    );
    if (!named.length) return undefined;
    const hit = (year && named.find((s) => s.year === year)) || named[0];
    if (!hit?.id) return undefined;

    return (
      (await getDoubanSubjectRating(hit.id)) || {
        url: `https://movie.douban.com/subject/${hit.id}/`,
        rating: { numRaters: "", max: 10, average: "" },
        title: hit.title || hit.sub_title,
      }
    );
  }

  async function resolveDoubanEntry(title, year) {
    const cacheKey = `douban:match:${normalizeTitle(title)}|${year || ""}`;
    const cached = getCached(cacheKey);
    if (cached) return cached.miss ? undefined : cached;

    const remember = (entry) => {
      setCache(
        cacheKey,
        entry || { miss: true },
        entry ? CACHE_TTL : NO_MATCH_TTL,
      );
      return entry;
    };

    const entry =
      (await searchDoubanPage(title, year)) ||
      (await searchDoubanSuggest(title, year));
    if (!entry) {
      console.warn("[影评聚合] 豆瓣未匹配到条目:", title, year || "");
      return remember();
    }
    console.log("[影评聚合] 豆瓣匹配:", entry.title, entry.url);
    return remember(entry);
  }

  async function getDoubanInfo() {
    const title = (qs("h1, [data-testid='hero__pageTitle']")?.textContent || "")
      .trim()
      .replace(/\s+/g, " ");
    if (!title) {
      console.warn("[影评聚合] 未能从页面取到片名");
      return undefined;
    }
    const year = getImdbYear();
    console.log("[影评聚合] 豆瓣搜索:", title, year || "");
    return resolveDoubanEntry(title, year);
  }

  async function getDoubanSubjectRating(dbId) {
    const abstract = await gmJson(
      `https://movie.douban.com/j/subject_abstract?subject_id=${dbId}`,
    );
    const subject = abstract?.subject;
    if (!subject) return undefined;

    return {
      url: `https://movie.douban.com/subject/${dbId}/`,
      rating: {
        numRaters: "",
        max: 10,
        average: subject.rate || "?",
      },
      title: subject.title || document.title,
    };
  }

  function insertDoubanRating(
    parent,
    title,
    rating,
    link,
    numRaters,
    histogram,
  ) {
    const numericRating = Number(rating);
    const star = (5 * Math.round(numericRating)).toString().padStart(2, "0");
    const displayRating = Number.isFinite(numericRating)
      ? numericRating.toFixed(1)
      : rating;
    const safeLink = safeUrl(link);
    let histogramHtml = "";

    if (histogram && numRaters) {
      const histogramValues = Object.values(histogram);
      const max = Math.max(...histogramValues, 0);

      histogramHtml =
        '<div class="ratings-on-weight mri-histogram">' +
        Array.from({ length: 10 }, (_, index) => 10 - index)
          .map((score) => {
            const count = Math.max(0, Number(histogram[score] || 0) || 0);
            const percent = numRaters
              ? ((count * 100) / numRaters).toFixed(1)
              : "0.0";
            const width = max ? (64 / max) * count : 0;
            return `<div class="item"><span class="stars${score} starstop">${score}</span><div class="power" style="--mri-bar:${width}px"></div><span class="rating_per">${percent}%</span></div>`;
          })
          .join("") +
        "</div>";
    }

    parent.insertAdjacentHTML(
      "beforeend",
      `
            <div class="rating_logo">${escapeHtml(title)}</div>
            <div class="rating_self clearfix">
                <strong class="ll rating_num">${escapeHtml(displayRating)}</strong>
                <div class="rating_right">
                    <div class="ll bigstar${star}"></div>
                    <div class="rating_sum">
                        <a href="${safeLink}" target="_blank" rel="noopener noreferrer">${escapeHtml(formatVoterCount(numRaters))}人评价</a>
                    </div>
                </div>
            </div>${histogramHtml}`,
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

  function linkify(node, base) {
    if (!node) return null;

    if (node.nodeName === "A") {
      return node.textContent.trim() || null;
    }

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

  function renderMetascore(container, data) {
    if (isNA(data.Metascore)) return;

    const metascore = parseInt(data.Metascore, 10);
    const color = metascore >= 60 ? "#6c3" : metascore >= 40 ? "#fc3" : "#f00";
    if (!data.Title) return;
    const metaUrl = safeUrl(
      `https://www.metacritic.com/movie/${buildMetacriticSlug(data.Title)}/`,
    );
    if (!metaUrl) return;

    container.insertAdjacentHTML(
      "beforeend",
      `<br>Metascore: <a class="mri-info-link" href="${metaUrl}" target="_blank" rel="noopener noreferrer"><span class="mri-metascore" style="--mri-metascore-color:${color}">${escapeHtml(String(metascore))}</span></a>`,
    );
  }

  function renderRottenTomatoes(container, data) {
    const rt = data.Ratings?.find((item) => item.Source === "Rotten Tomatoes");
    if (!rt?.Value) return;

    const fresh = parseInt(rt.Value, 10) >= 60;
    const tomatoUrl = safeUrl(
      (data.tomatoURL || "").replace("http://", "https://"),
    );

    container.insertAdjacentHTML(
      "beforeend",
      `<br><a class="mri-info-link" href="${tomatoUrl}" target="_blank" rel="noopener noreferrer">${buildTomatoIcon(fresh ? TOMATO_ICON_FRESH : TOMATO_ICON_ROTTEN)}<span>${escapeHtml(rt.Value)} 烂番茄新鲜度</span></a>`,
    );

    if (isNA(data.tomatoUserMeter)) return;

    const userPositive = parseFloat(data.tomatoUserRating) >= 3.5;
    container.insertAdjacentHTML(
      "beforeend",
      `<a class="mri-info-link" href="${tomatoUrl}" target="_blank" rel="noopener noreferrer">${buildTomatoIcon(userPositive ? TOMATO_USER_ICON_POSITIVE : TOMATO_USER_ICON_NEGATIVE)}<span>${escapeHtml(String(data.tomatoUserMeter))}% 观众爆米花</span></a>`,
    );
  }

  function collectSearchTitle() {
    const raw = (qs("[property='v:itemreviewed']")?.textContent || "").trim();
    let source = raw;
    if (!source) {
      const h1 = qs("h1");
      try {
        const clone = h1.cloneNode(true);
        clone.querySelectorAll(".year").forEach((node) => node.remove());
        source = (clone.textContent || "").trim();
      } catch {
        source = (h1?.textContent || "").trim();
      }
    }

    const stripYear = (text) =>
      (text || "")
        .replace(/^(又名|譯名|译名)\s*[:：]/, "")
        .replace(/\s*[(（]\s*\d{4}\s*[)）]\s*$/, "")
        .replace(/\s+\d{4}\s*$/, "")
        .replace(/\s+/g, " ")
        .trim();

    source = stripYear(source);

    const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
    const KANA = /[\u3040-\u30ff\u31f0-\u31ff]/;
    const HANGUL = /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7af]/;
    const CJK_PUNCT = /[\u3000-\u303e\uff01-\uff0f\uff1b-\uff65]/;

    const kindOf = (ch) => {
      if (HAN.test(ch)) return "han";
      if (KANA.test(ch)) return "kana";
      if (HANGUL.test(ch)) return "hangul";
      return "latin";
    };

    const segments = [];
    for (const ch of source) {
      let kind;
      if (CJK_PUNCT.test(ch) && segments.length) {
        kind = segments[segments.length - 1].kind;
      } else {
        kind = kindOf(ch);
      }
      const last = segments[segments.length - 1];
      if (last && last.kind === kind) last.text += ch;
      else segments.push({ kind, text: ch });
    }

    const segStart = [];
    let cursor = 0;
    for (const seg of segments) {
      segStart.push(cursor);
      cursor += seg.text.length;
    }
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      const prev = segments[i - 1];
      if (seg.kind !== "latin" || prev.kind !== "han") continue;
      const m = seg.text.match(/^(\d*\.\d+|\d+\.?)/);
      if (!m) continue;
      const digits = m[0];
      const afterIndex = segStart[i] + digits.length;
      if (/[A-Za-z]/.test(source[afterIndex] || "")) continue;
      prev.text += digits;
      seg.text = seg.text.slice(digits.length);
      segStart[i] = afterIndex;
    }

    for (const seg of segments) {
      if (seg.kind === "latin" && /^[\u2e80-\u2fff]+$/.test(seg.text)) {
        seg.kind = "han";
      }
    }

    const trimEdges = (text) =>
      text.replace(/^[\s:：,，.·\-—/|]+|[\s:：,，.·\-—/|]+$/g, "");

    const join = (kind, sep) =>
      trimEdges(
        segments
          .filter((s) => s.kind === kind && s.text)
          .map((s) => trimEdges(s.text))
          .filter(Boolean)
          .join(sep),
      );

    const latin = join("latin", " ");
    const hangul = join("hangul", " ");

    const eastAsian = trimEdges(
      segments
        .filter((s) => s.kind === "han" || s.kind === "kana")
        .map((s) => s.text)
        .join(""),
    );

    const hasKana = segments.some((s) => s.kind === "kana");
    const hasHangul = segments.some((s) => s.kind === "hangul");

    if (latin) return latin;

    if (hasHangul) {
      return hangul || eastAsian || source;
    }

    return eastAsian || source;
  }

  function buildSearchQuery(title, year) {
    const name = String(title || "").trim();
    if (!name) return "";
    const y = String(year || "").trim();
    return y ? `${name} ${y}` : name;
  }

  function getSubjectYear() {
    const toYear = (text) => String(text || "").match(/\b(18|19|20)\d{2}\b/)?.[0] || "";

    const fromYearSpan = toYear(qs("h1 .year")?.textContent);
    if (fromYearSpan) return fromYearSpan;

    const infoLabels = qsa("#info > span.pl");
    for (const node of infoLabels) {
      if (/上映(日期|时间)|首播/.test(node.innerText.trim())) {
        const year = toYear(node.nextSibling?.textContent);
        if (year) return year;
      }
    }

    const fromH1 = toYear((qs("h1")?.textContent || "").match(/[(（]\s*((?:18|19|20)\d{2})\s*[)）]/)?.[1]);
    if (fromH1) return fromH1;

    const fromTitle = toYear(document.title.match(/[(（]\s*((?:18|19|20)\d{2})\s*[)）]/)?.[1]);
    if (fromTitle) return fromTitle;

    const infoText = document.querySelector("#info")?.textContent || "";
    return toYear(infoText);
  }

  function renderSearchSection(container, title, year) {
    if (document.getElementById(SEARCH_BUTTON_ID)) return;

    const query = buildSearchQuery(title, year);
    if (!query) {
      console.warn("[影评聚合] 未能取到片名，跳过资源搜索入口");
      return;
    }

    const links = SEARCH_SITES.map((site) => {
      let href = "";
      try {
        href = safeUrl(site.buildUrl(title, year));
      } catch (error) {
        console.error(`[影评聚合] 构造 ${site.label} 搜索地址失败:`, error);
      }
      return href ? { site, href } : null;
    }).filter(Boolean);
    if (!links.length) return;

    const section = document.createElement("div");
    section.id = SEARCH_BUTTON_ID;

    const label = year ? `${title} (${year})` : title;
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
          `title="在 ${escapeHtml(site.label)} 搜索「${escapeHtml(label)}」的资源（新标签页打开）">` +
          `${icon(site.icon)}去 ${escapeHtml(site.label)} 搜索` +
          "</a>",
      )
      .join("");

    container.appendChild(section);
  }

  function ensureRecoveredDoubanRating(dbId) {
    const subjectWrap = qs(".subjectwrap");
    const subject = qs(".subject");
    if (!subjectWrap || !subject) return null;

    const section = document.createElement("div");
    section.id = "interest_sectl";
    subjectWrap.insertBefore(section, subject.nextSibling);

    const wrap = document.createElement("div");
    wrap.className = "rating_wrap";
    section.appendChild(wrap);

    getDoubanSubjectRating(dbId).then((data) => {
      if (data?.rating && !isNA(data.rating.average)) {
        insertDoubanRating(
          wrap,
          "豆瓣评分",
          data.rating.average,
          `https://movie.douban.com/subject/${dbId}/collections`,
          data.rating.numRaters,
        );
      }
      wrap.title = DOUBAN_RECOVERED_TITLE;
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
      section = ensureRecoveredDoubanRating(dbId);
      if (!section) return;
    }

    if (document.getElementById("movie-rating-integrator-extra")) return;

    const imdbLabel = qsa("#info > span.pl").find(
      (node) => node.innerText.trim() === "IMDb:",
    );
    const imdbNode = imdbLabel?.nextSibling;
    const imdbId = imdbNode
      ? linkify(imdbNode, "https://www.imdb.com/title/")
      : null;

    const data = imdbId ? await getIMDbInfo(imdbId) : null;
    const hasRottenTomatoes = Boolean(
      data?.Ratings?.find((item) => item.Source === "Rotten Tomatoes")?.Value,
    );
    const hasExtraInfo = !isNA(data?.Rated) || !isNA(data?.BoxOffice);
    const hasRatings =
      Boolean(data) &&
      (!isNA(data.imdbRating) ||
        !isNA(data.Metascore) ||
        hasRottenTomatoes ||
        hasExtraInfo);
    const shouldRender = hasRatings || Boolean(collectSearchTitle());
    if (!shouldRender) return;

    const ratings = document.createElement("div");
    ratings.id = "movie-rating-integrator-extra";
    ratings.className = "rating_wrap clearbox mri-ratings";

    const ratingWrap = qs(".friends_rating_wrap") || qs(".rating_wrap");
    section.insertBefore(ratings, ratingWrap?.nextSibling || null);
    section.style.marginBottom = qs(".colbutt") ? "-136px" : "-154px";

    const recommendation = qs(".rec-sec, #interest_sect_level");
    if (recommendation) {
      recommendation.style.width = "488px";
    }

    if (hasRatings) {
      if (!isNA(data.imdbRating)) {
        insertDoubanRating(
          ratings,
          "IMDb评分",
          data.imdbRating,
          `https://www.imdb.com/title/${imdbId}/ratings`,
          data.imdbVotes,
          data.histogram,
        );

        if (!isNA(data.topRank) && data.topRank <= 250 && !qs(".mri-top250")) {
          (
            document.getElementById("dale_movie_subject_top_icon") || qs("h1")
          )?.insertAdjacentHTML(
            "beforebegin",
            `<div class="mri-top250"><span class="mri-top250-no">No.${data.topRank}</span><span class="mri-top250-link"><a href="https://www.imdb.com/chart/top">IMDb Top 250</a></span></div>`,
          );
        }
      }

      renderMetascore(ratings, data);
      renderRottenTomatoes(ratings, data);
    }

    renderSearchSection(ratings, collectSearchTitle(), getSubjectYear());

    if (hasRatings) {
      if (!isNA(data.Rated)) insertDoubanInfo("MPAA评级", data.Rated);
      if (!isNA(data.BoxOffice)) insertDoubanInfo("票房", data.BoxOffice);
    }
  }

  function handleDoubanPersonPage() {
    const node = qsa("span.value").find((item) =>
      /^nm\d+/.test(item.innerText.trim()),
    );
    if (node) {
      linkify(node, "https://www.imdb.com/name/");
    }
  }

  function buildDoubanBadge(data, ratingStr) {
    const badge = document.createElement("a");
    badge.id = "movie-rating-integrator-douban";
    badge.href = safeUrl(data.url);
    badge.target = "_blank";
    badge.rel = "noopener noreferrer";
    badge.title = `豆瓣：${data.title}${ratingStr ? `（${ratingStr}）` : "（暂无评分）"}`;
    badge.setAttribute(
      "aria-label",
      `豆瓣评分：${data.title} ${ratingStr ? `${ratingStr} / 10` : "暂无评分"}`,
    );
    const scoreHtml = ratingStr
      ? '<span class="mri-mark">豆</span>' +
        `<span class="mri-score">${escapeHtml(ratingStr)}</span>` +
        '<span class="mri-score-total">/10</span>'
      : `<span class="mri-title">${escapeHtml(data.title)}</span>` +
        '<span class="mri-pending">暂无评分</span>';
    badge.innerHTML =
      '<span class="mri-badge-label">豆瓣评分</span>' +
      `<span class="mri-badge-row">${scoreHtml}</span>`;
    return badge;
  }

  async function handleImdbPage() {
    const id = location.href.match(/tt\d+/)?.[0];
    if (!id) return;

    await waitForAny(['[data-testid="hero__pageTitle"]', "h1"], 10000);

    const selectors = [
      '[data-testid="hero-rating-bar__aggregate-rating"]',
      '[data-testid="aggregateRating"]',
      '[data-testid="titleRatingAndRatingCount"]',
      ".rating-bar__base-button",
      '[class*="AggregateRating"]',
    ];

    const findAnchor = () => {
      const hit = selectors.map((s) => qs(s)).find(Boolean);
      if (hit) return hit;
      const root =
        qs('[data-testid="hero"]') ||
        qs('[data-testid="title-hero"]') ||
        document.body;
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) =>
            node.textContent && node.textContent.length < 64
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_REJECT,
        },
      );
      let scanned = 0;
      let node;
      while ((node = walker.nextNode())) {
        if (/^\s*\d\.\d\s*\/\s*10\s*$/.test(node.textContent)) {
          return node.parentElement?.closest("div,span");
        }
        if (++scanned >= 200) break;
      }
      return null;
    };

    const bar = await waitForAny(selectors, 12000);

    const data = await getDoubanInfo();
    if (!data) {
      console.warn("[影评聚合] 未找到豆瓣条目，跳过插入");
      return;
    }
    if (document.getElementById("movie-rating-integrator-douban")) return;

    const anchor = bar || findAnchor();
    if (!anchor) {
      console.warn(
        "[影评聚合] 未找到 IMDb 评分块。当前页面 rating 相关 testid：",
        [...document.querySelectorAll("[data-testid]")]
          .map((e) => e.getAttribute("data-testid"))
          .filter((t) => /rating/i.test(t)),
      );
      return;
    }

    const rating = Number(data.rating?.average);
    const ratingStr =
      data.rating?.average && Number.isFinite(rating) ? rating.toFixed(1) : "";

    const badge = buildDoubanBadge(data, ratingStr);
    (anchor.parentElement || anchor).appendChild(badge);
    console.log("[影评聚合] 已插入豆瓣评分:", ratingStr || "暂无评分", data.url);

    try {
      let retries = 0;
      const maxRetries = 6;
      let pending = false;
      const observer = new MutationObserver(() => {
        if (pending) return;
        pending = true;
        scheduleIdle(() => {
          pending = false;
          if (document.getElementById("movie-rating-integrator-douban"))
            return;
          const newAnchor = findAnchor();
          if (!newAnchor) return;
          if (retries++ >= maxRetries) {
            finishObserver(observer);
            return;
          }
          const newBadge = buildDoubanBadge(data, ratingStr);
          (newAnchor.parentElement || newAnchor).appendChild(newBadge);
          console.log(
            "[影评聚合] 重新插入豆瓣评分 (retry):",
            ratingStr || "暂无评分",
            data.url,
          );
        });
      });
      activeObservers.push(observer);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });

      setTimeout(() => {
        finishObserver(observer);
      }, 30000);
    } catch (e) {
      console.warn("[影评聚合] 无法创建重试 observer:", e);
    }
  }

  window.addEventListener("beforeunload", () => {
    while (activeObservers.length) {
      finishObserver(activeObservers[activeObservers.length - 1]);
    }
  });

  function init() {
    ensureStyles();
    if (host === "movie.douban.com") {
      handleDoubanMoviePage();
    } else if (host === "www.douban.com") {
      handleDoubanPersonPage();
    } else if (host === "www.imdb.com" || host === "imdb.com") {
      handleImdbPage();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
