/**
 * 全自动做市 Bot - Predict.fun (Node.js + 官方SDK) v2
 * ============================================================
 * 功能:
 *   1. 通过 /v1/categories API 获取体育+电竞比赛
 *   2. 足球: 只挂明天的比赛 (SPORTS_MATCH)
 *   3. 电竞/NBA/板球: 只挂今天和明天的比赛 (SPORTS_TEAM_MATCH)
 *   4. 每个比赛的子市场都挂买1 (买1量最大的那边)
 *   5. 3秒轮询异动检测, 买1暴跌50%立刻撤单
 *   6. 挂单被吃 → 立刻 Telegram 报警
 *   7. Ctrl+C 退出前批量撤单
 *
 * 使用:
 *   node market_maker.js
 */

import { Wallet } from "ethers";
import { OrderBuilder, ChainId, Side } from "@predictdotfun/sdk";

// ============ 配置 ============
const CONFIG = {
  PRIVATE_KEY: "a03089bc170585dee33ebd0c46c3660c1cc5823ab51e99ae4625811fba98ef88",
  PREDICT_ACCOUNT: "0xF07E38e61E3a4c64364f56a5679578d860160f5a",
  API_KEY: "5f623dc1-147a-4767-8795-cf02f1f25149",
  JWT_TOKEN: "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ3YWxsZXRJZCI6MTQ1Njk0OSwiYWRkcmVzcyI6IjB4RjA3RTM4ZTYxRTNhNGM2NDM2NGY1NmE1Njc5NTc4ZDg2MDE2MGY1YSIsImlhdCI6MTc3ODQ5OTg2MiwiZXhwIjoxNzc4NTg2MjYyLCJpc3MiOiJQcmVkaWN0RG90RnVuIiwic3ViIjoiMHhGMDdFMzhlNjFFM2E0YzY0MzY0ZjU2YTU2Nzk1NzhkODYwMTYwZjVhIn0.zaVAxcrwpc6lItkXgsLmEiKemFhEaElwbZzQVMb0kp4",
  API_URL: "https://api.predict.fun",

  // 交易参数
  ORDER_SIZE: 5,              // 每笔5份额
  MIN_BID1_SIZE: 500,         // 买1低于500份额不挂 (体育/电竞盘口深度较浅)
  TICK_SIZE: 0.01,            // maker保护: 挂单价 = 买1 - 0.01 (API精度限制2位小数)

  // 轮询/异动
  POLL_INTERVAL: 3000,        // 3秒轮询 (ms)
  BID1_DROP_PERCENT: 0.5,     // 买1减少50%触发撤单
  BID1_MIN_SIZE: 50,          // 买1低于50触发撤单
  RECOVER_WAIT: 30000,        // 撤单后30秒冷却 (ms)

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
  // 从 endsAt 提取日期
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
  constructor(market, categoryTitle, orderBuilder) {
    this.market = market;
    this.orderBuilder = orderBuilder;
    this.marketId = market.id || market.marketId;
    this.marketName = `${(categoryTitle || "").slice(0, 25)} | ${(market.title || market.question || "").slice(0, 20)}`;

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

    const { bid1Price, bid1Size, ask1Price } = book;
    if (bid1Size < CONFIG.MIN_BID1_SIZE) return null;
    if (bid1Price <= 0) return null;

    // 获取 token ID (买 Yes 方向, indexSet=1)
    const outcomes = this.market.outcomes || [];
    const outcome = outcomes[0]; // 第一个 outcome (主队/Yes)
    if (!outcome) return null;
    const tokenId = String(outcome.onChainId || "");
    if (!tokenId) return null;

    // 防吃单: 挂单价 = 买1 - tick
    let makerPrice = bid1Price - CONFIG.TICK_SIZE;
    if (makerPrice >= ask1Price) {
      makerPrice = ask1Price - CONFIG.TICK_SIZE;
    }

    // 2位小数精度
    const fixedPrice = Math.floor(makerPrice * 100) / 100;
    if (fixedPrice <= 0) return null;
    if (fixedPrice * CONFIG.ORDER_SIZE < 0.9) return null;
    if (fixedPrice >= ask1Price) return null;

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
      console.log(`  ✅ [${this.marketName}] 挂单 BUY @ ${fixedPrice.toFixed(2)}, id=${orderId}`);
      this.activeOrderId = orderId;
      this.activeSide = "BUY";
      return orderId;
    } catch (e) {
      console.error(`  ❌ [${this.marketName}] 挂单失败: ${e.message}`);
      return null;
    }
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
      } else if (status === "MATCHED" || status === "FILLED" || status === "EXECUTED") {
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
  console.log(`足球: 只挂明天的比赛`);
  console.log(`电竞: 只挂今天的 CS2/LOL 比赛 (不挂Dota)`);
  console.log(`Maker保护: 买1 - ${CONFIG.TICK_SIZE}`);
  console.log(`盘口最低: ≥${CONFIG.MIN_BID1_SIZE} shares`);
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

  // ===== 筛选日期 + 创建监控器 =====
  const monitors = [];
  const seenMarketIds = new Set();
  let footballCount = 0, esportsCount = 0, skippedDate = 0, skippedLive = 0;

  // 足球: 只挂明天
  for (const cat of footballCategories) {
    const eventDate = getEventDate(cat);
    if (!eventDate || eventDate !== tomorrow) { skippedDate++; continue; }

    const markets = cat.markets || [];
    for (const m of markets) {
      if (m.tradingStatus !== "OPEN") { skippedLive++; continue; }
      const mid = m.id || m.marketId;
      if (seenMarketIds.has(mid)) continue;
      seenMarketIds.add(mid);
      monitors.push(new MarketMonitor(m, cat.title || "", orderBuilder));
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
      if (m.tradingStatus !== "OPEN") { skippedLive++; continue; }
      const mid = m.id || m.marketId;
      if (seenMarketIds.has(mid)) continue;
      seenMarketIds.add(mid);
      monitors.push(new MarketMonitor(m, cat.title || "", orderBuilder));
      esportsCount++;
    }
  }

  console.log(`\n✅ 共 ${monitors.length} 个市场待挂单`);
  console.log(`   足球(明天): ${footballCount} | 电竞CS/LOL(今天): ${esportsCount}`);
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
