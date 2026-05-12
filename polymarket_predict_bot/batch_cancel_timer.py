"""
开赛前30分钟自动撤单守护脚本
功能:
  - 持续监控已挂单的体育比赛市场
  - 当距离开赛 ≤ 30分钟时，自动撤销该市场的挂单
  - 所有体育比赛都撤完后自动退出

使用:
  python3 batch_cancel_timer.py

建议: 挂单后台运行此脚本
  nohup python3 batch_cancel_timer.py > cancel_timer.log 2>&1 &
"""

import requests
import logging
import time
import re
import signal
from datetime import datetime, timedelta

from config import (
    PREDICT_API_URL,
    PREDICT_API_KEY,
)

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

# 开赛前多少分钟撤单
CANCEL_BEFORE_MINUTES = 30
# 检查间隔(秒)
CHECK_INTERVAL = 60

running = True


def signal_handler(sig, frame):
    global running
    logger.info("收到退出信号, 停止监控...")
    running = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


class CancelTimer:
    """开赛前自动撤单"""

    def __init__(self):
        self.base_url = PREDICT_API_URL
        jwt = PREDICT_JWT_TOKEN if PREDICT_JWT_TOKEN and PREDICT_JWT_TOKEN != "YOUR_JWT_TOKEN_HERE" else PREDICT_API_KEY
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Bearer {jwt}",
            "Content-Type": "application/json",
            "x-api-key": PREDICT_API_KEY,
        })
        # 记录已撤单的市场，避免重复操作
        self.cancelled_markets = set()

    def get_my_open_orders(self):
        """获取我所有未成交的挂单"""
        url = f"{self.base_url}/v1/orders"
        params = {"status": "open"}
        try:
            resp = self.session.get(url, params=params, timeout=15)
            resp.raise_for_status()
            data = resp.json()
            orders = data.get("data", data) if isinstance(data, dict) else data
            if isinstance(orders, dict):
                orders = orders.get("orders", [])
            return orders if isinstance(orders, list) else []
        except requests.exceptions.RequestException as e:
            logger.error(f"获取挂单列表失败: {e}")
            return []

    def get_market_info(self, market_id):
        """获取市场详细信息"""
        url = f"{self.base_url}/v1/markets/{market_id}"
        try:
            resp = self.session.get(url, timeout=10)
            resp.raise_for_status()
            data = resp.json()
            return data.get("data", data) if isinstance(data, dict) else data
        except requests.exceptions.RequestException as e:
            logger.error(f"获取市场信息失败 (id={market_id}): {e}")
            return None

    def parse_event_start_time(self, market):
        """
        从市场 description 解析开赛时间，返回 datetime(UTC) 或 None
        """
        desc = market.get("description", "") or ""
        cat = market.get("categorySlug", "") or ""

        # 匹配 "scheduled for May 12 at 7:05PM ET"
        pattern = r'scheduled for (\w+ \d+)(?: at (\d+:\d+(?:AM|PM)) ET)?'
        match = re.search(pattern, desc, re.IGNORECASE)
        if match:
            date_str = match.group(1)
            time_str = match.group(2)

            year_match = re.search(r'(\d{4})-(\d{2})-(\d{2})$', cat)
            year = int(year_match.group(1)) if year_match else datetime.utcnow().year

            try:
                if time_str:
                    dt_str = f"{date_str} {year} {time_str}"
                    dt = datetime.strptime(dt_str, "%B %d %Y %I:%M%p")
                else:
                    dt_str = f"{date_str} {year}"
                    dt = datetime.strptime(dt_str, "%B %d %Y")
                    # 没有具体时间则不做撤单
                    return None

                # ET = UTC-4 (EDT，5月份)
                et_offset = timedelta(hours=-4)
                dt_utc = dt - et_offset
                return dt_utc
            except ValueError:
                pass

        return None

    def cancel_order(self, order_id):
        """撤销单个订单"""
        url = f"{self.base_url}/v1/orders/{order_id}/cancel"
        try:
            resp = self.session.post(url, timeout=10)
            resp.raise_for_status()
            return True
        except requests.exceptions.RequestException as e:
            logger.error(f"撤单失败 (order_id={order_id}): {e}")
            return False

    def check_and_cancel(self):
        """
        检查所有挂单，对体育比赛市场判断是否需要撤单
        返回: 还有多少个体育比赛挂单在监控中
        """
        orders = self.get_my_open_orders()
        if not orders:
            return 0

        sports_orders_remaining = 0
        now_utc = datetime.utcnow()

        # 按 marketId 分组
        market_orders = {}
        for order in orders:
            mid = order.get("marketId") or order.get("market_id")
            if mid:
                market_orders.setdefault(mid, []).append(order)

        for market_id, order_list in market_orders.items():
            if market_id in self.cancelled_markets:
                continue

            # 获取市场信息
            market = self.get_market_info(market_id)
            if market is None:
                continue

            variant = market.get("marketVariant", "")
            if variant not in ["SPORTS_MATCH", "SPORTS_TEAM_MATCH"]:
                # 非体育市场，不管
                continue

            title = market.get("title", "") or market.get("question", "") or ""
            start_time = self.parse_event_start_time(market)

            if start_time is None:
                # 无法解析时间，保留挂单
                sports_orders_remaining += 1
                continue

            time_to_start = start_time - now_utc
            minutes_to_start = time_to_start.total_seconds() / 60

            if minutes_to_start <= 0:
                # 已开赛，立刻撤
                logger.warning(f"🚨 已开赛，撤单: {title} (market_id={market_id})")
                for order in order_list:
                    oid = order.get("id") or order.get("orderId")
                    if oid:
                        self.cancel_order(oid)
                self.cancelled_markets.add(market_id)

            elif minutes_to_start <= CANCEL_BEFORE_MINUTES:
                # 距开赛 ≤ 30分钟，撤单
                logger.warning(
                    f"⏰ 距开赛{minutes_to_start:.0f}分钟(≤{CANCEL_BEFORE_MINUTES}min)，撤单: "
                    f"{title} (market_id={market_id})"
                )
                for order in order_list:
                    oid = order.get("id") or order.get("orderId")
                    if oid:
                        self.cancel_order(oid)
                self.cancelled_markets.add(market_id)

            else:
                # 还没到撤单时间
                sports_orders_remaining += 1
                logger.info(
                    f"  ⏳ {title}: 距开赛还有{minutes_to_start:.0f}分钟，继续持有"
                )

            time.sleep(0.3)  # 控制 API 频率

        return sports_orders_remaining

    def run(self):
        """主循环: 每分钟检查一次"""
        global running

        logger.info("=" * 50)
        logger.info("开赛前自动撤单守护脚本")
        logger.info(f"撤单时间: 开赛前 {CANCEL_BEFORE_MINUTES} 分钟")
        logger.info(f"检查间隔: {CHECK_INTERVAL} 秒")
        logger.info("=" * 50)

        while running:
            try:
                remaining = self.check_and_cancel()
                if remaining == 0:
                    logger.info("✅ 没有需要监控的体育比赛挂单了，退出")
                    break
                logger.info(f"📊 还有 {remaining} 个体育比赛挂单在监控中")
            except Exception as e:
                logger.error(f"检查异常: {e}", exc_info=True)

            time.sleep(CHECK_INTERVAL)

        logger.info("守护脚本已退出")


def main():
    timer = CancelTimer()
    timer.run()


if __name__ == "__main__":
    main()
