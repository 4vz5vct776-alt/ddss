"""
批量快速挂单脚本 - Predict.fun 有星星的市场
功能:
  - 获取所有有星星(有奖励积分)的市场
  - 跳过已经开始/进行中的比赛
  - 跳过已有活跃挂单的市场 (防重复挂)
  - 每个市场以买1价格 - 1tick 挂单 (防吃单, 确保maker)
  - 总预算控制30U

使用:
  python3 batch_order.py
"""

import requests
import logging
import time

from config import (
    PREDICT_API_URL,
    PREDICT_API_KEY,
    ORDER_SIZE,
    TOTAL_BUDGET,
    ONLY_WITH_REWARDS,
    SKIP_LIVE_EVENTS,
)

# 尝试导入 JWT Token (挂单用)
try:
    from config import PREDICT_JWT_TOKEN
except ImportError:
    PREDICT_JWT_TOKEN = ""

# Maker保护: 挂单价格 = 买1 - TICK_SIZE, 确保不会吃单
TICK_SIZE = 0.001

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)


class PredictBatchTrader:
    """Predict.fun 批量挂单"""

    def __init__(self):
        self.base_url = PREDICT_API_URL
        # 读取用 session (x-api-key)
        self.session = requests.Session()
        self.session.headers.update({
            "Content-Type": "application/json",
            "x-api-key": PREDICT_API_KEY,
        })
        # 挂单用 session (Bearer JWT)
        jwt = PREDICT_JWT_TOKEN if PREDICT_JWT_TOKEN and PREDICT_JWT_TOKEN != "YOUR_JWT_TOKEN_HERE" else PREDICT_API_KEY
        self.order_session = requests.Session()
        self.order_session.headers.update({
            "Authorization": f"Bearer {jwt}",
            "Content-Type": "application/json",
            "x-api-key": PREDICT_API_KEY,
        })
        self.total_spent = 0.0

    def get_markets(self):
        """
        获取市场列表
        API: GET /v1/markets
        """
        url = f"{self.base_url}/v1/markets"
        params = {
            "status": "OPEN",
            "first": 100,
        }
        if ONLY_WITH_REWARDS:
            params["hasActiveRewards"] = "true"

        try:
            resp = self.session.get(url, params=params, timeout=10)
            resp.raise_for_status()
            data = resp.json()

            markets = data.get("data", [])
            if not markets:
                markets = data if isinstance(data, list) else []

            logger.info(f"获取到 {len(markets)} 个市场")
            return markets

        except requests.exceptions.RequestException as e:
            logger.error(f"获取市场列表失败: {e}")
            if hasattr(e, "response") and e.response is not None:
                logger.error(f"响应: {e.response.text}")
            return []

    def is_live_event(self, market):
        """
        判断市场是否已经开始/进行中
        跳过正在比赛中的事件
        """
        # 检查 tradingStatus
        trading_status = market.get("tradingStatus", "")
        if isinstance(trading_status, dict):
            trading_status = trading_status.get("status", "")

        # 常见的进行中状态
        live_statuses = ["LIVE", "IN_PROGRESS", "STARTED", "HALTED"]
        if str(trading_status).upper() in live_statuses:
            return True

        # 检查 marketVariant 中的比赛信息
        variant = market.get("marketVariant", {})
        if isinstance(variant, dict):
            variant_type = variant.get("type", "")
            if variant_type in ["SPORTS_MATCH", "SPORTS_TEAM_MATCH"]:
                # 体育比赛，检查是否已开始
                variant_data = market.get("variantData", {})
                if isinstance(variant_data, dict):
                    status = variant_data.get("matchStatus", "")
                    if status.upper() in live_statuses:
                        return True

        # 检查标题中是否有 "LIVE" 标记
        title = market.get("title", "") or market.get("question", "")
        if "[LIVE]" in title or "(LIVE)" in title:
            return True

        return False

    def has_rewards(self, market):
        """判断市场是否有星星(奖励积分)"""
        rewards = market.get("rewards")
        if rewards is None:
            return False
        if isinstance(rewards, dict):
            current = rewards.get("current")
            schedule = rewards.get("schedule", [])
            return current is not None or len(schedule) > 0
        return True

    def get_open_orders(self):
        """
        获取当前所有未成交的挂单
        返回: {market_id: [orders]} 的字典, 用于去重
        """
        url = f"{self.base_url}/v1/orders"
        params = {"status": "OPEN", "first": 100}

        try:
            resp = self.order_session.get(url, params=params, timeout=10)
            resp.raise_for_status()
            data = resp.json()
            orders = data.get("data", [])
            if not orders:
                orders = data if isinstance(data, list) else []

            # 按 marketId 分组
            orders_by_market = {}
            for o in orders:
                mid = (
                    o.get("marketId")
                    or o.get("market_id")
                    or (o.get("order", {}) or {}).get("marketId")
                )
                if mid:
                    orders_by_market.setdefault(mid, []).append(o)

            logger.info(f"当前有 {len(orders)} 笔活跃挂单, 覆盖 {len(orders_by_market)} 个市场")
            return orders_by_market

        except requests.exceptions.RequestException as e:
            logger.error(f"获取活跃订单失败: {e}")
            return {}

    def get_market_orderbook(self, market_id):
        """
        获取指定市场的盘口
        API: GET /v1/markets/{id}/orderbook
        """
        url = f"{self.base_url}/v1/markets/{market_id}/orderbook"

        try:
            resp = self.session.get(url, timeout=10)
            resp.raise_for_status()
            data = resp.json()

            orderbook = data.get("data", data)
            bids = orderbook.get("bids", [])

            if bids:
                first_bid = bids[0]
                if isinstance(first_bid, dict):
                    bid1_price = float(first_bid.get("price", 0))
                    bid1_size = float(first_bid.get("size", 0))
                elif isinstance(first_bid, list):
                    bid1_price = float(first_bid[0])
                    bid1_size = float(first_bid[1]) if len(first_bid) > 1 else 0
                else:
                    bid1_price = float(first_bid)
                    bid1_size = 0

                return {
                    "bid1_price": bid1_price,
                    "bid1_size": bid1_size,
                    "bids": bids,
                }
            else:
                return None

        except requests.exceptions.RequestException as e:
            logger.error(f"获取盘口失败 (market_id={market_id}): {e}")
            return None
        except (IndexError, ValueError, TypeError) as e:
            logger.error(f"解析盘口失败 (market_id={market_id}): {e}")
            return None

    def create_order(self, market_id, side, price, size):
        """
        创建限价单
        API: POST /v1/orders
        使用 JWT Token 认证
        """
        url = f"{self.base_url}/v1/orders"

        payload = {
            "marketId": market_id,
            "side": side,
            "price": str(round(price, 4)),
            "size": str(round(size, 2)),
            "strategy": "LIMIT",
        }

        try:
            resp = self.order_session.post(url, json=payload, timeout=10)
            resp.raise_for_status()
            order = resp.json()
            logger.info(
                f"  ✅ 挂单成功: {side} @ {price:.4f} x {size}"
            )
            return order
        except requests.exceptions.RequestException as e:
            logger.error(f"  ❌ 挂单失败: {e}")
            if hasattr(e, "response") and e.response is not None:
                logger.error(f"  响应: {e.response.text}")
            return None

    def batch_place_orders(self):
        """
        批量挂单:
        - 只挂有星星的市场
        - 跳过已开始的比赛
        - 跳过已有活跃挂单的市场 (防重复)
        - 挂单价格 = 买1 - 1tick (防吃单, 确保maker)
        - 总预算30U
        """
        logger.info("=" * 50)
        logger.info("Predict.fun 批量挂单 (防重复 + 防吃单)")
        logger.info(f"每笔份额: {ORDER_SIZE}")
        logger.info(f"总预算: {TOTAL_BUDGET} USDB")
        logger.info(f"只挂有星星的: {ONLY_WITH_REWARDS}")
        logger.info(f"跳过进行中: {SKIP_LIVE_EVENTS}")
        logger.info(f"Maker保护: 买1 - {TICK_SIZE} (防吃单)")
        logger.info("=" * 50)

        # 1. 获取当前活跃挂单 (用于去重)
        existing_orders = self.get_open_orders()

        # 2. 获取市场
        markets = self.get_markets()
        if not markets:
            logger.error("没有找到可交易的市场!")
            return

        success_count = 0
        fail_count = 0
        skip_count = 0
        dedup_count = 0

        # 3. 逐个市场处理
        for i, market in enumerate(markets, 1):
            # 检查预算
            if self.total_spent >= TOTAL_BUDGET:
                logger.info(f"\n💰 已达到预算上限 {TOTAL_BUDGET} USDB，停止挂单")
                break

            market_id = market.get("id") or market.get("marketId")
            market_name = (
                market.get("title")
                or market.get("question")
                or market.get("name")
                or f"Market #{market_id}"
            )

            # 过滤: 只挂有星星的
            if ONLY_WITH_REWARDS and not self.has_rewards(market):
                continue

            # 过滤: 跳过已开始的比赛
            if SKIP_LIVE_EVENTS and self.is_live_event(market):
                logger.info(f"[{i}] ⏭️ 跳过(进行中): {market_name}")
                skip_count += 1
                continue

            # 过滤: 跳过已有活跃挂单的市场 (防重复挂单)
            if market_id and market_id in existing_orders:
                logger.info(f"[{i}] 🔁 跳过(已有挂单): {market_name}")
                dedup_count += 1
                continue

            logger.info(f"\n[{i}] {market_name}")

            # 获取盘口
            book = self.get_market_orderbook(market_id)
            if book is None or book["bid1_price"] <= 0:
                logger.warning(f"  跳过: 没有买盘")
                skip_count += 1
                continue

            bid1_price = book["bid1_price"]
            bid1_size = book["bid1_size"]
            logger.info(f"  买1: {bid1_price:.4f} (量={bid1_size:.2f})")

            # ===== 防吃单: 挂单价格 = 买1 - 1 tick =====
            # 这样确保我们的订单在买1后面排队, 不会立刻成交变成taker
            order_price = round(bid1_price - TICK_SIZE, 4)
            if order_price <= 0:
                logger.warning(f"  跳过: 买1价格太低, 减tick后<=0")
                skip_count += 1
                continue
            logger.info(f"  挂单价: {order_price:.4f} (买1 - {TICK_SIZE}, maker保护)")

            # 计算这笔单花多少钱 (用实际挂单价格计算)
            cost = order_price * ORDER_SIZE
            if self.total_spent + cost > TOTAL_BUDGET:
                logger.info(f"  跳过: 预算不足 (剩余{TOTAL_BUDGET - self.total_spent:.2f})")
                break

            # 挂单 (用 order_price 而非 bid1_price)
            result = self.create_order(
                market_id=market_id,
                side="BUY",
                price=order_price,
                size=ORDER_SIZE,
            )

            if result:
                success_count += 1
                self.total_spent += cost
                logger.info(f"  花费: {cost:.2f} USDB (累计: {self.total_spent:.2f}/{TOTAL_BUDGET})")
            else:
                fail_count += 1

            # 控制速度
            time.sleep(0.5)

        # 4. 汇总
        logger.info("\n" + "=" * 50)
        logger.info(f"批量挂单完成!")
        logger.info(f"✅ 成功: {success_count} 笔")
        logger.info(f"❌ 失败: {fail_count} 笔")
        logger.info(f"⏭️ 跳过: {skip_count} 笔")
        logger.info(f"🔁 去重跳过: {dedup_count} 笔")
        logger.info(f"💰 总花费: {self.total_spent:.2f} USDB")
        logger.info("=" * 50)


def main():
    if PREDICT_API_KEY == "YOUR_PREDICT_FUN_JWT_TOKEN_HERE":
        print("\n⚠️  请先配置 config.py 中的 PREDICT_API_KEY!")
        return

    trader = PredictBatchTrader()
    trader.batch_place_orders()


if __name__ == "__main__":
    main()
