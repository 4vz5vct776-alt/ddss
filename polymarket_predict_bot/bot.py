"""
主程序 - Polymarket 盘口跟随 Bot
功能: 监控 Polymarket 盘口变化, 自动在 Predict.fun 上挂单/撤单

使用:
1. 编辑 config.py 填入配置
2. pip install requests
3. python bot.py
"""

import time
import logging
import signal

from config import (
    POLYMARKET_TOKEN_ID,
    PRICE_CHANGE_THRESHOLD,
    POLL_INTERVAL,
    ORDER_SIZE,
    ORDER_SIDE,
    FOLLOW_BID,
)
from polymarket_monitor import get_orderbook
from predict_trader import PredictTrader

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

running = True
last_price = None


def signal_handler(sig, frame):
    global running
    logger.info("收到退出信号, 正在清理...")
    running = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


def run_bot():
    global last_price, running

    logger.info("=" * 50)
    logger.info("Polymarket -> Predict.fun 盘口跟随 Bot 启动")
    logger.info("=" * 50)
    logger.info(f"监控 token: {POLYMARKET_TOKEN_ID}")
    logger.info(f"方向: {ORDER_SIDE}, 数量: {ORDER_SIZE}")
    logger.info(f"价格阈值: {PRICE_CHANGE_THRESHOLD}")
    logger.info(f"轮询间隔: {POLL_INTERVAL}秒")
    logger.info(f"跟随: {'best_bid' if FOLLOW_BID else 'best_ask'}")
    logger.info("=" * 50)

    trader = PredictTrader()
    trader.get_open_orders()

    while running:
        try:
            # 1. 获取 Polymarket 盘口
            orderbook = get_orderbook()
            if orderbook is None:
                logger.warning("获取盘口失败, 等待重试...")
                time.sleep(POLL_INTERVAL)
                continue

            # 2. 计算目标价格
            if FOLLOW_BID:
                target_price = orderbook["best_bid"]
            else:
                target_price = orderbook["best_ask"]

            # 3. 判断价格是否变化超过阈值
            price_diff = abs(target_price - last_price) if last_price else 999
            if price_diff >= PRICE_CHANGE_THRESHOLD:
                logger.info(
                    f"盘口变化! 旧={last_price}, 新={target_price:.4f}"
                )

                # 4. 撤旧单
                if trader.active_orders:
                    logger.info("撤销旧订单...")
                    trader.cancel_all_orders()

                # 5. 挂新单
                logger.info(
                    f"挂新单: {ORDER_SIDE} @ {target_price:.4f} x {ORDER_SIZE}"
                )
                result = trader.create_order(
                    side=ORDER_SIDE,
                    price=target_price,
                    size=ORDER_SIZE,
                )
                if result:
                    last_price = target_price
                    logger.info("挂单成功!")
                else:
                    logger.error("挂单失败")
            else:
                logger.debug(f"价格无变化 ({target_price:.4f}), 保持")

        except Exception as e:
            logger.error(f"异常: {e}", exc_info=True)

        time.sleep(POLL_INTERVAL)

    # 退出清理
    logger.info("Bot 停止, 撤销所有挂单...")
    trader.cancel_all_orders()
    logger.info("已退出.")


if __name__ == "__main__":
    run_bot()
