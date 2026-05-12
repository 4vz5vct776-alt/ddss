/**
 * 做市 Bot v3 - 体育/电竞/FDV专版 (Predict.fun)
 * 
 * 新功能 v3:
 *   - 加强积分检查: 严格检查 category.rewards 和 market.rewards，
 *     没有积分的市场 (如 fl1-rcl-psg-2026-05-13) 不挂
 *   - 对齐 Polymarket 盘口 (仅NBA/MLB): 监控 Polymarket 对应市场的买1,
 *     如果 Polymarket 买1撤单或减少≥30% → 立刻撤掉 predict.fun 的挂单
 * 
 * 原有功能:
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

  // Polymarket API (用于NBA/MLB异动监控)
  POLYMARKET_CLOB_URL: "https://clob.polymarket.com",
  POLYMARKET_GAMMA_URL: "https://gamma-api.polymarket.com",

  // 交易参数
  ORDER_SIZE: 6,          // 每个outcome挂6份额 (Yes挂6, No挂6)
  TICK_SIZE: 0.01,        // (已不用于挂单偏移, 仅用于极端情况保护)

  // 盘口门槛 (买1挂单量低于此值不挂)
  MIN_BID1_FOOTBALL: 4000,
  MIN_BID1_WORLDCUP: 5000,
  MIN_BID1_ESPORTS: 3000,
  MIN_BID1_NBA: 3000,
  MIN_BID1_FDV: 2000,

  // Polymarket 异动监控 (仅用于NBA/MLB)
  POLYMARKET_BID_DROP_PERCENT: 0.3,  // Polymarket买1减少30%触发撤单

  // 异动检测
  BID1_DROP_PERCENT: 0.3,   // 买1减少30%触发撤单
  BID1_MIN_SIZE: 50,        // 买1低于此量触发撤单

  // 时间
  POLL_INTERVAL: 3000,      // 轮询间隔 3秒
  RECOVER_WAIT: 60000,      // 异动后冷却 60秒(1分钟)

  // Telegram
  TELEGRAM_BOT_TOKEN: "8739215233:AAHwG7G60sgOYze9Jo0u-KddtP0UBxDjnKg",
  TELEGRAM_CHAT_ID: "5707621530",
};

// ============ 工具函数 ============

async function sendTelegram(message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text: message, parse_mode: "HTML" }),
      });
      if (resp.ok) {
        console.log("[TG] ✅ 通知发送成功");
        return true;
      }
      const errText = await resp.text();
      console.error(`[TG] 发送失败(${resp.status}): ${errText}`);
    } catch (e) {
      console.error(`[TG] 发送异常(attempt ${attempt + 1}): ${e.message}`);
    }
    if (attempt < 2) await sleep(1000); // 重试前等1秒
  }
  console.error("[TG] ❌ 3次重试都失败!");
  return false;
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
  return date.toISOString().split("T")[0];
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



// ============ 加强积分检查模块 ============

/**
 * 严格检查市场是否有积分奖励
 * 
 * 检查维度:
 *   1. market.rewards.current > 0 (当前积分倍率)
 *   2. market.rewards.schedule 有实际条目且金额>0
 *   3. market.rewardRate / pointsMultiplier / rewardsMultiplier > 0
 *   4. category 级别的 rewards 信息
 *   5. market.hasActiveRewards === true (API直接标记)
 *   6. 排除 rewards 字段完全为空/null/undefined 的情况
 * 
 * 像 fl1-rcl-psg-2026-05-13 这种没积分的市场会被跳过
 */
function hasValidRewards(market, category = null) {
  // === 市场级别检查 ===
  
  // 直接标记字段 (最可靠)
  if (market.hasActiveRewards === true) return true;
  
  // rewards 对象检查
  const rewards = market.rewards;
  if (!rewards || (typeof rewards === "object" && Object.keys(rewards).length === 0)) {
    // rewards 为空/null/undefined/{} → 检查其他字段
  } else if (typeof rewards === "object") {
    // rewards.current 必须是正数
    const currentReward = typeof rewards.current === "number" 
      ? rewards.current 
      : parseFloat(rewards.current || 0);
    if (currentReward > 0) return true;
    
    // rewards.schedule 必须有实际条目且rate>0
    if (Array.isArray(rewards.schedule) && rewards.schedule.length > 0) {
      const hasPositiveRate = rewards.schedule.some(s => {
        const rate = parseFloat(s.rate || s.amount || s.multiplier || 0);
        return rate > 0;
      });
      if (hasPositiveRate) return true;
    }
    
    // rewards.rate 或 rewards.multiplier
    const rewardsRate = parseFloat(rewards.rate || rewards.multiplier || 0);
    if (rewardsRate > 0) return true;
  }
  
  // 市场顶层字段
  const rewardRate = parseFloat(market.rewardRate || 0);
  const pointsMultiplier = parseFloat(market.pointsMultiplier || 0);
  const rewardsMultiplier = parseFloat(market.rewardsMultiplier || 0);
  const pointsRate = parseFloat(market.pointsRate || 0);
  if (rewardRate > 0 || pointsMultiplier > 0 || rewardsMultiplier > 0 || pointsRate > 0) return true;
  
  // === Category 级别检查 (备用) ===
  if (category) {
    const catRewards = category.rewards;
    if (catRewards && typeof catRewards === "object") {
      const catCurrent = typeof catRewards.current === "number"
        ? catRewards.current
        : parseFloat(catRewards.current || 0);
      if (catCurrent > 0) return true;
      
      if (Array.isArray(catRewards.schedule) && catRewards.schedule.length > 0) {
        const hasPositiveRate = catRewards.schedule.some(s => {
          const rate = parseFloat(s.rate || s.amount || s.multiplier || 0);
          return rate > 0;
        });
        if (hasPositiveRate) return true;
      }
    }
    
    // category 顶层字段
    if (category.hasActiveRewards === true) return true;
    const catRewardRate = parseFloat(category.rewardRate || category.pointsMultiplier || 0);
    if (catRewardRate > 0) return true;
  }
  
  // 所有检查都未通过 → 没有积分
  return false;
}

// ============ Polymarket 盘口监控模块 (仅NBA/MLB) ============

/**
 * 通过 slug/关键词搜索 Polymarket 对应市场
 * 返回 token_id 列表
 */
async function searchPolymarketMarket(query) {
  try {
    const url = `${CONFIG.POLYMARKET_GAMMA_URL}/markets`;
    const params = new URLSearchParams({
      active: "true",
      closed: "false",
      _q: query,
      limit: "5",
    });
    const resp = await fetch(`${url}?${params}`, { timeout: 8000 });
    if (!resp.ok) return [];
    const markets = await resp.json();
    return markets || [];
  } catch (e) {
    console.error(`[Polymarket] 搜索失败 (${query}): ${e.message}`);
    return [];
  }
}

/**
 * 获取 Polymarket orderbook
 * @param {string} tokenId - Polymarket token_id
 * @returns {{ bid: number, ask: number, mid: number } | null}
 */
async function getPolymarketOrderbook(tokenId) {
  try {
    const url = `${CONFIG.POLYMARKET_CLOB_URL}/book`;
    const params = new URLSearchParams({ token_id: tokenId });
    const resp = await fetch(`${url}?${params}`, { timeout: 8000 });
    if (!resp.ok) return null;
    const data = await resp.json();
    
    const bids = data.bids || [];
    const asks = data.asks || [];
    
    const bid = bids.length > 0 ? parseFloat(bids[0].price || 0) : 0;
    const ask = asks.length > 0 ? parseFloat(asks[0].price || 1) : 1;
    const mid = (bid + ask) / 2;
    
    return { bid, ask, mid, bids, asks };
  } catch (e) {
    console.error(`[Polymarket] 获取盘口失败 (${tokenId}): ${e.message}`);
    return null;
  }
}

/**
 * 从 category slug 生成 Polymarket 搜索关键词
 * 例: "nba-okc-lal-2026-05-12" → "OKC LAL"
 *     "mlb-nyy-bal-2026-05-12" → "NYY BAL"
 */
function slugToSearchQuery(slug) {
  if (!slug) return null;
  // 移除日期部分
  const cleaned = slug.replace(/\d{4}-\d{2}-\d{2}/, "").replace(/-+$/, "");
  // 移除前缀 (fl1, epl, sra, ucl, nba, mlb etc.)
  const parts = cleaned.split("-").filter(p => p.length > 0);
  if (parts.length <= 1) return null;
  // 跳过第一个 (联赛缩写), 取剩下的队伍缩写
  const teamParts = parts.slice(1).filter(p => p.length >= 2);
  if (teamParts.length === 0) return null;
  return teamParts.join(" ").toUpperCase();
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

    return { bid1Price, bid1Size, ask1Price, hasAsks: asks.length > 0 };
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
  constructor(market, categoryTitle, categorySlug, orderBuilder, minBid1Size, isNBAMLB = false) {
    this.market = market;
    this.orderBuilder = orderBuilder;
    this.marketId = market.id || market.marketId;
    this.marketName = `${(categoryTitle || "").slice(0, 25)} | ${(market.title || market.question || "").slice(0, 20)}`;
    this.categorySlug = categorySlug || "";
    this.minBid1Size = minBid1Size || 5000;
    this.isNBAMLB = isNBAMLB; // 只有 NBA/MLB 才监控 Polymarket

    // 开赛时间 (用于开赛前30分钟撤单)
    this.startsAt = null;
    const catStartsAt = market.startsAt || market.startTime || market.scheduledStartTime || null;
    if (catStartsAt) {
      this.startsAt = new Date(catStartsAt);
    }

    // 状态 - 改为跟踪所有订单
    this.activeOrderIds = [];  // 所有活跃订单ID
    this.lastBid1Size = null;
    this.isCoolingDown = false;
    this.cooldownStart = 0;
    this.hasPlaced = false;    // 是否已经挂过单
    this.isExpired = false;

    // Polymarket 异动检测 (仅NBA/MLB)
    this.polyLastBid1Size = null;
    this.polyTokenId = null;    // Polymarket token_id
    this.polySearched = false;  // 是否已搜索过 Polymarket
  }

  checkAnomaly(book) {
    const currentSize = book.bid1Size;
    if (this.lastBid1Size === null) { this.lastBid1Size = currentSize; return false; }
    if (this.lastBid1Size <= 0) { this.lastBid1Size = currentSize; return false; }

    const dropRatio = (this.lastBid1Size - currentSize) / this.lastBid1Size;
    const tooSmall = currentSize < CONFIG.BID1_MIN_SIZE;
    const isAnomaly = dropRatio >= CONFIG.BID1_DROP_PERCENT || tooSmall;

    if (isAnomaly) {
      console.log(`  ⚠️ [${this.marketName}] predict异动! 买1: ${this.lastBid1Size.toFixed(0)} → ${currentSize.toFixed(0)} (↓${(dropRatio * 100).toFixed(0)}%)`);
    }
    this.lastBid1Size = currentSize;
    return isAnomaly;
  }

  /**
   * 检查 Polymarket 盘口异动 (仅NBA/MLB)
   * 如果 Polymarket 买1撤单或减少≥30% → 返回 true
   */
  async checkPolymarketAnomaly() {
    if (!this.isNBAMLB) return false;
    if (!this.categorySlug) return false;

    // 首次搜索 Polymarket 对应市场
    if (!this.polySearched) {
      this.polySearched = true;
      try {
        const query = slugToSearchQuery(this.categorySlug);
        if (!query) return false;
        const markets = await searchPolymarketMarket(query);
        if (markets.length > 0) {
          const m = markets[0];
          const tokenIds = m.clobTokenIds || [];
          if (tokenIds.length > 0) {
            this.polyTokenId = tokenIds[0];
            console.log(`    🔗 [${this.marketName}] Polymarket对齐: ${m.question || ""} (token=${this.polyTokenId.slice(0,10)}...)`);
          }
        }
      } catch (e) {
        // 搜索失败不影响
      }
    }

    if (!this.polyTokenId) return false;

    // 获取 Polymarket 盘口
    try {
      const book = await getPolymarketOrderbook(this.polyTokenId);
      if (!book) return false;

      const currentBid = book.bid;
      const currentBidSize = book.bids.length > 0 ? parseFloat(book.bids[0].size || 0) : 0;

      // 买1为0 = 全部撤单
      if (currentBid <= 0 || currentBidSize <= 0) {
        if (this.polyLastBid1Size !== null && this.polyLastBid1Size > 0) {
          console.log(`  🚨 [${this.marketName}] Polymarket买1全撤! (${this.polyLastBid1Size.toFixed(0)} → 0)`);
          this.polyLastBid1Size = 0;
          return true;
        }
        this.polyLastBid1Size = 0;
        return false;
      }

      // 首次记录
      if (this.polyLastBid1Size === null) {
        this.polyLastBid1Size = currentBidSize;
        return false;
      }

      // 检测减少≥30%
      if (this.polyLastBid1Size > 0) {
        const dropRatio = (this.polyLastBid1Size - currentBidSize) / this.polyLastBid1Size;
        if (dropRatio >= CONFIG.BID1_DROP_PERCENT) {
          console.log(`  🚨 [${this.marketName}] Polymarket异动! 买1量: ${this.polyLastBid1Size.toFixed(0)} → ${currentBidSize.toFixed(0)} (↓${(dropRatio * 100).toFixed(0)}%)`);
          this.polyLastBid1Size = currentBidSize;
          return true;
        }
      }

      this.polyLastBid1Size = currentBidSize;
      return false;
    } catch (e) {
      return false;
    }
  }

  async cancelAllOrders() {
    if (this.activeOrderIds.length === 0) return;
    let filledCount = 0;
    for (const oid of this.activeOrderIds) {
      const success = await cancelOrder(oid);
      if (!success) filledCount++;
    }
    if (filledCount > 0) {
      console.log(`  🔔 [${this.marketName}] ${filledCount}笔挂单被吃! (撤单失败=已成交)`);
      await sendTelegram(`🔔 <b>挂单被吃!</b>\n\n📊 ${this.marketName}\n📦 ${filledCount}笔成交\n🆔 ${this.activeOrderIds.join(", ")}`);
    }
    this.activeOrderIds = [];
  }

  async placeOrder(book) {
    if (this.hasPlaced) return;

    // 没有卖盘 = 市场已结束，不挂
    if (!book.hasAsks) return;

    // 对每个 outcome 都尝试挂单 (Yes + No 各挂)
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
      let outcomeBidPrice = parseFloat(outcomeBid.price);
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
        if (orderId) {
          this.activeOrderIds.push(orderId);
        }
      } catch (e) {
        console.error(`  ❌ [${this.marketName}] ${outcome.name || ""} 挂单失败: ${e.message}`);
      }
    }
    if (this.activeOrderIds.length > 0) {
      this.hasPlaced = true;
    }
  }

  async tick() {
    if (this.isExpired) return;

    // 开赛前30分钟自动撤单 (NBA/MLB)
    if (this.startsAt) {
      const now = new Date();
      const thirtyMinBefore = new Date(this.startsAt.getTime() - 30 * 60 * 1000);
      if (now >= thirtyMinBefore) {
        if (this.activeOrderIds.length > 0) {
          console.log(`  ⏰ [${this.marketName}] 开赛前30分钟，自动撤单!`);
          await this.cancelAllOrders();
          await sendTelegram(`⏰ <b>开赛前30分钟撤单</b>\n\n📊 ${this.marketName}`);
        }
        this.isExpired = true;
        return;
      }
    }

    // 冷却期
    if (this.isCoolingDown) {
      if (Date.now() - this.cooldownStart < CONFIG.RECOVER_WAIT) return;
      this.isCoolingDown = false;
      this.lastBid1Size = null;
      this.polyLastBid1Size = null;
    }

    // 还没挂单 → 挂单
    if (!this.hasPlaced) {
      const book = await getOrderbook(this.marketId);
      if (!book) return;
      if (!book.hasAsks) { this.isExpired = true; return; }
      await this.placeOrder(book);
      return;
    }

    // 已挂单 → 检查所有订单状态
    if (this.activeOrderIds.length > 0) {
      const stillOpen = [];
      for (const oid of this.activeOrderIds) {
        const status = await getOrderStatus(oid);
        if (status === null) {
          stillOpen.push(oid); // 网络问题，保留
          continue;
        }
        if (status === "OPEN") {
          stillOpen.push(oid);
        } else if (status === "MATCHED" || status === "FILLED" || status === "EXECUTED" || status === "PARTIALLY_FILLED" || status === "CLOSED") {
          // 被吃了! 发通知!
          console.log(`  🔔 [${this.marketName}] 订单被吃! id=${oid}, 状态=${status}`);
          await sendTelegram(`🔔 <b>订单被吃!</b>\n\n📊 ${this.marketName}\n🆔 ${oid}\n📋 ${status}`);
        } else {
          // CANCELLED / EXPIRED / REJECTED / 其他 → 移除
          console.log(`  ℹ️ [${this.marketName}] 订单已失效: id=${oid}, 状态=${status}`);
        }
        await sleep(100);
      }
      this.activeOrderIds = stillOpen;
    }

    // 没有活跃订单了 → 标记完成
    if (this.activeOrderIds.length === 0 && this.hasPlaced) {
      this.isExpired = true;
      return;
    }

    // === Predict.fun 盘口异动检测 ===
    const book = await getOrderbook(this.marketId);
    if (book && this.checkAnomaly(book)) {
      console.log(`  🛡️ [${this.marketName}] predict.fun异动，撤单保护!`);
      await this.cancelAllOrders();
      await sendTelegram(`🛡️ <b>异动撤单!</b>\n\n📊 ${this.marketName}\n📉 predict.fun买1大幅减少`);
      this.isCoolingDown = true;
      this.cooldownStart = Date.now();
      this.hasPlaced = false;
      return;
    }

    // === Polymarket 异动检测 (仅NBA/MLB) ===
    if (this.isNBAMLB && this.activeOrderIds.length > 0) {
      const polyAnomaly = await this.checkPolymarketAnomaly();
      if (polyAnomaly) {
        console.log(`  🛡️ [${this.marketName}] Polymarket异动，撤单保护!`);
        await this.cancelAllOrders();
        await sendTelegram(`🛡️ <b>Polymarket异动撤单!</b>\n\n📊 ${this.marketName}\n📉 Polymarket买1撤单/减少≥30%`);
        this.isCoolingDown = true;
        this.cooldownStart = Date.now();
        this.hasPlaced = false;
        return;
      }
    }
  }
}



// ============ 主函数 ============

async function main() {
  console.log("=".repeat(60));
  console.log("做市 Bot v3 - 体育/电竞专版 (Predict.fun)");
  console.log("  ✨ 加强积分检查 + Polymarket异动监控(NBA/MLB)");
  console.log("=".repeat(60));

  const today = getTodayUTC();
  const tomorrow = getTomorrowUTC();
  console.log(`今天: ${today} | 明天: ${tomorrow}`);
  console.log(`足球: 挂今天+明天的比赛 + 世界杯不限日期`);
  console.log(`电竞: 只挂今天的 CS2/LOL 比赛 (不挂Dota)`);
  console.log(`加密: FDV预测市场全挂 (不限日期)`);
  console.log(`挂单价格: predict买1`);
  console.log(`盘口最低: 足球≥4000 | 世界杯≥5000 | 电竞≥3000 | FDV≥2000`);
  console.log(`🔒 严格积分检查: 无积分的市场一律不挂`);
  console.log(`🔗 Polymarket异动(NBA/MLB): 买1撤单/减少≥30% → 撤单`);
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
  let footballCount = 0, esportsCount = 0, skippedDate = 0, skippedLive = 0, skippedNoPoints = 0;

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
      
      // ✨ 加强积分检查 (v3新增)
      if (!hasValidRewards(m, cat)) {
        const slug = catSlug || m.slug || "";
        console.log(`  🚫 无积分跳过: ${slug} | ${(m.title || m.question || "").slice(0, 30)}`);
        skippedNoPoints++;
        continue;
      }
      
      const mid = m.id || m.marketId;
      if (seenMarketIds.has(mid)) continue;
      seenMarketIds.add(mid);
      monitors.push(new MarketMonitor(m, cat.title || "", catSlug, orderBuilder, isWorldCup ? CONFIG.MIN_BID1_WORLDCUP : CONFIG.MIN_BID1_FOOTBALL, false));
      footballCount++;
    }
  }

  // 电竞/NBA/MLB: 只挂今天的, 挂CS/LOL/NBA/MLB (不挂Dota/板球)
  for (const cat of esportsCategories) {
    const eventDate = getEventDate(cat);
    if (!eventDate || eventDate !== today) { skippedDate++; continue; }

    // 挂 CS2/CSGO、LOL、NBA、MLB, 跳过 Dota/板球等
    const catTitle = (cat.title || "").toLowerCase();
    const catDesc = (cat.description || "").toLowerCase();
    const catSlug = (cat.categorySlug || cat.slug || "").toLowerCase();
    const combined = catTitle + " " + catDesc + " " + catSlug;
    const isCS = combined.includes("cs2") || combined.includes("csgo") || combined.includes("counter-strike");
    const isLoL = combined.includes("lol") || combined.includes("league of legends");
    const isNBA = combined.includes("nba") || combined.includes("basketball");
    const isMLB = combined.includes("mlb") || combined.includes("baseball");
    if (!isCS && !isLoL && !isNBA && !isMLB) { skippedDate++; continue; }

    // NBA/MLB: 根据开赛时间判断，只挂还没开赛的比赛
    if (isNBA || isMLB) {
      const label = isNBA ? "NBA" : "MLB";
      const startsAt = cat.startsAt || cat.startTime || cat.scheduledStartTime || null;
      const endsAt = cat.endsAt || null;
      const now = new Date();

      if (startsAt) {
        const startTime = new Date(startsAt);
        if (now >= startTime) {
          console.log(`  ⏭️ ${label}已开赛: ${cat.title || ""} (开赛: ${startsAt})`);
          skippedLive++;
          continue;
        }
      } else if (endsAt) {
        const endTime = new Date(endsAt);
        if (now >= endTime) {
          console.log(`  ⏭️ ${label}已结束: ${cat.title || ""} (结束: ${endsAt})`);
          skippedLive++;
          continue;
        }
      }
    }

    const markets = cat.markets || [];
    for (const m of markets) {
      // 严格排除LIVE和非OPEN的市场
      const tStatus = (m.tradingStatus || "").toUpperCase();
      const mStatus = (m.status || "").toUpperCase();
      const mState = (m.state || "").toUpperCase();
      if (tStatus !== "OPEN" || mStatus === "LIVE" || mState === "LIVE" || m.isLive === true) { skippedLive++; continue; }
      
      // ✨ 加强积分检查 (v3新增)
      if (!hasValidRewards(m, cat)) {
        const slug = catSlug || m.slug || "";
        console.log(`  🚫 无积分跳过: ${slug} | ${(m.title || m.question || "").slice(0, 30)}`);
        skippedNoPoints++;
        continue;
      }
      
      const mid = m.id || m.marketId;
      if (seenMarketIds.has(mid)) continue;
      seenMarketIds.add(mid);
      monitors.push(new MarketMonitor(m, cat.title || "", catSlug, orderBuilder, isNBA ? CONFIG.MIN_BID1_NBA : CONFIG.MIN_BID1_ESPORTS, isNBA || isMLB));
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
      
      // ✨ 加强积分检查 (v3新增)
      if (!hasValidRewards(m, cat)) {
        const slug = catSlug || m.slug || "";
        console.log(`  🚫 无积分跳过: ${slug} | ${(m.title || m.question || "").slice(0, 30)}`);
        skippedNoPoints++;
        continue;
      }
      
      const mid = m.id || m.marketId;
      if (seenMarketIds.has(mid)) continue;
      seenMarketIds.add(mid);
      monitors.push(new MarketMonitor(m, cat.title || "", catSlug, orderBuilder, CONFIG.MIN_BID1_FDV, false));
      fdvCount++;
    }
  }

  console.log(`\n✅ 共 ${monitors.length} 个市场待挂单`);
  console.log(`   足球(今天+明天): ${footballCount} | 电竞CS/LOL+NBA/MLB(今天): ${esportsCount} | 加密FDV: ${fdvCount}`);
  console.log(`   跳过: ${skippedDate}非目标日期 + ${skippedLive}非OPEN + ${skippedNoPoints}无积分`);

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
      monitor.activeOrderIds = [...marketOrders];
      monitor.hasPlaced = true;
      restoredCount += marketOrders.length;
    }
  }
  console.log(`   恢复 ${restoredCount} 笔已有挂单\n`);

  // 退出清理
  let running = true;
  const cleanup = async () => {
    if (!running) return;
    running = false;
    console.log("\n🛑 正在撤销所有活跃订单...");
    let totalCancelled = 0;
    for (const m of monitors) {
      for (const id of m.activeOrderIds) {
        await cancelOrder(id);
        totalCancelled++;
      }
    }
    console.log(`已撤销 ${totalCancelled} 笔订单`);
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
