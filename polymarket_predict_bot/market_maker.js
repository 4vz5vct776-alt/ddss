/**
 * 全自动做市 Bot - Predict.fun (Node.js + 官方SDK)
 * ============================================================
 * 功能:
 *   1. 扫描所有有积分的市场，跳过比赛中/加密短期/盘口<$1000
 *   2. Yes/No 两边看买1量，多的那边挂 BUY
 *   3. 所有市场统一3秒轮询订单簿，买1大量减少(≥50%) → 立刻撤单，等30秒后重挂
 *   4. 体育/电竞市场额外对齐 Polymarket 订单簿，异动就撤
 *   5. 挂单被吃 → 立刻 Telegram 报警
 *   6. Ctrl+C 退出前批量撤单
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
  POLYMARKET_CLOB_URL: "https://clob.polymarket.com",

  // 交易参数
  TOTAL_BUDGET: 30.0,
  ORDER_SIZE: 5,              // 每笔5份额
  MIN_BID1_SIZE: 1000,        // 买1低于1000份额不挂
  TICK_SIZE: 0.01,            // maker保护: 挂单价 = 买1 - 0.01, 确保只做maker不吃单 (API精度限制2位小数)
  MAX_MARKETS_PER_EVENT: 1,   // 同一父事件最多挂几个子市场 (防重复)

  // 轮询/异动
  POLL_INTERVAL: 3000,        // 3秒轮询 (ms)
  BID1_DROP_PERCENT: 0.5,     // 买1减少50%触发撤单
  BID1_MIN_SIZE: 50,          // 买1低于50触发撤单
  RECOVER_WAIT: 30000,        // 撤单后30秒冷却 (ms)

  // Telegram
  TELEGRAM_BOT_TOKEN: "8739215233:AAHwG7G60sgOYze9Jo0u-KddtP0UBxDjnKg",
  TELEGRAM_CHAT_ID: "5707621530",
};

// ============ 关键词 ============
const SPORTS_KEYWORDS = [
  "nba", "nfl", "mlb", "nhl", "soccer", "football", "basketball",
  "baseball", "tennis", "cricket", "boxing", "mma", "ufc",
  "f1", "formula", "golf", "rugby", "hockey",
  "premier league", "la liga", "serie a", "bundesliga",
  "champions league", "world cup",
];

const ESPORTS_KEYWORDS = [
  "esports", "e-sports", "league of legends", "lol", "dota",
  "cs2", "csgo", "valorant", "overwatch", "fortnite",
  "pubg", "apex", "call of duty", "cod",
];

const CRYPTO_SHORT_KEYWORDS = [
  "15min", "15 min", "15m", "1hour", "1 hour", "1h",
  "30min", "30 min", "30m", "5min", "5 min", "5m", "hourly",
];

const CRYPTO_KEYWORDS = [
  "bitcoin", "btc", "ethereum", "eth", "crypto", "sol", "solana",
  "bnb", "xrp", "doge", "ada", "avax", "matic", "dot", "defi",
];

const POLITICAL_KEYWORDS = [
  "fed", "fomc", "federal reserve", "interest rate", "rate cut", "rate hike",
  "trump", "biden", "congress", "senate", "election", "president",
  "governor", "政治", "美联储", "降息", "加息",
];

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

// ============ 市场分类/过滤 ============

function classifyMarket(market) {
  const combined = `${market.title || ""} ${market.category || ""} ${(market.tags || []).join(" ")}`.toLowerCase();
  for (const kw of ESPORTS_KEYWORDS) if (combined.includes(kw)) return "esports";
  for (const kw of SPORTS_KEYWORDS) if (combined.includes(kw)) return "sports";
  return "general";
}

function isLiveEvent(market) {
  const ts = market.tradingStatus;
  const status = (typeof ts === "object" ? ts?.status || "" : ts || "").toUpperCase();
  if (["LIVE", "IN_PROGRESS", "STARTED", "HALTED", "PLAYING"].includes(status)) return true;
  const title = market.title || market.question || "";
  if (title.includes("[LIVE]") || title.includes("(LIVE)") || title.includes("🔴")) return true;
  if (market.isLive || market.is_live) return true;
  return false;
}

function isCryptoShortTerm(market) {
  const combined = `${market.title || ""} ${market.category || ""} ${(market.tags || []).join(" ")}`.toLowerCase();
  const isCrypto = CRYPTO_KEYWORDS.some(kw => combined.includes(kw));
  if (!isCrypto) return false;
  // 只过滤明确包含短期时间关键词的加密市场
  // 标题中必须同时包含加密关键词+短期关键词才算短期盘
  const title = (market.title || "").toLowerCase();
  return CRYPTO_SHORT_KEYWORDS.some(kw => title.includes(kw));
}

function isPoliticalEvent(market) {
  const combined = `${market.title || ""} ${market.category || ""} ${(market.tags || []).join(" ")}`.toLowerCase();
  return POLITICAL_KEYWORDS.some(kw => combined.includes(kw));
}

function getTokenId(market, tokenIdx) {
  // tokenIdx: 0 = Yes outcome, 1 = No outcome
  const outcomes = market.outcomes || [];
  const outcome = outcomes[tokenIdx] || outcomes[0];
  if (!outcome) return null;
  if (typeof outcome === "object") {
    return String(outcome.onChainId || outcome.tokenId || outcome.token_id || outcome.id || "");
  }
  return String(outcome);
}

// ============ 获取盘口 (Yes + No 两边) ============

async function getFullOrderbook(marketId) {
  try {
    const data = await fetchAPI(`/v1/markets/${marketId}/orderbook`);
    const ob = data.data || data;

    // Yes 买1
    const yesBids = ob.bids || [];
    let yesBid1Price = 0, yesBid1Size = 0;
    if (yesBids.length > 0) {
      const b = yesBids[0];
      if (typeof b === "object" && !Array.isArray(b)) {
        yesBid1Price = parseFloat(b.price || 0);
        yesBid1Size = parseFloat(b.size || 0);
      } else if (Array.isArray(b)) {
        yesBid1Price = parseFloat(b[0] || 0);
        yesBid1Size = parseFloat(b[1] || 0);
      }
    }

    // Yes 卖1 (最低卖价, 用于判断是否会吃单)
    const yesAsks = ob.asks || [];
    let yesAsk1Price = 999;
    if (yesAsks.length > 0) {
      const a = yesAsks[0];
      if (typeof a === "object" && !Array.isArray(a)) {
        yesAsk1Price = parseFloat(a.price || 999);
      } else if (Array.isArray(a)) {
        yesAsk1Price = parseFloat(a[0] || 999);
      }
    }

    // No 买1
    const noBids = ob.noBids || [];
    let noBid1Price = 0, noBid1Size = 0;
    if (noBids.length > 0) {
      const b = noBids[0];
      if (typeof b === "object" && !Array.isArray(b)) {
        noBid1Price = parseFloat(b.price || 0);
        noBid1Size = parseFloat(b.size || 0);
      } else if (Array.isArray(b)) {
        noBid1Price = parseFloat(b[0] || 0);
        noBid1Size = parseFloat(b[1] || 0);
      }
    }

    // No 卖1
    const noAsks = ob.noAsks || [];
    let noAsk1Price = 999;
    if (noAsks.length > 0) {
      const a = noAsks[0];
      if (typeof a === "object" && !Array.isArray(a)) {
        noAsk1Price = parseFloat(a.price || 999);
      } else if (Array.isArray(a)) {
        noAsk1Price = parseFloat(a[0] || 999);
      }
    }

    return { yesBid1Price, yesBid1Size, yesAsk1Price, noBid1Price, noBid1Size, noAsk1Price };
  } catch (e) {
    return null;
  }
}

// ============ Polymarket 盘口 ============

async function getPolymarketBook(tokenId) {
  if (!tokenId) return null;
  try {
    const resp = await fetch(`${CONFIG.POLYMARKET_CLOB_URL}/book?token_id=${tokenId}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    const bids = data.bids || [];
    if (bids.length === 0) return null;
    return { bid1Price: parseFloat(bids[0].price), bid1Size: parseFloat(bids[0].size) };
  } catch {
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

// ============ 获取所有活跃挂单 (启动时恢复状态, 防重复) ============

async function getExistingOpenOrders() {
  try {
    const params = new URLSearchParams({ status: "OPEN", first: "200" });
    const data = await fetchAPI(`/v1/orders?${params}`);
    const orders = data.data || (Array.isArray(data) ? data : []);

    // 按 marketId 分组
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

// ============ 单市场监控器 ============

class MarketMonitor {
  constructor(market, orderBuilder) {
    this.market = market;
    this.orderBuilder = orderBuilder;
    this.marketId = market.id || market.marketId;
    this.marketName = (market.title || market.question || `#${this.marketId}`).slice(0, 40);
    this.marketType = classifyMarket(market);

    // 状态
    this.activeOrderId = null;
    this.activeSide = null; // "BUY" or "SELL"
    this.lastBid1Size = null;
    this.isCoolingDown = false;
    this.cooldownStart = 0;
    this.isFilled = false; // 被吃单后永久停止该市场

    // Polymarket
    this.polymarketTokenId = market.polymarketTokenId || null;
    this._lastPolyBid1 = null;
  }

  chooseSide(book) {
    const { yesBid1Size, yesBid1Price, noBid1Size, noBid1Price } = book;
    if (yesBid1Size <= 0 && noBid1Size <= 0) return null;

    // 永远只挂 BUY (只需要USDB余额，不需要持有份额)
    // 哪边买1量多就买哪边的 token
    if (yesBid1Size >= noBid1Size) {
      return { side: "BUY_YES", price: yesBid1Price, sdkSide: Side.BUY, tokenIdx: 0 };
    } else {
      return { side: "BUY_NO", price: noBid1Price, sdkSide: Side.BUY, tokenIdx: 1 };
    }
  }

  checkAnomaly(book) {
    const currentSize = this.activeSide === "BUY_YES" ? book.yesBid1Size : book.noBid1Size;

    if (this.lastBid1Size === null) {
      this.lastBid1Size = currentSize;
      return false;
    }
    if (this.lastBid1Size <= 0) {
      this.lastBid1Size = currentSize;
      return false;
    }

    const dropRatio = (this.lastBid1Size - currentSize) / this.lastBid1Size;
    const tooSmall = currentSize < CONFIG.BID1_MIN_SIZE;
    const isAnomaly = dropRatio >= CONFIG.BID1_DROP_PERCENT || tooSmall;

    if (isAnomaly) {
      console.log(`  ⚠️ [${this.marketName}] 异动! 买1: ${this.lastBid1Size.toFixed(1)} → ${currentSize.toFixed(1)} (↓${(dropRatio * 100).toFixed(1)}%)`);
    }

    this.lastBid1Size = currentSize;
    return isAnomaly;
  }

  async checkPolymarketAnomaly() {
    if (!this.polymarketTokenId) return false;
    const polyBook = await getPolymarketBook(this.polymarketTokenId);
    if (!polyBook) return false;

    if (this._lastPolyBid1 === null) {
      this._lastPolyBid1 = polyBook.bid1Size;
      return false;
    }
    if (this._lastPolyBid1 > 0) {
      const drop = (this._lastPolyBid1 - polyBook.bid1Size) / this._lastPolyBid1;
      if (drop >= CONFIG.BID1_DROP_PERCENT) {
        console.log(`  ⚠️ [${this.marketName}] Polymarket异动! 买1: ${this._lastPolyBid1.toFixed(1)} → ${polyBook.bid1Size.toFixed(1)}`);
        this._lastPolyBid1 = polyBook.bid1Size;
        return true;
      }
    }
    this._lastPolyBid1 = polyBook.bid1Size;
    return false;
  }

  async cancelActiveOrder() {
    if (this.activeOrderId) {
      const success = await cancelOrder(this.activeOrderId);
      if (!success) {
        // 撤单失败 = 订单已经不存在 = 被吃了
        console.log(`  🔔 [${this.marketName}] 挂单被吃! (撤单失败=已成交) 该市场永久停止`);
        await sendTelegram(
          `🔔 <b>挂单被吃!</b>\n\n📊 市场: ${this.marketName}\n📈 方向: ${this.activeSide}\n🆔 订单: ${this.activeOrderId}\n⛔ 该市场已停止挂单`
        );
        this.isFilled = true;
      }
      console.log(`  🛡️ [${this.marketName}] 已撤单保护`);
      this.activeOrderId = null;
      this.activeSide = null;
    }
  }

  async placeOrder(sideInfo, book) {
    // 防重复: 如果已经有活跃订单, 拒绝再挂
    if (this.activeOrderId) {
      return null;
    }

    const { side, price, sdkSide, tokenIdx } = sideInfo;
    const tokenId = getTokenId(this.market, tokenIdx);
    if (!tokenId) return null;

    // ===== 防吃单: 确保挂单价 < 对面最低卖价 =====
    // 如果 bid >= ask, 说明会立即撮合 (变成taker)
    const ask1 = side === "BUY_YES" ? (book?.yesAsk1Price || 999) : (book?.noAsk1Price || 999);
    
    // 方案: 挂单价 = min(买1 - tick, 卖1 - tick)
    // 这样确保我们的价格严格低于卖1，不会被撮合
    let makerPrice = price - CONFIG.TICK_SIZE;
    if (makerPrice >= ask1) {
      // 买1已经 >= 卖1 (spread=0或负), 必须挂在 ask1 以下
      makerPrice = ask1 - CONFIG.TICK_SIZE;
      console.log(`  ⚠️ [${this.marketName}] spread=0! 买1=${price.toFixed(3)} >= 卖1=${ask1.toFixed(3)}, 降价到 ${makerPrice.toFixed(3)}`);
    }

    // 价格精度修正: 最多2位小数 (API限制, 向下取整)
    const fixedPrice = Math.floor(makerPrice * 100) / 100;
    if (fixedPrice <= 0) return null;

    // 最低订单价值检查: price * ORDER_SIZE >= 0.9
    if (fixedPrice * CONFIG.ORDER_SIZE < 0.9) return null;

    // 再次确认: 挂单价必须严格 < ask1
    if (fixedPrice >= ask1) {
      console.log(`  🚫 [${this.marketName}] 放弃挂单: 价格${fixedPrice} >= 卖1=${ask1}, 会变成taker`);
      return null;
    }

    try {
      const priceWei = BigInt(Math.floor(fixedPrice * 1e18));
      const quantityWei = BigInt(CONFIG.ORDER_SIZE) * BigInt(1e18);

      const { makerAmount, takerAmount, pricePerShare } = this.orderBuilder.getLimitOrderAmounts({
        side: sdkSide,
        pricePerShareWei: priceWei,
        quantityWei: quantityWei,
      });

      const order = this.orderBuilder.buildOrder("LIMIT", {
        side: sdkSide,
        tokenId: tokenId,
        makerAmount,
        takerAmount,
        nonce: 0n,
        feeRateBps: this.market.feeRateBps || 0,
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

      const result = await fetchAPI("/v1/orders", {
        method: "POST",
        body: JSON.stringify(body),
      });

      const orderId = result.data?.orderId || result.orderId || null;
      console.log(`  ✅ [${this.marketName}] 挂单: ${side} @ ${fixedPrice.toFixed(3)}, id=${orderId}`);
      this.activeOrderId = orderId;
      this.activeSide = side;
      return orderId;
    } catch (e) {
      console.error(`  ❌ [${this.marketName}] 挂单失败: ${e.message}`);
      return null;
    }
  }

  async tick() {
    // 被吃单的市场永久停止
    if (this.isFilled) return;

    // 冷却期
    if (this.isCoolingDown) {
      if (Date.now() - this.cooldownStart < CONFIG.RECOVER_WAIT) return;
      console.log(`  ✅ [${this.marketName}] 冷却结束, 重新挂单`);
      this.isCoolingDown = false;
      this.lastBid1Size = null;
    }

    // 获取盘口
    const book = await getFullOrderbook(this.marketId);
    if (!book) return;

    // ===== Bug1+3+10 修复: 检查活跃订单状态 =====
    // 只在有activeOrderId时查状态; null返回值=网络问题，跳过不处理
    // 明确非OPEN状态 → 订单已被吃或取消 → TG报警
    if (this.activeOrderId) {
      const status = await getOrderStatus(this.activeOrderId);
      if (status === null) {
        // API返回null = 网络异常/超时，保持现状不动，防止误清activeOrderId
        // 不清空activeOrderId，下一轮再查
        return;
      }
      if (status === "OPEN") {
        // 正常挂单中，继续异动检测
      } else if (status === "MATCHED" || status === "FILLED" || status === "EXECUTED") {
        // 挂单被吃! 立刻TG报警
        console.log(`  🔔 [${this.marketName}] 挂单被吃! 状态=${status}`);
        await sendTelegram(
          `🔔 <b>挂单被吃!</b>\n\n📊 市场: ${this.marketName}\n📈 方向: ${this.activeSide}\n🆔 订单: ${this.activeOrderId}\n📋 状态: ${status}\n⛔ 该市场已停止挂单`
        );
        this.isFilled = true;
        this.activeOrderId = null;
        this.activeSide = null;
        return;
      } else if (status === "CANCELLED" || status === "EXPIRED" || status === "REJECTED") {
        // 订单被系统取消/过期，清空后重挂
        console.log(`  ⚠️ [${this.marketName}] 订单已失效 状态=${status}, 准备重挂`);
        this.activeOrderId = null;
        this.activeSide = null;
        // 继续往下走到"无活跃单→选边挂单"逻辑
      } else {
        // 未知状态，保守跳过
        return;
      }
    }

    // 体育/电竞: Polymarket 异动检测
    if (this.marketType === "sports" || this.marketType === "esports") {
      if (await this.checkPolymarketAnomaly()) {
        await this.cancelActiveOrder();
        this.isCoolingDown = true;
        this.cooldownStart = Date.now();
        return;
      }
    }

    // 有活跃订单 → 异动检测
    if (this.activeOrderId) {
      if (this.checkAnomaly(book)) {
        await this.cancelActiveOrder();
        this.isCoolingDown = true;
        this.cooldownStart = Date.now();
        return;
      }
      // 检查换边
      const choice = this.chooseSide(book);
      if (choice && choice.side !== this.activeSide) {
        console.log(`  🔄 [${this.marketName}] 换边: ${this.activeSide} → ${choice.side}`);
        await this.cancelActiveOrder();
        await this.placeOrder(choice, book);
      }
    } else {
      // 无活跃单 → 选边挂单
      const choice = this.chooseSide(book);
      if (choice && choice.price > 0) {
        // 买1量检查: 低于2000份额不挂
        const bid1Size = choice.side === "BUY_YES" ? book.yesBid1Size : book.noBid1Size;
        if (bid1Size < CONFIG.MIN_BID1_SIZE) return;

        await this.placeOrder(choice, book);
      }
    }
  }
}

// ============ 主函数 ============

async function main() {
  console.log("=".repeat(60));
  console.log("全自动做市 Bot - Predict.fun (Node.js + SDK)");
  console.log("=".repeat(60));
  console.log(`轮询间隔: 每 ${CONFIG.POLL_INTERVAL / 1000} 秒`);
  console.log(`异动阈值: 买1减少 ${CONFIG.BID1_DROP_PERCENT * 100}% 或低于 ${CONFIG.BID1_MIN_SIZE}`);
  console.log(`撤单冷却: ${CONFIG.RECOVER_WAIT / 1000} 秒`);
  console.log(`每笔份额: ${CONFIG.ORDER_SIZE}`);
  console.log(`总预算: ${CONFIG.TOTAL_BUDGET} USDB`);
  console.log(`盘口最低: 买1≥${CONFIG.MIN_BID1_SIZE} shares`);
  console.log(`Maker保护: 买1 - ${CONFIG.TICK_SIZE} (严格低于卖1, 确保只做maker)`);
  console.log(`市场扫描: 最多10页(1000个市场)`);
  console.log("=".repeat(60));

  // 检查私钥
  if (CONFIG.PRIVATE_KEY === "YOUR_PRIVATE_KEY_HERE") {
    console.error("\n⚠️  请填入钱包私钥! (CONFIG.PRIVATE_KEY)");
    return;
  }
  if (CONFIG.JWT_TOKEN === "YOUR_JWT_TOKEN_HERE") {
    console.error("\n⚠️  请填入 JWT Token! (CONFIG.JWT_TOKEN)");
    return;
  }

  // 初始化 SDK
  console.log("\n初始化钱包和 SDK...");
  const signer = new Wallet(CONFIG.PRIVATE_KEY);
  console.log(`签名钱包: ${signer.address}`);
  console.log(`交易账户: ${CONFIG.PREDICT_ACCOUNT}`);

  const orderBuilder = await OrderBuilder.make(ChainId.BnbMainnet, signer, {
    predictAccount: CONFIG.PREDICT_ACCOUNT,
  });
  console.log("SDK 初始化成功!\n");

  // 获取市场 (分页获取前1000个，覆盖所有活跃市场包括NBA/电竞)
  console.log("🔍 扫描可交易市场...");
  let allMarkets = [];
  const pageSize = 100;
  const maxPages = 10; // 最多10页=1000个市场, 覆盖NBA/电竞等所有类别
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ status: "OPEN", first: String(pageSize), skip: String(page * pageSize), hasActiveRewards: "true" });
    const marketsData = await fetchAPI(`/v1/markets?${params}`);
    const batch = marketsData.data || [];
    allMarkets = allMarkets.concat(batch);
    console.log(`  第${page + 1}页: ${batch.length} 个市场`);
    if (batch.length < pageSize) break;
    await sleep(300);
  }
  console.log(`获取到 ${allMarkets.length} 个市场`);

  // 过滤 + 去重 (防止分页返回重复市场导致同一市场创建多个monitor)
  const monitors = [];
  const seenMarketIds = new Set();
  let skipLive = 0, skipCrypto = 0, skipPolitical = 0, skipDup = 0;

  for (const m of allMarkets) {
    if (isLiveEvent(m)) { skipLive++; continue; }
    if (isCryptoShortTerm(m)) { skipCrypto++; continue; }
    if (isPoliticalEvent(m)) { skipPolitical++; continue; }

    // 去重: 同一个marketId只创建一个monitor
    const mid = m.id || m.marketId;
    if (seenMarketIds.has(mid)) { skipDup++; continue; }
    seenMarketIds.add(mid);

    monitors.push(new MarketMonitor(m, orderBuilder));
  }

  const generalCount = monitors.filter(m => m.marketType === "general").length;
  const sportsCount = monitors.filter(m => m.marketType !== "general").length;

  console.log(`✅ 共 ${monitors.length} 个市场 (跳过: ${skipLive}比赛中 + ${skipCrypto}加密短期 + ${skipPolitical}政治事件 + ${skipDup}重复)`);
  console.log(`   普通: ${generalCount} | 体育/电竞: ${sportsCount}`);
  console.log(`   统一轮询: 每${CONFIG.POLL_INTERVAL / 1000}秒\n`);

  // ===== 启动时恢复已有挂单状态 (防止重启后重复挂单) =====
  console.log("📋 检查已有活跃挂单 (防重复)...");
  const existingOrders = await getExistingOpenOrders();
  let restoredCount = 0;
  for (const monitor of monitors) {
    const marketOrders = existingOrders[monitor.marketId];
    if (marketOrders && marketOrders.length > 0) {
      // 这个市场已经有挂单了，恢复 activeOrderId 防止重复挂
      monitor.activeOrderId = marketOrders[0];
      monitor.activeSide = "RESTORED"; // 标记为已恢复，下次tick时会正常检测
      restoredCount++;
    }
  }
  console.log(`   恢复了 ${restoredCount} 个市场的挂单状态 (这些市场不会重复挂)\n`);

  // 挂单不占余额，不限制并发数
  console.log(`   无并发限制 (Predict挂单不占余额)\n`);

  // 退出清理
  let running = true;
  const cleanup = async () => {
    if (!running) return;
    running = false;
    console.log("\n🛑 正在撤销所有活跃订单...");
    const activeIds = monitors.filter(m => m.activeOrderId).map(m => m.activeOrderId);
    for (const id of activeIds) {
      await cancelOrder(id);
    }
    console.log(`已撤销 ${activeIds.length} 笔订单`);
    console.log("Bot 已安全退出。");
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

      // 请求间隔
      await sleep(300);
    }

    await sleep(CONFIG.POLL_INTERVAL);
  }
}

main().catch(e => {
  console.error("程序异常:", e);
  process.exit(1);
});
