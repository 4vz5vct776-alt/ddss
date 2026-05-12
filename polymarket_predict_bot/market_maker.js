/**
 * 做市 Bot v2 - 体育/电竞/FDV专版 (Predict.fun)
 * 
 * 功能:
 *   - 获取足球(今天+明天+世界杯不限日期)、电竞CS/LOL(今天)、加密FDV(不限日期)
 *   - 每个市场以买1价格挂单 (严格spread检查, 不会被吃)
 *   - 异动检测: 买1大幅撤单 → 立刻撤单
 *   - 成交/被吃 → Telegram 通知
 * 
 * 使用:
 *   node market_maker.js
 */

import { Wallet } from "ethers";
import { OrderBuilder, ChainId, Side } from "@predictdotfun/sdk";

// ============ 配置 ============
const CONFIG = {
  // 你的钱包私钥
  PRIVATE_KEY: "YOUR_PRIVATE_KEY_HERE",

  // Predict.fun 交易账户地址
  PREDICT_ACCOUNT: "0xF07E38e61E3a4c64364f56a5679578d860160f5a",

  // API
  API_KEY: "5f623dc1-147a-4767-8795-cf02f1f25149",
  JWT_TOKEN: "YOUR_JWT_TOKEN_HERE",
  API_URL: "https://api.predict.fun",

  // 交易参数
  ORDER_SIZE: 6,          // 每个outcome挂6份额 (Yes挂6, No挂6)
  TICK_SIZE: 0.01,        // (已不用于挂单偏移, 仅用于极端情况保护)

  // 盘口门槛 (买1挂单量低于此值不挂)
  MIN_BID1_FOOTBALL: 4000,
  MIN_BID1_WORLDCUP: 5000,
  MIN_BID1_ESPORTS: 3000,
  MIN_BID1_FDV: 2000,

  // 异动检测
  BID1_DROP_PERCENT: 0.3,   // 买1减少30%触发撤单
  BID1_MIN_SIZE: 50,        // 买1低于此量触发撤单

  // 时间
  POLL_INTERVAL: 3000,      // 轮询间隔 3秒
  RECOVER_WAIT: 60000,      // 异动后冷却 60秒(1分钟)，冷却后重新检查买1是否符合条件再挂

  // Telegram
  TELEGRAM_BOT_TOKEN: "8739215233:AAHwG7G60sgOYze9Jo0u-KddtP0UBxDjnKg",
  TELEGRAM_CHAT_ID: "5707621530",
};

// ============ 工具函数 ============

async function sendTelegram(message) {
  try {
    const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text: message, parse_mode: "HTML" }),
    });
  } catch (e) {
    console.error("[TG] 发送失败:", e.message);
  }
}

async function fetchAPI(path, options = {}) {
  const url = `${CONFIG.API_URL}${path}`;
  const headers = {
    "Content-Type": "application/json",
    "x-api-key": CONFIG.API_KEY,
    "Authorization": `Bearer ${CONFIG.JWT_TOKEN}`,
    ...options.headers,
  };
  const resp = await fetch(url, { ...options, headers });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`API ${resp.status}: ${text}`);
  }
  return resp.json();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============ 日期工具 ============

function getUTCDateString(date) {
  return date.toISOString().split("T")[0]; // "2026-05-13"
}

function getTodayUTC() {
  return getUTCDateString(new Date());
}

function getTomorrowUTC() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return getUTCDateString(d);
}

function getEventDate(category) {
  if (!category.endsAt) return null;
  return category.endsAt.split("T")[0];
}

// ============ 获取体育/电竞比赛 ============

async function fetchSportsCategories(variant, maxPages = 5) {
  let allCategories = [];
  let cursor = null;
  
  for (let page = 0; page < maxPages; page++) {
    let path = `/v1/categories?first=100&marketVariant=${variant}`;
    if (cursor) path += `&after=${cursor}`;
    
    try {
      const data = await fetchAPI(path);
      const batch = data.data || [];
      if (batch.length === 0) break;
      allCategories = allCategories.concat(batch);
      cursor = data.cursor || null;
      if (batch.length < 100) break;
      await sleep(300);
    } catch (e) {
      console.error(`  获取 ${variant} 失败: ${e.message}`);
      break;
    }
  }
  
  return allCategories;
}

// ============ 获取盘口 ============

async function getOrderbook(marketId) {
  try {
    const data = await fetchAPI(`/v1/markets/${marketId}/orderbook`);
    const ob = data.data || data;

    const bids = ob.bids || [];
    let bid1Price = 0, bid1Size = 0;
    if (bids.length > 0) {
      const b = bids[0];
      if (typeof b === "object" && !Array.isArray(b)) {
        bid1Price = parseFloat(b.price || 0);
        bid1Size = parseFloat(b.size || 0);
      } else if (Array.isArray(b)) {
        bid1Price = parseFloat(b[0] || 0);
        bid1Size = parseFloat(b[1] || 0);
      }
    }

    const asks = ob.asks || [];
    let ask1Price = 999;
    if (asks.length > 0) {
      const a = asks[0];
      if (typeof a === "object" && !Array.isArray(a)) {
        ask1Price = parseFloat(a.price || 999);
      } else if (Array.isArray(a)) {
        ask1Price = parseFloat(a[0] || 999);
      }
    }

    return { bid1Price, bid1Size, ask1Price };
  } catch (e) {
    return null;
  }
}

// ============ 撤单 ============

async function cancelOrder(orderId) {
  try {
    await fetchAPI(`/v1/orders/${orderId}`, { method: "DELETE" });
    return true;
  } catch (e) {
    console.error(`  撤单失败 (${orderId}): ${e.message}`);
    return false;
  }
}

// ============ 查订单状态 ============

async function getOrderStatus(orderId) {
  try {
    const data = await fetchAPI(`/v1/orders/${orderId}`);
    const order = data.data || data;
    const status = (order.status || order.state || order.orderStatus || "UNKNOWN").toUpperCase();
    return status;
  } catch {
    return null;
  }
}

// ============ 获取已有挂单 ============

async function getExistingOpenOrders() {
  try {
    const params = new URLSearchParams({ status: "OPEN", first: "200" });
    const data = await fetchAPI(`/v1/orders?${params}`);
    const orders = data.data || (Array.isArray(data) ? data : []);
    const ordersByMarket = {};
    for (const o of orders) {
      const mid = o.marketId || o.market_id || (o.order && o.order.marketId);
      const oid = o.orderId || o.id || (o.order && o.order.orderId);
      if (mid && oid) {
        if (!ordersByMarket[mid]) ordersByMarket[mid] = [];
        ordersByMarket[mid].push(oid);
      }
    }
    console.log(`📋 当前有 ${orders.length} 笔活跃挂单, 覆盖 ${Object.keys(ordersByMarket).length} 个市场`);
    return ordersByMarket;
  } catch (e) {
    console.error(`获取活跃订单失败: ${e.message}`);
    return {};
  }
}

// ============ 单市场监控器 ============

class MarketMonitor {
  constructor(market, categoryTitle, orderBuilder, minBid1Size) {
    this.market = market;
    this.orderBuilder = orderBuilder;
    this.marketId = market.id || market.marketId;
    this.marketName = `${(categoryTitle || "").slice(0, 25)} | ${(market.title || market.question || "").slice(0, 20)}`;
    this.minBid1Size = minBid1Size || 5000;

    // 状态
    this.activeOrderId = null;
    this.activeSide = null;
    this.lastBid1Size = null;
    this.isCoolingDown = false;
    this.cooldownStart = 0;
    this.isFilled = false;
  }

  checkAnomaly(book) {
    const currentSize = book.bid1Size;
    if (this.lastBid1Size === null) { this.lastBid1Size = currentSize; return false; }
    if (this.lastBid1Size <= 0) { this.lastBid1Size = currentSize; return false; }

    const dropRatio = (this.lastBid1Size - currentSize) / this.lastBid1Size;
    const tooSmall = currentSize < CONFIG.BID1_MIN_SIZE;
    const isAnomaly = dropRatio >= CONFIG.BID1_DROP_PERCENT || tooSmall;

    if (isAnomaly) {
      console.log(`  ⚠️ [${this.marketName}] 异动! 买1: ${this.lastBid1Size.toFixed(0)} → ${currentSize.toFixed(0)} (↓${(dropRatio * 100).toFixed(0)}%)`);
    }
    this.lastBid1Size = currentSize;
    return isAnomaly;
  }

  async cancelActiveOrder() {
    if (this.activeOrderId) {
      const success = await cancelOrder(this.activeOrderId);
      if (!success) {
        console.log(`  🔔 [${this.marketName}] 挂单被吃! (撤单失败=已成交)`);
        await sendTelegram(`🔔 <b>挂单被吃!</b>\n\n📊 ${this.marketName}\n🆔 ${this.activeOrderId}`);
        this.isFilled = true;
      }
      this.activeOrderId = null;
      this.activeSide = null;
    }
  }

  async placeOrder(book) {
    if (this.activeOrderId) return null;

    // 对每个 outcome 都尝试挂单 (Yes + No 各挂10)
    const outcomes = this.market.outcomes || [];
    for (const outcome of outcomes) {
      if (!outcome) continue;
      const tokenId = String(outcome.onChainId || "");
      if (!tokenId) continue;

      // 用 outcome 自己的 bestBid 作为买1价格
      const outcomeBid = outcome.bestBid;
      if (!outcomeBid || !outcomeBid.price) continue;
      if (outcomeBid.size < this.minBid1Size) continue;

      // 检查买卖价差: 差超过0.06不挂
      const outcomeBidPrice = parseFloat(outcomeBid.price);
      const outcomeAsk = outcome.bestAsk;
      if (outcomeAsk && outcomeAsk.price) {
        const askPrice = parseFloat(outcomeAsk.price);
        if (askPrice - outcomeBidPrice > 0.06) {
          console.log(`  ⛔ [${this.marketName}] ${outcome.name || ""} 买卖差=${(askPrice - outcomeBidPrice).toFixed(2)} > 0.06, 跳过`);
          continue;
        }
      }

      // 直接用该 outcome 的买1价格挂单 (保留原始精度)
      const fixedPrice = outcomeBidPrice;
      if (fixedPrice <= 0 || isNaN(fixedPrice)) continue;
      if (fixedPrice * CONFIG.ORDER_SIZE < 0.9) continue;

      try {
        const priceWei = BigInt(Math.floor(fixedPrice * 1e18));
        const quantityWei = BigInt(CONFIG.ORDER_SIZE) * BigInt(1e18);

        const { makerAmount, takerAmount, pricePerShare } = this.orderBuilder.getLimitOrderAmounts({
          side: Side.BUY,
          pricePerShareWei: priceWei,
          quantityWei: quantityWei,
        });

        const order = this.orderBuilder.buildOrder("LIMIT", {
          side: Side.BUY,
          tokenId: tokenId,
          makerAmount,
          takerAmount,
          nonce: 0n,
          feeRateBps: this.market.feeRateBps || 200,
        });

        const isNegRisk = this.market.isNegRisk || false;
        const isYieldBearing = this.market.isYieldBearing || false;
        const typedData = this.orderBuilder.buildTypedData(order, { isNegRisk, isYieldBearing });
        const signedOrder = await this.orderBuilder.signTypedDataOrder(typedData);
        const hash = this.orderBuilder.buildTypedDataHash(typedData);

        const serializableOrder = {};
        for (const [key, value] of Object.entries(signedOrder)) {
          serializableOrder[key] = typeof value === "bigint" ? value.toString() : value;
        }
        serializableOrder.hash = hash;

        const body = {
          data: {
            order: serializableOrder,
            pricePerShare: typeof pricePerShare === "bigint" ? pricePerShare.toString() : pricePerShare,
            strategy: "LIMIT",
          },
        };

        const result = await fetchAPI("/v1/orders", { method: "POST", body: JSON.stringify(body) });
        const orderId = result.data?.orderId || result.orderId || null;
        console.log(`  ✅ [${this.marketName}] 挂单 BUY ${outcome.name || ""} @ ${fixedPrice.toFixed(2)}, id=${orderId}`);
        // 记录第一个成功的订单用于状态跟踪
        if (!this.activeOrderId) {
          this.activeOrderId = orderId;
          this.activeSide = "BUY";
        }
      } catch (e) {
        console.error(`  ❌ [${this.marketName}] ${outcome.name || ""} 挂单失败: ${e.message}`);
      }
    }
    return this.activeOrderId;
  }

  async tick() {
    if (this.isFilled) return;

    // 冷却期
    if (this.isCoolingDown) {
      if (Date.now() - this.cooldownStart < CONFIG.RECOVER_WAIT) return;
      this.isCoolingDown = false;
      this.lastBid1Size = null;
    }

    // 获取盘口
    const book = await getOrderbook(this.marketId);
    if (!book) return;

    // 检查订单状态
    if (this.activeOrderId) {
      const status = await getOrderStatus(this.activeOrderId);
      if (status === null) return; // 网络问题,跳过
      if (status === "OPEN") {
        // 正常,检查异动
      } else if (status === "MATCHED" || status === "FILLED" || status === "EXECUTED" || status === "PARTIALLY_FILLED" || status === "CLOSED") {
        console.log(`  🔔 [${this.marketName}] 挂单被吃! 状态=${status}`);
        await sendTelegram(`🔔 <b>挂单被吃!</b>\n\n📊 ${this.marketName}\n🆔 ${this.activeOrderId}\n📋 ${status}`);
        this.isFilled = true;
        this.activeOrderId = null;
        return;
      } else if (status === "CANCELLED" || status === "EXPIRED" || status === "REJECTED") {
        this.activeOrderId = null;
        this.activeSide = null;
      } else {
        return;
      }
    }

    // 有订单 → 异动检测
    if (this.activeOrderId) {
      if (this.checkAnomaly(book)) {
        await this.cancelActiveOrder();
        this.isCoolingDown = true;
        this.cooldownStart = Date.now();
        return;
      }
    } else {
      // 无订单 → 挂单
      await this.placeOrder(book);
    }
  }
}

// ============ 主函数 ============

async function main() {
  console.log("=".repeat(60));
  console.log("做市 Bot v2 - 体育/电竞专版 (Predict.fun)");
  console.log("=".repeat(60));

  const today = getTodayUTC();
  const tomorrow = getTomorrowUTC();
  console.log(`今天: ${today} | 明天: ${tomorrow}`);
  console.log(`足球: 挂今天+明天的比赛 + 世界杯不限日期`);
  console.log(`电竞: 只挂今天的 CS2/LOL 比赛 (不挂Dota)`);
  console.log(`加密: FDV预测市场全挂 (不限日期)`);
  console.log(`挂单价格: 买1 (Yes挂6, No挂6)`);
  console.log(`盘口最低: 足球≥4000 | 世界杯≥5000 | 电竞≥3000 | FDV≥3000`);
  console.log(`只挂有积分奖励的市场, LIVE不挂`);
  console.log("=".repeat(60));

  // 初始化 SDK
  console.log("\n初始化钱包和 SDK...");
  const signer = new Wallet(CONFIG.PRIVATE_KEY);
  console.log(`签名钱包: ${signer.address}`);
  console.log(`交易账户: ${CONFIG.PREDICT_ACCOUNT}`);

  const orderBuilder = await OrderBuilder.make(ChainId.BnbMainnet, signer, {
    predictAccount: CONFIG.PREDICT_ACCOUNT,
  });
  console.log("SDK 初始化成功!\n");

  // ===== 获取足球比赛 (SPORTS_MATCH) =====
  console.log("🔍 获取足球比赛 (SPORTS_MATCH)...");
  const footballCategories = await fetchSportsCategories("SPORTS_MATCH");
  console.log(`  共 ${footballCategories.length} 个足球事件`);

  // ===== 获取电竞/NBA/板球 (SPORTS_TEAM_MATCH) =====
  console.log("🔍 获取电竞/NBA/板球 (SPORTS_TEAM_MATCH)...");
  const esportsCategories = await fetchSportsCategories("SPORTS_TEAM_MATCH");
  console.log(`  共 ${esportsCategories.length} 个电竞/NBA事件`);

  // ===== 获取加密FDV市场 (DEFAULT) =====
  console.log("🔍 获取加密FDV市场 (DEFAULT)...");
  const defaultCategories = await fetchSportsCategories("DEFAULT");
  console.log(`  共 ${defaultCategories.length} 个DEFAULT事件`);

  // ===== 筛选日期 + 创建监控器 =====
  const monitors = [];
  const seenMarketIds = new Set();
  let footballCount = 0, esportsCount = 0, skippedDate = 0, skippedLive = 0;

  // 足球: 挂今天+明天 + 世界杯不限日期
  for (const cat of footballCategories) {
    const eventDate = getEventDate(cat);
    const catSlug = (cat.categorySlug || cat.slug || "").toLowerCase();
    const catTitle = (cat.title || "").toLowerCase();
    const isWorldCup = catSlug.includes("world-cup") || catSlug.includes("worldcup") || catTitle.includes("world cup") || catTitle.includes("世界杯");
    
    // 世界杯不限日期，其他足球只挂今天+明天
    if (!isWorldCup && (!eventDate || (eventDate !== today && eventDate !== tomorrow))) { skippedDate++; continue; }

    const markets = cat.markets || [];
    for (const m of markets) {
      // 严格排除LIVE和非OPEN的市场
      const tStatus = (m.tradingStatus || "").toUpperCase();
      const mStatus = (m.status || "").toUpperCase();
      const mState = (m.state || "").toUpperCase();
      if (tStatus !== "OPEN" || mStatus === "LIVE" || mState === "LIVE" || m.isLive === true) { skippedLive++; continue; }
      // 跳过没有积分奖励的市场
      const rewards = m.rewards || {};
      const hasRewards = (rewards.current) || (rewards.schedule && rewards.schedule.length > 0);
      const rewardRate = m.rewardRate || m.pointsMultiplier || m.rewardsMultiplier || 0;
      if (!hasRewards && rewardRate <= 0) continue;
      const mid = m.id || m.marketId;
      if (seenMarketIds.has(mid)) continue;
      seenMarketIds.add(mid);
      monitors.push(new MarketMonitor(m, cat.title || "", orderBuilder, isWorldCup ? CONFIG.MIN_BID1_WORLDCUP : CONFIG.MIN_BID1_FOOTBALL));
      footballCount++;
    }
  }

  // 电竞/NBA: 只挂今天的, 只挂CS和LOL (不挂Dota)
  for (const cat of esportsCategories) {
    const eventDate = getEventDate(cat);
    if (!eventDate || eventDate !== today) { skippedDate++; continue; }

    // 只挂 CS2/CSGO 和 LOL, 跳过 Dota
    const catTitle = (cat.title || "").toLowerCase();
    const catDesc = (cat.description || "").toLowerCase();
    const combined = catTitle + " " + catDesc;
    const isCS = combined.includes("cs2") || combined.includes("csgo") || combined.includes("counter-strike");
    const isLoL = combined.includes("lol") || combined.includes("league of legends");
    if (!isCS && !isLoL) { skippedDate++; continue; }

    const markets = cat.markets || [];
    for (const m of markets) {
      // 严格排除LIVE和非OPEN的市场
      const tStatus = (m.tradingStatus || "").toUpperCase();
      const mStatus = (m.status || "").toUpperCase();
      const mState = (m.state || "").toUpperCase();
      if (tStatus !== "OPEN" || mStatus === "LIVE" || mState === "LIVE" || m.isLive === true) { skippedLive++; continue; }
      // 跳过没有积分奖励的市场
      const rewards = m.rewards || {};
      const hasRewards = (rewards.current) || (rewards.schedule && rewards.schedule.length > 0);
      const rewardRate = m.rewardRate || m.pointsMultiplier || m.rewardsMultiplier || 0;
      if (!hasRewards && rewardRate <= 0) continue;
      const mid = m.id || m.marketId;
      if (seenMarketIds.has(mid)) continue;
      seenMarketIds.add(mid);
      monitors.push(new MarketMonitor(m, cat.title || "", orderBuilder, CONFIG.MIN_BID1_ESPORTS));
      esportsCount++;
    }
  }

  // 加密FDV: slug/title含"fdv"的都挂 (不限日期)
  let fdvCount = 0;
  for (const cat of defaultCategories) {
    const catSlug = (cat.categorySlug || cat.slug || "").toLowerCase();
    const catTitle = (cat.title || "").toLowerCase();
    const catDesc = (cat.description || "").toLowerCase();
    const isFDV = catSlug.includes("fdv") || catTitle.includes("fdv") || catDesc.includes("fully diluted valuation") || catSlug.includes("polymarket") || catTitle.includes("polymarket");
    if (!isFDV) continue;

    const markets = cat.markets || [];
    for (const m of markets) {
      // 严格排除LIVE和非OPEN的市场
      const tStatus = (m.tradingStatus || "").toUpperCase();
      const mStatus = (m.status || "").toUpperCase();
      const mState = (m.state || "").toUpperCase();
      if (tStatus !== "OPEN" || mStatus === "LIVE" || mState === "LIVE" || m.isLive === true) { skippedLive++; continue; }
      // 跳过没有积分奖励的市场
      const rewards = m.rewards || {};
      const hasRewards = (rewards.current) || (rewards.schedule && rewards.schedule.length > 0);
      const rewardRate = m.rewardRate || m.pointsMultiplier || m.rewardsMultiplier || 0;
      if (!hasRewards && rewardRate <= 0) continue;
      const mid = m.id || m.marketId;
      if (seenMarketIds.has(mid)) continue;
      seenMarketIds.add(mid);
      monitors.push(new MarketMonitor(m, cat.title || "", orderBuilder, CONFIG.MIN_BID1_FDV));
      fdvCount++;
    }
  }

  console.log(`\n✅ 共 ${monitors.length} 个市场待挂单`);
  console.log(`   足球(今天+明天): ${footballCount} | 电竞CS/LOL(今天): ${esportsCount} | 加密FDV: ${fdvCount}`);
  console.log(`   跳过: ${skippedDate}非目标日期 + ${skippedLive}非OPEN`);

  if (monitors.length === 0) {
    console.log("\n⚠️ 没有符合条件的市场，退出。");
    return;
  }

  // ===== 恢复已有挂单 =====
  console.log("\n📋 检查已有活跃挂单 (防重复)...");
  const existingOrders = await getExistingOpenOrders();
  let restoredCount = 0;
  for (const monitor of monitors) {
    const marketOrders = existingOrders[monitor.marketId];
    if (marketOrders && marketOrders.length > 0) {
      monitor.activeOrderId = marketOrders[0];
      monitor.activeSide = "RESTORED";
      restoredCount++;
    }
  }
  console.log(`   恢复 ${restoredCount} 个已有挂单\n`);

  // 退出清理
  let running = true;
  const cleanup = async () => {
    if (!running) return;
    running = false;
    console.log("\n🛑 正在撤销所有活跃订单...");
    const activeIds = monitors.filter(m => m.activeOrderId).map(m => m.activeOrderId);
    for (const id of activeIds) await cancelOrder(id);
    console.log(`已撤销 ${activeIds.length} 笔订单`);
    await sendTelegram("🛑 做市Bot已停止，所有挂单已撤销。");
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // 主循环
  console.log("🚀 开始做市循环...\n");

  while (running) {
    for (const monitor of monitors) {
      if (!running) break;
      try {
        await monitor.tick();
      } catch (e) {
        console.error(`  [${monitor.marketName}] 异常: ${e.message}`);
      }
      await sleep(300);
    }
    await sleep(CONFIG.POLL_INTERVAL);
  }
}

main().catch(e => {
  console.error("程序异常:", e);
  process.exit(1);
});
