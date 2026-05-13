/**
 * Polymarket LIVE 事件监控 → Predict.fun 自动撤单
 * =================================================
 *
 * 功能:
 *   1. 轮询 Polymarket Gamma API，获取体育比赛市场
 *   2. 检测哪些市场已经变为 LIVE（比赛开始）
 *   3. 通过名称模糊匹配，找到 Predict.fun 上对应的挂单
 *   4. 如果 Polymarket 上比赛已 LIVE → 撤掉 Predict.fun 对应挂单
 *
 * LIVE 判断逻辑:
 *   - acceptingOrders == false（市场停止接单）
 *   - gameStartTime 已过（当前时间 > 比赛开始时间）
 *   - closed == true 且 closedTime 在近期（市场已关闭/结算）
 *
 * 名称匹配逻辑:
 *   - 提取关键词（队名、选手名、数字等）
 *   - 计算相似度分数
 *   - 超过阈值就认为是同一个事件
 *
 * 使用:
 *   node live_cancel_monitor.js          # 正式运行
 *   node live_cancel_monitor.js test     # 测试匹配（不撤单）
 */

// ============ 配置 ============
const CONFIG = {
  // Polymarket Gamma API (公开，无需 key)
  POLYMARKET_GAMMA_URL: "https://gamma-api.polymarket.com",
  POLY_FETCH_LIMIT: 100,

  // Predict.fun
  API_URL: "https://api.predict.fun",
  API_KEY: "5f623dc1-147a-4767-8795-cf02f1f25149",
  JWT_TOKEN: "YOUR_JWT_TOKEN_HERE",

  // 匹配阈值 (0-1, 越高越严格)
  MATCH_THRESHOLD: 0.45,

  // 轮询间隔（毫秒）
  POLL_INTERVAL: 10000,

  // Telegram 通知
  TELEGRAM_BOT_TOKEN: "8739215233:AAHwG7G60sgOYze9Jo0u-KddtP0UBxDjnKg",
  TELEGRAM_CHAT_ID: "5707621530",
};

// 已经处理过的 LIVE 市场 (避免重复撤单)
const processedLive = new Set();

let running = true;

// ============ 工具函数 ============

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendTelegram(message) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN) return;
  try {
    const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CONFIG.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
      }),
    });
  } catch (e) {
    console.error("[TG] 发送失败:", e.message);
  }
}

async function fetchPredictAPI(path, options = {}) {
  const url = `${CONFIG.API_URL}${path}`;
  const headers = {
    "Content-Type": "application/json",
    "x-api-key": CONFIG.API_KEY,
    Authorization: `Bearer ${CONFIG.JWT_TOKEN}`,
    ...options.headers,
  };
  const resp = await fetch(url, { ...options, headers });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Predict API ${resp.status}: ${text}`);
  }
  return resp.json();
}

// ============ 名称匹配工具 ============

/**
 * 标准化文本: 转小写, 去特殊字符, 统一空格
 */
function normalizeText(text) {
  if (!text) return "";
  let t = text.toLowerCase();
  // 去掉常见前缀 "NBA:", "NFL:" 等
  t = t.replace(
    /^(nba|nfl|mlb|nhl|mls|ufc|f1|epl|la liga|serie a|bundesliga)\s*[:：]\s*/,
    ""
  );
  // 去掉连接词
  t = t.replace(
    /\b(will|the|a|an|in|on|at|by|to|of|their|this|that|does|do|is|are|beat|win|over|more|than|less|vs|versus)\b/g,
    " "
  );
  // 去掉括号内容
  t = t.replace(/[\(\[\{].*?[\)\]\}]/g, " ");
  // 只保留字母数字和空格
  t = t.replace(/[^a-z0-9\s]/g, " ");
  // 合并空格
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/**
 * 提取关键词集合（≥3个字符的词）
 */
function extractKeywords(text) {
  const normalized = normalizeText(text);
  const words = normalized.split(" ");
  return new Set(words.filter((w) => w.length >= 3));
}

/**
 * 计算两个文本的相似度 (0-1)
 * 结合: SequenceMatcher 式整体相似度 + 关键词重叠率
 */
function calculateSimilarity(text1, text2) {
  const norm1 = normalizeText(text1);
  const norm2 = normalizeText(text2);
  if (!norm1 || !norm2) return 0;

  // 方法1: LCS-based ratio (类似 Python SequenceMatcher)
  const seqRatio = lcsRatio(norm1, norm2);

  // 方法2: 关键词重叠
  const kw1 = extractKeywords(text1);
  const kw2 = extractKeywords(text2);
  if (kw1.size === 0 || kw2.size === 0) return seqRatio;

  let overlap = 0;
  for (const w of kw1) {
    if (kw2.has(w)) overlap++;
  }
  const keywordRatio = overlap / Math.min(kw1.size, kw2.size);

  // 加权: 关键词匹配更重要 (60%), 整体相似度 (40%)
  return 0.4 * seqRatio + 0.6 * keywordRatio;
}

/**
 * LCS ratio: 2 * LCS长度 / (len1 + len2)
 */
function lcsRatio(a, b) {
  if (!a || !b) return 0;
  const m = a.length;
  const n = b.length;

  // 使用空间优化的LCS
  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1]);
      }
    }
    [prev, curr] = [curr, new Array(n + 1).fill(0)];
  }

  const lcsLen = prev[n];
  return (2 * lcsLen) / (m + n);
}

/**
 * 在 Predict.fun 市场列表中找最佳匹配
 * 返回: { market, score } 或 null
 */
function findMatchingPredictMarket(polyTitle, predictMarkets) {
  let bestMatch = null;
  let bestScore = 0;

  for (const market of predictMarkets) {
    const predictName =
      market.title || market.question || market.name || "";
    const score = calculateSimilarity(polyTitle, predictName);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = market;
    }
  }

  if (bestScore >= CONFIG.MATCH_THRESHOLD) {
    return { market: bestMatch, score: bestScore };
  }
  return null;
}

// ============ Polymarket LIVE 检测 ============

/**
 * 从 Polymarket Gamma API 获取活跃市场
 */
async function fetchPolymarketMarkets() {
  const url = `${CONFIG.POLYMARKET_GAMMA_URL}/markets?active=true&limit=${CONFIG.POLY_FETCH_LIMIT}`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const markets = await resp.json();
    return markets;
  } catch (e) {
    console.error("[Polymarket] 获取市场失败:", e.message);
    return [];
  }
}

/**
 * 判断 Polymarket 市场是否已经 LIVE (比赛已开始)
 */
function isPolymarketLive(market) {
  // 已关闭 = 比赛结束了
  if (market.closed === true) return true;

  // 不再接单 = 比赛开始了
  if (market.acceptingOrders === false && market.active === true) return true;

  // 检查 gameStartTime
  const gameStart = market.gameStartTime;
  if (gameStart) {
    try {
      const startDt = new Date(gameStart);
      const now = new Date();
      if (now > startDt) return true;
    } catch {
      // ignore
    }
  }

  return false;
}

// ============ Predict.fun 订单管理 ============

/**
 * 获取 Predict.fun 活跃市场列表（用于名称匹配）
 */
async function getPredictMarkets() {
  try {
    const params = new URLSearchParams({
      status: "OPEN",
      first: "100",
      hasActiveRewards: "true",
    });
    const data = await fetchPredictAPI(`/v1/markets?${params}`);
    return data.data || [];
  } catch (e) {
    console.error("[Predict] 获取市场失败:", e.message);
    return [];
  }
}

/**
 * 获取 Predict.fun 上所有活跃挂单
 */
async function getPredictOpenOrders() {
  try {
    const params = new URLSearchParams({ status: "OPEN", first: "200" });
    const data = await fetchPredictAPI(`/v1/orders?${params}`);
    return data.data || [];
  } catch (e) {
    console.error("[Predict] 获取挂单失败:", e.message);
    return [];
  }
}

/**
 * 撤销指定市场的所有挂单
 */
async function cancelOrdersForMarket(marketId) {
  // 先获取该市场的挂单
  let orders;
  try {
    const params = new URLSearchParams({
      status: "OPEN",
      marketId: marketId,
      first: "100",
    });
    const data = await fetchPredictAPI(`/v1/orders?${params}`);
    orders = data.data || [];
  } catch (e) {
    console.error(`[Predict] 获取市场 ${marketId} 挂单失败:`, e.message);
    return 0;
  }

  if (orders.length === 0) {
    console.log(`[Predict] 市场 ${marketId} 没有挂单`);
    return 0;
  }

  // 逐个撤单
  let success = 0;
  for (const order of orders) {
    const orderId = order.orderId || order.id || (order.order && order.order.orderId);
    if (!orderId) continue;

    try {
      await fetchPredictAPI(`/v1/orders/${orderId}`, { method: "DELETE" });
      success++;
    } catch (e) {
      console.error(`  撤单失败 (${orderId}):`, e.message);
    }
  }

  console.log(`[Predict] 撤销市场 ${marketId} 的 ${success}/${orders.length} 笔挂单`);
  return success;
}

// ============ 主监控逻辑 ============

/**
 * 单次检查:
 * 1. 获取 Polymarket 市场，找 LIVE 的
 * 2. 获取 Predict.fun 市场列表
 * 3. 名称匹配
 * 4. 匹配到且 LIVE → 撤单
 */
async function checkAndCancel() {
  // 1. 获取 Polymarket 市场
  const polyMarkets = await fetchPolymarketMarkets();
  if (polyMarkets.length === 0) return;

  // 2. 筛选新的 LIVE 市场
  const liveMarkets = [];
  for (const m of polyMarkets) {
    const marketId = m.id || "";
    if (processedLive.has(marketId)) continue;
    if (isPolymarketLive(m)) {
      liveMarkets.push(m);
    }
  }

  if (liveMarkets.length === 0) return;

  console.log(`\n检测到 ${liveMarkets.length} 个新 LIVE 市场`);

  // 3. 获取 Predict.fun 市场
  const predictMarkets = await getPredictMarkets();
  if (predictMarkets.length === 0) {
    console.warn("[Predict] 没有获取到市场数据，跳过");
    return;
  }

  // 4. 逐个匹配
  let cancelledTotal = 0;

  for (const polyM of liveMarkets) {
    const polyQuestion = polyM.question || polyM.title || "";
    const polyId = polyM.id || "";

    const match = findMatchingPredictMarket(polyQuestion, predictMarkets);

    if (match) {
      const { market: matched, score } = match;
      const matchedName =
        matched.title || matched.question || matched.name || "Unknown";
      const matchedId = matched.id || matched.marketId;

      console.log(
        `  🚨 LIVE匹配! Poly: [${polyQuestion.slice(0, 50)}...] ↔ Pred: [${matchedName.slice(0, 50)}...] (${(score * 100).toFixed(0)}%)`
      );

      // 撤单
      if (matchedId) {
        const n = await cancelOrdersForMarket(matchedId);
        cancelledTotal += n;

        // Telegram 通知
        await sendTelegram(
          `🚨 <b>LIVE 自动撤单!</b>\n\n` +
            `📊 Polymarket: ${polyQuestion.slice(0, 60)}\n` +
            `🎯 Predict.fun: ${matchedName.slice(0, 60)}\n` +
            `📏 匹配度: ${(score * 100).toFixed(0)}%\n` +
            `❌ 已撤 ${n} 笔挂单`
        );
      }

      processedLive.add(polyId);
    } else {
      // 没匹配到也标记（避免重复检查）
      processedLive.add(polyId);
    }
  }

  if (cancelledTotal > 0) {
    console.log(`本轮共撤销 ${cancelledTotal} 笔挂单\n`);
  }
}

// ============ 主循环 ============

async function runMonitor() {
  console.log("=".repeat(60));
  console.log("Polymarket LIVE 监控 → Predict.fun 自动撤单");
  console.log("=".repeat(60));
  console.log(`Polymarket API: ${CONFIG.POLYMARKET_GAMMA_URL}`);
  console.log(`Predict.fun API: ${CONFIG.API_URL}`);
  console.log(`匹配阈值: ${(CONFIG.MATCH_THRESHOLD * 100).toFixed(0)}%`);
  console.log(`轮询间隔: ${CONFIG.POLL_INTERVAL / 1000} 秒`);
  console.log("=".repeat(60));
  console.log("");

  while (running) {
    try {
      await checkAndCancel();
    } catch (e) {
      console.error("监控异常:", e.message);
    }
    await sleep(CONFIG.POLL_INTERVAL);
  }

  console.log("监控已停止.");
}

// ============ 测试模式 ============

async function testMatching() {
  console.log("=".repeat(60));
  console.log("测试模式 - 展示匹配结果 (不撤单)");
  console.log("=".repeat(60));
  console.log("");

  // 获取 Polymarket 市场
  const polyMarkets = await fetchPolymarketMarkets();
  console.log(`Polymarket 市场数: ${polyMarkets.length}`);

  // 获取 Predict.fun 市场
  const predictMarkets = await getPredictMarkets();
  console.log(`Predict.fun 市场数: ${predictMarkets.length}`);

  if (polyMarkets.length === 0 || predictMarkets.length === 0) {
    console.error("无法获取市场数据!");
    return;
  }

  // 展示 LIVE 市场
  console.log("\n" + "=".repeat(60));
  console.log("Polymarket LIVE 市场:");
  console.log("=".repeat(60));
  let liveCount = 0;
  for (const m of polyMarkets) {
    if (isPolymarketLive(m)) {
      liveCount++;
      const q = m.question || "N/A";
      console.log(`  🔴 ${q.slice(0, 80)}`);
      if (liveCount >= 20) {
        console.log("  ... 还有更多");
        break;
      }
    }
  }
  console.log(`\n总 LIVE 数: ${liveCount}`);

  // 展示匹配结果
  console.log("\n" + "=".repeat(60));
  console.log("匹配测试 (Polymarket ↔ Predict.fun):");
  console.log("=".repeat(60));

  let matchCount = 0;
  for (const m of polyMarkets.slice(0, 30)) {
    const q = m.question || "";
    const result = findMatchingPredictMarket(q, predictMarkets);
    if (result) {
      matchCount++;
      const matchedName =
        result.market.title || result.market.question || "?";
      const isLive = isPolymarketLive(m) ? "🔴LIVE" : "⚪";
      console.log(`\n  ${isLive} Poly: ${q.slice(0, 60)}`);
      console.log(`       Pred: ${matchedName.slice(0, 60)}`);
      console.log(`       分数: ${result.score.toFixed(3)}`);
    }
  }
  console.log(`\n匹配到 ${matchCount} 个`);
}

// ============ 入口 ============

// 退出信号
process.on("SIGINT", () => {
  running = false;
  console.log("\n收到退出信号...");
});
process.on("SIGTERM", () => {
  running = false;
});

const mode = process.argv[2];
if (mode === "test") {
  testMatching().catch((e) => {
    console.error("测试异常:", e);
    process.exit(1);
  });
} else {
  runMonitor().catch((e) => {
    console.error("程序异常:", e);
    process.exit(1);
  });
}
