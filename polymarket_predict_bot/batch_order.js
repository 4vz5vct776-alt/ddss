/**
 * 批量快速挂单脚本 - Predict.fun 有星星的市场
 * 
 * 功能:
 *   - 获取所有有星星(有奖励积分)的市场
 *   - 跳过已经开始/进行中的比赛
 *   - 每个市场以买1价格挂10份额
 *   - 总预算控制30U
 *   - 成交后 Telegram 通知
 * 
 * 使用:
 *   1. npm install
 *   2. 编辑下方配置
 *   3. node batch_order.js
 */

import { Wallet } from "ethers";
import { OrderBuilder, ChainId, Side } from "@predictdotfun/sdk";

// ============ 配置 ============
const CONFIG = {
  // 你的钱包私钥 (从 MetaMask 导出, 不要分享给任何人!)
  PRIVATE_KEY: "YOUR_PRIVATE_KEY_HERE",

  // Predict.fun API Key (UUID格式)
  API_KEY: "5f623dc1-147a-4767-8795-cf02f1f25149",

  // Predict.fun JWT Token (从浏览器获取)
  JWT_TOKEN: "YOUR_JWT_TOKEN_HERE",

  // API URL
  API_URL: "https://api.predict.fun",

  // 交易参数
  TOTAL_BUDGET: 30.0,     // 总预算 30 USDB
  ORDER_SIZE: 10,         // 每个市场挂 10 份额
  SIDE: Side.BUY,         // 买入方向 (0=BUY, 1=SELL)

  // 过滤
  ONLY_WITH_REWARDS: true,  // 只挂有星星的
  SKIP_LIVE_EVENTS: true,   // 跳过进行中的比赛

  // Telegram 通知
  TELEGRAM_BOT_TOKEN: "8739215233:AAHwG7G60sgOYze9Jo0u-KddtP0UBxDjnKg",
  TELEGRAM_CHAT_ID: "5707621530",
};

// ============ 工具函数 ============

async function sendTelegram(message) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || CONFIG.TELEGRAM_BOT_TOKEN === "YOUR_TELEGRAM_BOT_TOKEN_HERE") return;
  try {
    const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text: message, parse_mode: "HTML" }),
    });
    if (resp.ok) console.log("[通知] Telegram 发送成功");
  } catch (e) {
    console.error("[通知] Telegram 发送失败:", e.message);
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

// ============ 获取市场 ============

async function getMarkets() {
  const params = new URLSearchParams({
    status: "OPEN",
    first: "100",
    hasActiveRewards: "true",
  });
  const data = await fetchAPI(`/v1/markets?${params}`);
  return data.data || [];
}

// ============ 获取盘口 ============

async function getOrderbook(marketId) {
  const data = await fetchAPI(`/v1/markets/${marketId}/orderbook`);
  const orderbook = data.data || data;
  const bids = orderbook.bids || [];
  if (bids.length === 0) return null;

  const firstBid = bids[0];
  let price, size;
  if (Array.isArray(firstBid)) {
    price = parseFloat(firstBid[0]);
    size = parseFloat(firstBid[1] || 0);
  } else if (typeof firstBid === "object") {
    price = parseFloat(firstBid.price || 0);
    size = parseFloat(firstBid.size || 0);
  } else {
    price = parseFloat(firstBid);
    size = 0;
  }
  return { price, size };
}

// ============ 判断是否进行中 ============

function isLiveEvent(market) {
  const status = typeof market.tradingStatus === "object"
    ? market.tradingStatus?.status || ""
    : market.tradingStatus || "";
  const liveStatuses = ["LIVE", "IN_PROGRESS", "STARTED", "HALTED"];
  if (liveStatuses.includes(status.toUpperCase())) return true;

  const title = market.title || market.question || "";
  if (title.includes("[LIVE]") || title.includes("(LIVE)")) return true;

  return false;
}

// ============ 判断是否有星星 ============

function hasRewards(market) {
  const rewards = market.rewards;
  if (!rewards) return false;
  if (rewards.current || (rewards.schedule && rewards.schedule.length > 0)) return true;
  return false;
}

// ============ 获取 tokenId ============

function getTokenId(market) {
  // 从 market outcomes 获取 Yes 的 tokenId
  const outcomes = market.outcomes || [];
  for (const outcome of outcomes) {
    if (typeof outcome === "object") {
      // 可能的字段名: tokenId, id, onChainId, token_id
      const tid = outcome.tokenId || outcome.onChainId || outcome.token_id || outcome.id;
      if (tid) return String(tid);
    } else if (typeof outcome === "string") {
      return outcome;
    }
  }
  // 从 conditionId 获取
  if (market.conditionId) return market.conditionId;
  // 从 oracleQuestionId 获取
  if (market.oracleQuestionId) return market.oracleQuestionId;
  return null;
}

// 调试: 打印第一个市场的完整数据结构
function debugMarket(market) {
  console.log("\n[DEBUG] 市场数据结构:");
  console.log("  id:", market.id);
  console.log("  title:", market.title);
  console.log("  conditionId:", market.conditionId);
  console.log("  oracleQuestionId:", market.oracleQuestionId);
  console.log("  outcomes:", JSON.stringify(market.outcomes, null, 2));
  console.log("  isNegRisk:", market.isNegRisk);
  console.log("  isYieldBearing:", market.isYieldBearing);
  console.log("  feeRateBps:", market.feeRateBps);
}

// ============ 主函数 ============

async function main() {
  console.log("=".repeat(50));
  console.log("Predict.fun 批量挂单 (Node.js + 官方SDK)");
  console.log(`预算: ${CONFIG.TOTAL_BUDGET} USDB`);
  console.log(`每笔: ${CONFIG.ORDER_SIZE} 份额`);
  console.log(`只挂有星星: ${CONFIG.ONLY_WITH_REWARDS}`);
  console.log(`跳过进行中: ${CONFIG.SKIP_LIVE_EVENTS}`);
  console.log("=".repeat(50));

  // 检查私钥
  if (CONFIG.PRIVATE_KEY === "YOUR_PRIVATE_KEY_HERE") {
    console.error("\n⚠️  请在 batch_order.js 顶部 CONFIG 中填入你的钱包私钥!");
    console.error("从 MetaMask → 账户详情 → 显示私钥 获取");
    return;
  }

  // 初始化钱包和 OrderBuilder
  console.log("\n初始化钱包和 SDK...");
  const signer = new Wallet(CONFIG.PRIVATE_KEY);
  console.log(`钱包地址: ${signer.address}`);

  const orderBuilder = await OrderBuilder.make(ChainId.BnbMainnet, signer);
  console.log("SDK 初始化成功!");

  // 设置 approvals (首次需要, 之后可以跳过)
  console.log("\n检查/设置 approvals...");
  try {
    const approvalResult = await orderBuilder.setApprovals();
    if (approvalResult.success) {
      console.log("Approvals 已设置!");
    } else {
      console.warn("Approvals 设置失败, 可能已经设置过了, 继续...");
    }
  } catch (e) {
    console.warn("Approvals 检查异常 (可能已设置):", e.message);
  }

  // 获取市场列表
  console.log("\n获取市场列表...");
  const markets = await getMarkets();
  console.log(`获取到 ${markets.length} 个市场`);

  let totalSpent = 0;
  let successCount = 0;
  let failCount = 0;
  let skipCount = 0;

  // 逐个市场处理
  // 先调试打印第一个市场数据
  if (markets.length > 0) {
    debugMarket(markets[0]);
  }

  for (let i = 0; i < markets.length; i++) {
    const market = markets[i];

    // 预算检查
    if (totalSpent >= CONFIG.TOTAL_BUDGET) {
      console.log(`\n💰 已达预算上限 ${CONFIG.TOTAL_BUDGET} USDB, 停止`);
      break;
    }

    const marketId = market.id || market.marketId;
    const marketName = market.title || market.question || `Market #${marketId}`;

    // 过滤: 只挂有星星的
    if (CONFIG.ONLY_WITH_REWARDS && !hasRewards(market)) continue;

    // 过滤: 跳过进行中
    if (CONFIG.SKIP_LIVE_EVENTS && isLiveEvent(market)) {
      console.log(`[${i + 1}] ⏭️ 跳过(进行中): ${marketName}`);
      skipCount++;
      continue;
    }

    console.log(`\n[${i + 1}] ${marketName}`);

    // 获取盘口
    let book;
    try {
      book = await getOrderbook(marketId);
    } catch (e) {
      console.warn(`  获取盘口失败: ${e.message}`);
      skipCount++;
      continue;
    }

    if (!book || book.price <= 0) {
      console.log("  跳过: 没有买盘");
      skipCount++;
      continue;
    }

    console.log(`  买1: ${book.price.toFixed(4)} (量=${book.size.toFixed(2)})`);

    // 计算花费
    const cost = book.price * CONFIG.ORDER_SIZE;
    if (totalSpent + cost > CONFIG.TOTAL_BUDGET) {
      console.log(`  跳过: 预算不足 (剩余${(CONFIG.TOTAL_BUDGET - totalSpent).toFixed(2)})`);
      break;
    }

    // 获取 tokenId
    const tokenId = getTokenId(market);
    if (!tokenId) {
      console.log("  跳过: 没有 tokenId");
      skipCount++;
      continue;
    }

    // 构建并签名订单
    try {
      const priceWei = BigInt(Math.floor(book.price * 1e18));
      const quantityWei = BigInt(CONFIG.ORDER_SIZE) * BigInt(1e18);

      const { makerAmount, takerAmount, pricePerShare } = orderBuilder.getLimitOrderAmounts({
        side: CONFIG.SIDE,
        pricePerShareWei: priceWei,
        quantityWei: quantityWei,
      });

      const order = orderBuilder.buildOrder("LIMIT", {
        maker: signer.address,
        signer: signer.address,
        side: CONFIG.SIDE,
        tokenId: tokenId,
        makerAmount,
        takerAmount,
        nonce: 0n,
        feeRateBps: market.feeRateBps || 0,
      });

      const isNegRisk = market.isNegRisk || false;
      const isYieldBearing = market.isYieldBearing || false;

      const typedData = orderBuilder.buildTypedData(order, { isNegRisk, isYieldBearing });
      const signedOrder = await orderBuilder.signTypedDataOrder(typedData);
      const hash = orderBuilder.buildTypedDataHash(typedData);

      // 提交到 API (需要将 BigInt 转为 string)
      const serializableOrder = {};
      for (const [key, value] of Object.entries(signedOrder)) {
        serializableOrder[key] = typeof value === "bigint" ? value.toString() : value;
      }
      serializableOrder.hash = hash;

      const createOrderBody = {
        data: {
          order: serializableOrder,
          pricePerShare: typeof pricePerShare === "bigint" ? pricePerShare.toString() : pricePerShare,
          strategy: "LIMIT",
        },
      };

      const result = await fetchAPI("/v1/orders", {
        method: "POST",
        body: JSON.stringify(createOrderBody),
      });

      console.log(`  ✅ 挂单成功! orderId=${result.data?.orderId || "ok"}`);
      successCount++;
      totalSpent += cost;
      console.log(`  花费: ${cost.toFixed(2)} USDB (累计: ${totalSpent.toFixed(2)}/${CONFIG.TOTAL_BUDGET})`);

      // Telegram 通知
      await sendTelegram(
        `✅ <b>挂单成功</b>\n市场: ${marketName}\n价格: ${book.price.toFixed(4)}\n数量: ${CONFIG.ORDER_SIZE}\n花费: ${cost.toFixed(2)} USDB`
      );

    } catch (e) {
      console.error(`  ❌ 挂单失败: ${e.message}`);
      failCount++;
    }

    // 控制速度
    await new Promise(r => setTimeout(r, 500));
  }

  // 汇总
  console.log("\n" + "=".repeat(50));
  console.log("批量挂单完成!");
  console.log(`✅ 成功: ${successCount} 笔`);
  console.log(`❌ 失败: ${failCount} 笔`);
  console.log(`⏭️ 跳过: ${skipCount} 笔`);
  console.log(`💰 总花费: ${totalSpent.toFixed(2)} USDB`);
  console.log("=".repeat(50));

  // 总结通知
  if (successCount > 0) {
    await sendTelegram(
      `📊 <b>批量挂单完成</b>\n✅ 成功: ${successCount}\n❌ 失败: ${failCount}\n💰 花费: ${totalSpent.toFixed(2)} USDB`
    );
  }
}

main().catch(e => {
  console.error("程序异常:", e);
  process.exit(1);
});
