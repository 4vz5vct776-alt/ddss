"""
Predict.fun 挂单/撤单模块
- 通过 REST API 管理订单
- API: https://api.predict.fun/v1/orders
"""

import requests
import logging

from config import PREDICT_API_URL, PREDICT_API_KEY, PREDICT_MARKET_ID

logger = logging.getLogger(__name__)


class PredictTrader:
    """Predict.fun 交易客户端"""

    def __init__(self, api_key=None, market_id=None):
        self.api_key = api_key or PREDICT_API_KEY
        self.market_id = market_id or PREDICT_MARKET_ID
        self.base_url = PREDICT_API_URL
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        })
        self.active_orders = []

    def create_order(self, side, price, size, market_id=None):
        """
        创建限价单

        参数:
            side: "buy" 或 "sell"
            price: 价格 (0到1之间)
            size: 数量 (USDB)
        """
        market_id = market_id or self.market_id
        url = f"{self.base_url}/v1/orders"

        payload = {
            "marketId": market_id,
            "side": side,
            "price": str(round(price, 4)),
            "size": str(round(size, 2)),
            "type": "limit",
        }

        try:
            resp = self.session.post(url, json=payload, timeout=10)
            resp.raise_for_status()
            order = resp.json()
            order_id = order.get("id") or order.get("orderId")
            self.active_orders.append(order_id)
            logger.info(
                f"[Predict] 挂单成功: side={side}, price={price:.4f}, "
                f"size={size}, order_id={order_id}"
            )
            return order
        except requests.exceptions.RequestException as e:
            logger.error(f"[Predict] 挂单失败: {e}")
            if hasattr(e, "response") and e.response is not None:
                logger.error(f"[Predict] 响应: {e.response.text}")
            return None

    def cancel_order(self, order_id):
        """撤销指定订单"""
        url = f"{self.base_url}/v1/orders/{order_id}/cancel"

        try:
            resp = self.session.post(url, timeout=10)
            resp.raise_for_status()
            if order_id in self.active_orders:
                self.active_orders.remove(order_id)
            logger.info(f"[Predict] 撤单成功: order_id={order_id}")
            return True
        except requests.exceptions.RequestException as e:
            logger.error(f"[Predict] 撤单失败: {e}")
            return False

    def cancel_all_orders(self):
        """撤销所有活跃订单"""
        cancelled = 0
        for order_id in list(self.active_orders):
            if self.cancel_order(order_id):
                cancelled += 1
        logger.info(f"[Predict] 批量撤单完成, 成功 {cancelled} 笔")
        return cancelled

    def get_open_orders(self, market_id=None):
        """获取当前未成交的挂单"""
        market_id = market_id or self.market_id
        url = f"{self.base_url}/v1/orders"
        params = {"marketId": market_id, "status": "open"}

        try:
            resp = self.session.get(url, params=params, timeout=10)
            resp.raise_for_status()
            orders = resp.json()
            if isinstance(orders, dict):
                orders = orders.get("orders", [])
            self.active_orders = [
                o.get("id") or o.get("orderId") for o in orders
            ]
            logger.info(f"[Predict] 当前活跃订单: {len(self.active_orders)} 笔")
            return orders
        except requests.exceptions.RequestException as e:
            logger.error(f"[Predict] 获取订单失败: {e}")
            return []
