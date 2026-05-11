"""
批量快速挂单脚本 - Predict.fun 所有热门(星星)市场
功能:
  - 自动获取 Predict.fun 上所有带星星(热门/精选)的市场
  - 获取每个市场的买1价格
  - 以买1价格快速挂单

使用:
  python3 batch_order.py

API 参考:
  - GET /v1/markets - 获取市场列表
  - GET /v1/markets/{id}/orderbook - 获取盘口
  - POST /v1/orders - 创建订单
"""

import requests
import logging
import time

from config import PREDICT_API_URL, PREDICT_API_KEY, ORDER_SIZE

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
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Bearer {PREDICT_API_KEY}",
            "Content-Type": "application/json",
            "x-api-key": PREDICT_API_KEY,
            "Cookie": f"predict_token={PREDICT_API_KEY}",
        })
        # 公开请求(不需要认证)用另一个session
        self.public_session = requests.Session()
        self.public_session.headers.update({
            "Content-Type": "application/json",
        })

    def get_featured_markets(self):
        """
        获取带星星(热门/精选)的市场
        API: GET /v1/markets?status=TRADING
        注意: 获取市场列表不需要认证，用公开session
        """
        url = f"{self.base_url}/v1/markets"
        params = {
            "status": "TRADING",
            "first": 50,
        }

        try:
            # 先尝试不带认证的请求(公开接口)
            resp = self.public_session.get(url, params=params, timeout=10)
            if resp.status_code == 401:
                # 如果需要认证，用带认证的session
                resp = self.session.get(url, params=params, timeout=10)
            resp.raise_for_status()
            data = resp.json()

            markets = data.get("data", [])
            if not markets:
                markets = data if isinstance(data, list) else []

            # 过滤有星星/精选的市场 (featured/starred)
            # Predict.fun 热门市场通常有 featured 或 rewards 标记
            featured = []
            for m in markets:
                # 尝试多种方式判断是否为热门市场
                is_featured = (
                    m.get("featured", False)
                    or m.get("isFeatured", False)
                    or m.get("rewardEarningRate", 0) > 0
                    or m.get("rewards") is not None
                )
                if is_featured:
                    featured.append(m)

            # 如果过滤后为空，返回所有正在交易的市场
            if not featured:
                logger.info("未找到特别标记的热门市场，使用所有活跃市场")
                featured = markets

            logger.info(f"获取到 {len(featured)} 个热门市场")
            return featured

        except requests.exceptions.RequestException as e:
            logger.error(f"获取市场列表失败: {e}")
            if hasattr(e, "response") and e.response is not None:
                logger.error(f"响应: {e.response.text}")
            return []

    def get_market_orderbook(self, market_id):
        """
        获取指定市场的盘口
        API: GET /v1/markets/{id}/orderbook
        返回买1价格和数量 (公开接口，不需要认证)
        """
        url = f"{self.base_url}/v1/markets/{market_id}/orderbook"

        try:
            resp = self.public_session.get(url, timeout=10)
            if resp.status_code == 401:
                resp = self.session.get(url, timeout=10)
            resp.raise_for_status()
            data = resp.json()

            orderbook = data.get("data", data)
            bids = orderbook.get("bids", [])

            if bids:
                # 买1 = 最高买价
                bid1_price = float(bids[0].get("price", 0))
                bid1_size = float(bids[0].get("size", 0))
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

    def create_order(self, market_id, side, price, size):
        """
        创建限价单
        API: POST /v1/orders
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
            resp = self.session.post(url, json=payload, timeout=10)
            resp.raise_for_status()
            order = resp.json()
            logger.info(
                f"  ✅ 挂单成功: market={market_id}, "
                f"{side} @ {price:.4f} x {size}"
            )
            return order
        except requests.exceptions.RequestException as e:
            logger.error(f"  ❌ 挂单失败 (market={market_id}): {e}")
            if hasattr(e, "response") and e.response is not None:
                logger.error(f"  响应: {e.response.text}")
            return None

    def batch_place_orders(self, order_size=None):
        """
        批量挂单: 获取所有热门市场 → 获取买1 → 以买1价格挂单
        """
        size = order_size or ORDER_SIZE

        logger.info("=" * 50)
        logger.info("Predict.fun 批量快速挂单")
        logger.info(f"每笔金额: {size} USDB")
        logger.info("=" * 50)

        # 1. 获取热门市场
        markets = self.get_featured_markets()
        if not markets:
            logger.error("没有找到可交易的市场!")
            return

        success_count = 0
        fail_count = 0

        # 2. 逐个市场挂单
        for i, market in enumerate(markets, 1):
            market_id = market.get("id") or market.get("marketId")
            market_name = (
                market.get("title")
                or market.get("question")
                or market.get("name")
                or f"Market #{market_id}"
            )

            logger.info(f"\n[{i}/{len(markets)}] {market_name}")

            # 获取盘口
            book = self.get_market_orderbook(market_id)
            if book is None or book["bid1_price"] <= 0:
                logger.warning(f"  跳过: 没有买盘")
                fail_count += 1
                continue

            bid1_price = book["bid1_price"]
            logger.info(
                f"  买1: {bid1_price:.4f} (量={book['bid1_size']:.2f})"
            )

            # 以买1价格挂买单
            result = self.create_order(
                market_id=market_id,
                side="BUY",
                price=bid1_price,
                size=size,
            )

            if result:
                success_count += 1
            else:
                fail_count += 1

            # 控制速度，避免触发频率限制
            time.sleep(0.5)

        # 3. 汇总
        logger.info("\n" + "=" * 50)
        logger.info(f"批量挂单完成!")
        logger.info(f"成功: {success_count} 笔")
        logger.info(f"失败: {fail_count} 笔")
        logger.info("=" * 50)


def main():
    if PREDICT_API_KEY == "YOUR_PREDICT_FUN_JWT_TOKEN_HERE":
        print("\n" + "=" * 50)
        print("⚠️  请先配置 config.py 中的 PREDICT_API_KEY!")
        print("")
        print("步骤:")
        print("1. 去 https://predict.fun/ 连接钱包登录")
        print("2. 去 https://dev.predict.fun/ 获取 JWT Token")
        print("3. 打开 config.py, 把 PREDICT_API_KEY 改成你的 Token")
        print("=" * 50)
        return

    trader = PredictBatchTrader()
    trader.batch_place_orders()


if __name__ == "__main__":
    main()
