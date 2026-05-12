"""
批量快速挂单脚本 - Predict.fun 有星星的市场
功能:
  - 获取所有有星星(有奖励积分)的市场
  - 体育比赛: 未开赛且距开赛>30分钟 → 挂单; 已开赛或<30分钟 → 跳过
  - 每个市场以买1价格挂10份额
  - 总预算控制30U
  - 买1买2数量级匹配检查

使用:
  python3 batch_order.py
"""

import requests
import logging
import time
import re
from datetime import datetime, timedelta, timezone

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

        # 检查标题中是否有 "LIVE" 标记
        title = market.get("title", "") or market.get("question", "")
        if "[LIVE]" in title or "(LIVE)" in title:
            return True

        return False

    def parse_event_start_time(self, market):
        """
        从市场的 description 或 categorySlug 解析开赛时间
        返回 datetime (UTC) 或 None
        
        支持格式:
          - description 中: "scheduled for May 5 at 7:45PM ET"
          - categorySlug 中: "mlb-col-pit-2026-05-12" (只有日期，无具体时间)
        """
        desc = market.get("description", "") or ""
        cat = market.get("categorySlug", "") or ""
        
        # 方法1: 从 description 解析 "scheduled for May 12 at 7:05PM ET"
        # 或 "initially scheduled for May 14 at 11:00AM ET"
        pattern = r'scheduled for (\w+ \d+)(?: at (\d+:\d+(?:AM|PM)) ET)?'
        match = re.search(pattern, desc, re.IGNORECASE)
        if match:
            date_str = match.group(1)  # "May 12"
            time_str = match.group(2)  # "7:05PM" 或 None
            
            # 从 categorySlug 中取年份
            year_match = re.search(r'(\d{4})-(\d{2})-(\d{2})$', cat)
            if year_match:
                year = int(year_match.group(1))
            else:
                year = datetime.now().year
            
            try:
                if time_str:
                    dt_str = f"{date_str} {year} {time_str}"
                    dt = datetime.strptime(dt_str, "%B %d %Y %I:%M%p")
                else:
                    dt_str = f"{date_str} {year}"
                    dt = datetime.strptime(dt_str, "%B %d %Y")
                
                # ET = UTC-4 (EDT) 或 UTC-5 (EST)，5月份是 EDT (UTC-4)
                et_offset = timedelta(hours=-4)
                dt_utc = dt - et_offset  # 转为 UTC
                return dt_utc
            except ValueError:
                pass
        
        # 方法2: 从 categorySlug 解析日期 (无具体时间，默认当天 23:59 ET)
        date_match = re.search(r'(\d{4})-(\d{2})-(\d{2})$', cat)
        if date_match:
            try:
                year = int(date_match.group(1))
                month = int(date_match.group(2))
                day = int(date_match.group(3))
                # 没有具体时间，不做开赛前30分钟撤单（因为不知道具体时间）
                return None
            except ValueError:
                pass
        
        return None

    def should_skip_sports_market(self, market):
        """
        体育比赛市场是否应该跳过:
        - 已开赛(LIVE) → 跳过
        - 距开赛 ≤ 30分钟 → 跳过
        - 距开赛 > 30分钟 → 不跳过(可以挂)
        - 无法解析开赛时间 → 不跳过(可以挂)
        
        返回: (should_skip: bool, reason: str)
        """
        # 先检查是否已经 LIVE
        if self.is_live_event(market):
            return True, "已开赛"
        
        # 解析开赛时间
        start_time = self.parse_event_start_time(market)
        if start_time is None:
            # 无法解析开赛时间，允许挂单
            return False, ""
        
        now_utc = datetime.utcnow()
        time_to_start = start_time - now_utc
        minutes_to_start = time_to_start.total_seconds() / 60
        
        if minutes_to_start <= 0:
            return True, "已开赛"
        elif minutes_to_start <= 30:
            return True, f"距开赛仅{minutes_to_start:.0f}分钟(<30min)"
        else:
            return False, ""

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

    def _parse_bid(self, bid):
        """解析单个 bid 的价格和数量"""
        if isinstance(bid, dict):
            price = float(bid.get("price", 0))
            size = float(bid.get("size", 0))
        elif isinstance(bid, list):
            price = float(bid[0])
            size = float(bid[1]) if len(bid) > 1 else 0
        else:
            price = float(bid)
            size = 0
        return price, size

    def check_magnitude_match(self, bid1_size, bid2_size):
        """
        买1买2数量级匹配检查:
        - 买2≥10000 则买1也要≥10000
        - 买2≥1000 则买1也要≥1000
        - 买2≥100 则买1也要≥100
        - 买2≥10 则买1也要≥10
        - 以此类推
        不匹配则返回 False（不挂单）
        """
        # 从大到小检查数量级
        thresholds = [10000, 1000, 100, 10]
        for threshold in thresholds:
            if bid2_size >= threshold:
                if bid1_size < threshold:
                    logger.warning(
                        f"  ⚠️ 买1买2数量级不匹配! "
                        f"买2={bid2_size:.0f}≥{threshold}, "
                        f"但买1={bid1_size:.0f}<{threshold}, 跳过"
                    )
                    return False
                return True
        # 买2 < 10，不做限制
        return True

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
                bid1_price, bid1_size = self._parse_bid(bids[0])

                # 解析买2
                bid2_size = 0
                if len(bids) > 1:
                    _, bid2_size = self._parse_bid(bids[1])

                return {
                    "bid1_price": bid1_price,
                    "bid1_size": bid1_size,
                    "bid2_size": bid2_size,
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
        - 每个市场买1挂10份额
        - 总预算30U
        """
        logger.info("=" * 50)
        logger.info("Predict.fun 批量挂单 (30U 测试)")
        logger.info(f"每笔份额: {ORDER_SIZE}")
        logger.info(f"总预算: {TOTAL_BUDGET} USDB")
        logger.info(f"只挂有星星的: {ONLY_WITH_REWARDS}")
        logger.info(f"跳过进行中: {SKIP_LIVE_EVENTS}")
        logger.info("=" * 50)

        # 1. 获取市场
        markets = self.get_markets()
        if not markets:
            logger.error("没有找到可交易的市场!")
            return

        success_count = 0
        fail_count = 0
        skip_count = 0

        # 2. 逐个市场处理
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

            # 过滤: 跳过已开始的比赛 / 开赛前30分钟内的比赛
            market_variant = market.get("marketVariant", "")
            is_sports = market_variant in ["SPORTS_MATCH", "SPORTS_TEAM_MATCH"]
            
            if is_sports:
                should_skip, skip_reason = self.should_skip_sports_market(market)
                if should_skip:
                    logger.info(f"[{i}] ⏭️ 跳过({skip_reason}): {market_name}")
                    skip_count += 1
                    continue
            elif SKIP_LIVE_EVENTS and self.is_live_event(market):
                logger.info(f"[{i}] ⏭️ 跳过(进行中): {market_name}")
                skip_count += 1
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
            bid2_size = book.get("bid2_size", 0)
            logger.info(f"  买1: {bid1_price:.4f} (量={bid1_size:.0f}), 买2量={bid2_size:.0f}")

            # 买1买2数量级匹配检查
            if not self.check_magnitude_match(bid1_size, bid2_size):
                skip_count += 1
                continue

            # 计算这笔单花多少钱
            cost = bid1_price * ORDER_SIZE
            if self.total_spent + cost > TOTAL_BUDGET:
                logger.info(f"  跳过: 预算不足 (剩余{TOTAL_BUDGET - self.total_spent:.2f})")
                break

            # 挂单
            result = self.create_order(
                market_id=market_id,
                side="BUY",
                price=bid1_price,
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

        # 3. 汇总
        logger.info("\n" + "=" * 50)
        logger.info(f"批量挂单完成!")
        logger.info(f"✅ 成功: {success_count} 笔")
        logger.info(f"❌ 失败: {fail_count} 笔")
        logger.info(f"⏭️ 跳过: {skip_count} 笔")
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
