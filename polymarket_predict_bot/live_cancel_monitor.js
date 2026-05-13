/**
 * Polymarket LIVE 事件监控 → Predict.fun 自动撤单
 * =================================================
 *
 * 核心发现:
 *   Predict.fun 和 Polymarket 的体育赛事 slug 相同！
 *   例如: lal-get-mal-2026-05-13 = Getafe vs Mallorca 5月13日
 *   直接用 slug 查 Polymarket: /events?slug=xxx
 *
 * 流程:
 *   1. 获取 Predict.fun 上你有挂单的市场（从 categories API 拿 slug）
 *   2. 用 slug 直接查 Polymarket Gamma API
 *   3. 检测该市场是否 LIVE（acceptingOrders=false / gameStartTime已过）
 *   4. LIVE → 撤掉 Predict.fun 对应挂单
 *
 * 使用:
 *   node live_cancel_monitor.js          # 正式运行
 *   node live_cancel_monitor.js test     # 测试（不撤单）
 */

// ============ 配置 ============
const CONFIG = {
  // Polymarket Gamma API (公开，无需 key)
  POLYMARKET_GAMMA_URL: "https://gamma-api.polymarket.com",

  // Predict.fun
  API_URL: "https://api.predict.fun",
  API_KEY: "5f623dc1-147a-4767-8795-cf02f1f25149",
  JWT_TOKEN: "YOUR_JWT_TOKEN_HERE",

  // 轮询间隔（毫秒）
  POLL_INTERVAL: 10000,

  // Telegram 通知
  TELEGRAM_BOT_TOKEN: "8739215233:AAHwG7G60sgOYze9Jo0u-KddtP0UBxDjnKg",
  TELEGRAM_CHAT_ID: "5707621530",
};

// 已经处理过的 LIVE 事件 (避免重复撤单)
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

// ============ Polymarket 查询 ============

/**
 * 用 slug 直接查 Polymarket 事件
 * 例如: slug = "lal-get-mal-2026-05-13"
 */
async function getPolymarketEventBySlug(slug) {
  const url = `${CONFIG.POLYMARKET_GAMMA_URL}/events?slug=${encodeURIComponent(slug)}`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return null;
    const events = await resp.json();
    if (events.length > 0) return events[0];
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * 判断 Polymarket 事件是否 LIVE
 */
function isPolymarketLive(event) {
  if (!event) return false;

  // 检查事件下的所有 markets
  const markets = event.markets || [];
  for (const m of markets) {
    // 不再接单 = 比赛开始了
    if (m.acceptingOrders === false && m.active === true) return true;

    // 已关闭 = 比赛结束了
    if (m.closed === true) return true;

    // gameStartTime 已过
    const gameStart = m.gameStartTime;
    if (gameStart) {
      try {
        const startDt = new Date(gameStart);
        const now = new Date();
        if (now > startDt) return true;
      } catch {
        // ignore
      }
    }
  }

  // 也检查事件级别
  if (event.closed === true) return true;

  return false;
}

/**
 * 获取 Polymarket 事件的 gameStartTime
 */
function getGameStartTime(event) {
  if (!event) return null;
  const markets = event.markets || [];
  for (const m of markets) {
    if (m.gameStartTime) return m.gameStartTime;
  }
  return null;
}

// ============ Predict.fun 操作 ============

/**
 * 获取 Predict.fun 上有挂单的市场（通过 orders API）
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
 * 获取 Predict.fun 上的活跃 categories（含 slug）
 */
async function getPredictCategories() {
  try {
    // 获取体育比赛 categories
    const variants = ["SPORTS_MATCH", "SPORTS_TEAM_MATCH"];
    let allCategories = [];

    for (const variant of variants) {
      try {
        const data = await fetchPredictAPI(`/v1/categories?first=100&marketVariant=${variant}`);
        const batch = data.data || [];
        allCategories = allCategories.concat(batch);
      } catch {
        // ignore
      }
    }

    return allCategories;
  } catch (e) {
    console.error("[Predict] 获取 categories 失败:", e.message);
    return [];
  }
}

/**
 * 撤销指定 category 下所有市场的挂单
 */
async function cancelOrdersForCategory(categorySlug, orders) {
  // 找出属于这个 category 的挂单
  const matchedOrders = orders.filter((o) => {
    const slug = o.categorySlug || o.category?.slug || o.marketSlug || "";
    return slug === categorySlug || slug.includes(categorySlug);
  });

  if (matchedOrders.length === 0) {
    // 如果无法通过 slug 过滤，尝试通过 marketId
    return 0;
  }

  let success = 0;
  for (const order of matchedOrders) {
    const orderId = order.orderId || order.id;
    if (!orderId) continue;
    try {
      await fetchPredictAPI(`/v1/orders/${orderId}`, { method: "DELETE" });
      success++;
    } catch (e) {
      console.error(`  撤单失败 (${orderId}):`, e.message);
    }
  }
  return success;
}

/**
 * 撤销所有活跃挂单（当无法精确匹配时的备用方案）
 */
async function cancelAllOpenOrders() {
  const orders = await getPredictOpenOrders();
  let success = 0;
  for (const order of orders) {
    const orderId = order.orderId || order.id;
    if (!orderId) continue;
    try {
      await fetchPredictAPI(`/v1/orders/${orderId}`, { method: "DELETE" });
      success++;
    } catch (e) {
      // ignore
    }
  }
  return success;
}

// ============ 主监控逻辑 ============

async function checkAndCancel() {
  // 1. 获取 Predict.fun 的体育 categories（含 slug）
  const categories = await getPredictCategories();
  if (categories.length === 0) return;

  // 2. 获取当前挂单
  const orders = await getPredictOpenOrders();
  if (orders.length === 0) return;

  console.log(`[${new Date().toLocaleTimeString()}] 检查 ${categories.length} 个比赛, 当前 ${orders.length} 笔挂单`);

  // 3. 逐个 category，用 slug 查 Polymarket
  for (const cat of categories) {
    const slug = cat.categorySlug || cat.slug || "";
    if (!slug) continue;
    if (processedLive.has(slug)) continue;

    // 用 slug 查 Polymarket
    const polyEvent = await getPolymarketEventBySlug(slug);
    if (!polyEvent) continue; // Polymarket 没有对应事件

    // 检查是否 LIVE
    if (isPolymarketLive(polyEvent)) {
      const title = polyEvent.title || cat.title || slug;
      const gameStart = getGameStartTime(polyEvent);

      console.log(`  🚨 LIVE! ${title} (slug: ${slug})`);
      if (gameStart) console.log(`     开赛时间: ${gameStart}`);

      // 撤单: 先尝试精确撤，失败则全撤该 category 的
      let cancelled = await cancelOrdersForCategory(slug, orders);

      // 如果精确匹配撤不到，尝试通过 marketId 撤
      if (cancelled === 0) {
        const catMarkets = cat.markets || [];
        for (const m of catMarkets) {
          const mid = m.id || m.marketId;
          if (!mid) continue;
          try {
            const params = new URLSearchParams({ status: "OPEN", marketId: mid, first: "100" });
            const data = await fetchPredictAPI(`/v1/orders?${params}`);
            const marketOrders = data.data || [];
            for (const o of marketOrders) {
              const oid = o.orderId || o.id;
              if (!oid) continue;
              try {
                await fetchPredictAPI(`/v1/orders/${oid}`, { method: "DELETE" });
                cancelled++;
              } catch { /* ignore */ }
            }
          } catch { /* ignore */ }
        }
      }

      if (cancelled > 0) {
        console.log(`  ✅ 已撤 ${cancelled} 笔挂单`);
        await sendTelegram(
          `🚨 <b>LIVE 自动撤单!</b>\n\n` +
          `📊 比赛: ${title}\n` +
          `🔗 Poly slug: ${slug}\n` +
          `⏰ 开赛: ${gameStart || "已开始"}\n` +
          `❌ 已撤 ${cancelled} 笔挂单`
        );
      }

      processedLive.add(slug);
    }

    // 控制 API 速度
    await sleep(300);
  }
}

// ============ 主循环 ============

async function runMonitor() {
  console.log("=".repeat(60));
  console.log("Polymarket LIVE 监控 → Predict.fun 自动撤单 (slug精确匹配)");
  console.log("=".repeat(60));
  console.log(`Polymarket API: ${CONFIG.POLYMARKET_GAMMA_URL}`);
  console.log(`Predict.fun API: ${CONFIG.API_URL}`);
  console.log(`轮询间隔: ${CONFIG.POLL_INTERVAL / 1000} 秒`);
  console.log(`匹配方式: slug 精确对应 (不再用模糊匹配)`);
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
  console.log("测试模式 - slug 精确匹配 (不撤单)");
  console.log("=".repeat(60));
  console.log("");

  // 获取 Predict.fun categories
  const categories = await getPredictCategories();
  console.log(`Predict.fun 体育比赛数: ${categories.length}`);

  if (categories.length === 0) {
    console.error("无法获取 Predict.fun 比赛数据!");
    return;
  }

  // 逐个查 Polymarket
  console.log("\n" + "=".repeat(60));
  console.log("slug 对应查询 (Predict → Polymarket):");
  console.log("=".repeat(60));

  let matchCount = 0;
  let liveCount = 0;
  const maxCheck = Math.min(categories.length, 20); // 测试最多检查20个

  for (let i = 0; i < maxCheck; i++) {
    const cat = categories[i];
    const slug = cat.categorySlug || cat.slug || "";
    const title = cat.title || slug;
    if (!slug) continue;

    const polyEvent = await getPolymarketEventBySlug(slug);

    if (polyEvent) {
      matchCount++;
      const isLive = isPolymarketLive(polyEvent);
      const gameStart = getGameStartTime(polyEvent);
      const icon = isLive ? "🔴LIVE" : "⚪";
      if (isLive) liveCount++;

      console.log(`\n  ${icon} ${title}`);
      console.log(`       slug: ${slug}`);
      console.log(`       Poly: ${polyEvent.title}`);
      if (gameStart) console.log(`       开赛: ${gameStart}`);
      console.log(`       acceptingOrders: ${polyEvent.markets?.[0]?.acceptingOrders}`);
    } else {
      console.log(`\n  ❌ ${title}`);
      console.log(`       slug: ${slug} → Polymarket 未找到`);
    }

    await sleep(300);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`检查: ${maxCheck} | 匹配: ${matchCount} | LIVE: ${liveCount}`);
  console.log("=".repeat(60));
}

// ============ 入口 ============

process.on("SIGINT", () => { running = false; console.log("\n退出..."); });
process.on("SIGTERM", () => { running = false; });

const mode = process.argv[2];
if (mode === "test") {
  testMatching().catch((e) => { console.error("异常:", e); process.exit(1); });
} else {
  runMonitor().catch((e) => { console.error("异常:", e); process.exit(1); });
}
