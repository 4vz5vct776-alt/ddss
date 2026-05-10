"""
批量撤单脚本 - 一键撤销所有挂单
功能: 获取所有未成交订单，一键全部撤销

使用:
  python3 batch_cancel.py
"""

import requests
import logging

from config import PREDICT_API_URL, PREDICT_API_KEY

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)


def cancel_all_orders():
    """获取所有挂单并全部撤销"""

    if PREDICT_API_KEY == "YOUR_PREDICT_FUN_JWT_TOKEN_HERE":
        print("\n⚠️  请先配置 config.py 中的 PREDICT_API_KEY!")
        return

    session = requests.Session()
    session.headers.update({
        "Authorization": f"Bearer {PREDICT_API_KEY}",
        "Content-Type": "application/json",
        "x-api-key": PREDICT_API_KEY,
    })

    logger.info("=" * 50)
    logger.info("批量撤单 - 撤销所有未成交订单")
    logger.info("=" * 50)

    # 1. 获取所有未成交订单
    url = f"{PREDICT_API_URL}/v1/orders"
    params = {"status": "OPEN", "first": 100}

    try:
        resp = session.get(url, params=params, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        orders = data.get("data", [])
        if not orders:
            orders = data if isinstance(data, list) else []
    except requests.exceptions.RequestException as e:
        logger.error(f"获取订单失败: {e}")
        return

    if not orders:
        logger.info("没有未成交订单，无需撤单。")
        return

    logger.info(f"找到 {len(orders)} 笔未成交订单")

    # 2. 批量撤单
    # 方法1: 用 remove orders API (推荐，一次性撤多个)
    order_hashes = []
    for o in orders:
        h = o.get("order", {}).get("hash") or o.get("hash") or o.get("id")
        if h:
            order_hashes.append(h)
            logger.info(f"  - 订单 {h[:16]}...")

    if order_hashes:
        cancel_url = f"{PREDICT_API_URL}/v1/orders"
        payload = {"orderHashes": order_hashes}

        try:
            resp = session.delete(cancel_url, json=payload, timeout=10)
            resp.raise_for_status()
            logger.info(f"\n✅ 成功撤销 {len(order_hashes)} 笔订单!")
        except requests.exceptions.RequestException as e:
            logger.error(f"批量撤单失败: {e}")
            if hasattr(e, "response") and e.response is not None:
                logger.error(f"响应: {e.response.text}")

            # 备选方案: 逐个撤单
            logger.info("尝试逐个撤单...")
            success = 0
            for h in order_hashes:
                try:
                    single_url = f"{PREDICT_API_URL}/v1/orders/{h}"
                    resp = session.delete(single_url, timeout=10)
                    resp.raise_for_status()
                    success += 1
                except:
                    pass
            logger.info(f"逐个撤单完成: {success}/{len(order_hashes)}")

    logger.info("=" * 50)


if __name__ == "__main__":
    cancel_all_orders()
