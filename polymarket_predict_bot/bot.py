"""
盘口监控 Bot - 防砸盘撤单策略
功能:
  - 监控 Polymarket 买1 和 Predict.fun 买1
  - 如果买1突然撤单或大量减少 → 立刻撤掉自己的挂单，等待
  - 如果买1恢复正常 → 重新挂单

逻辑:
  1. 记录上一次的买1挂单量
  2. 每次检查时对比: 新买1量 vs 旧买1量
  3. 如果减少超过阈值(比如减少50%) → 触发撤单保护
  4. 如果恢复正常 → 重新挂单
"""

import time
import logging
import signal

from config import (
    POLYMARKET_TOKEN_ID,
    POLL_INTERVAL,
    ORDER_SIZE,
    ORDER_SIDE,
    # 新增配置
    BID1_DROP_PERCENT,
    BID1_MIN_SIZE,
    RECOVER_WAIT_TIME,
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


def signal_handler(sig, frame):
    global running
    logger.info("收到退出信号, 正在清理...")
    running = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


class OrderbookWatcher:
    """盘口监控器 - 检测买1是否突然撤单/大幅减少"""

    def __init__(self):
        self.last_bid1_size = None  # 上一次买1的挂单量
        self.last_bid1_price = None  # 上一次买1的价格
        self.is_dangerous = False  # 当前是否处于危险状态

    def check_bid1(self, orderbook):
        """
        检查买1是否突然撤单或大量减少

        返回:
            "DANGER" - 买1突然减少，需要撤单
            "SAFE" - 买1正常
            "RECOVERING" - 之前危险，现在恢复中
        """
        bids = orderbook.get("bids", [])
        if not bids:
            return "DANGER"

        # 当前买1的价格和数量
        current_bid1_price = float(bids[0]["price"])
        current_bid1_size = float(bids[0]["size"])

        # 第一次运行，记录数据
        if self.last_bid1_size is None:
            self.last_bid1_size = current_bid1_size
            self.last_bid1_price = current_bid1_price
            logger.info(
                f"初始买1: 价格={current_bid1_price:.4f}, "
                f"数量={current_bid1_size:.2f}"
            )
            return "SAFE"

        # 检测1: 买1数量突然大幅减少
        if self.last_bid1_size > 0:
            drop_ratio = (
                (self.last_bid1_size - current_bid1_size)
                / self.last_bid1_size
            )
        else:
            drop_ratio = 0

        # 检测2: 买1数量低于最小安全值
        too_small = current_bid1_size < BID1_MIN_SIZE

        # 检测3: 买1价格突然下降（被砸穿）
        price_dropped = (
            self.last_bid1_price is not None
            and current_bid1_price < self.last_bid1_price - 0.02
        )

        # 判断是否危险
        is_danger_now = (
            drop_ratio >= BID1_DROP_PERCENT  # 买1减少超过阈值
            or too_small  # 买1量太小
            or price_dropped  # 价格被砸穿
        )

        if is_danger_now:
            logger.warning(
                f"⚠️ 危险信号! "
                f"买1: {self.last_bid1_size:.2f} → {current_bid1_size:.2f} "
                f"(减少{drop_ratio*100:.1f}%), "
                f"价格: {self.last_bid1_price:.4f} → {current_bid1_price:.4f}"
            )
            self.is_dangerous = True
            self.last_bid1_size = current_bid1_size
            self.last_bid1_price = current_bid1_price
            return "DANGER"

        elif self.is_dangerous:
            # 之前是危险状态，现在恢复了
            logger.info(
                f"✅ 盘口恢复! "
                f"买1: 价格={current_bid1_price:.4f}, "
                f"数量={current_bid1_size:.2f}"
            )
            self.is_dangerous = False
            self.last_bid1_size = current_bid1_size
            self.last_bid1_price = current_bid1_price
            return "RECOVERING"

        else:
            # 正常状态
            self.last_bid1_size = current_bid1_size
            self.last_bid1_price = current_bid1_price
            return "SAFE"


def run_bot():
    global running

    logger.info("=" * 50)
    logger.info("盘口监控 Bot - 防砸盘撤单策略")
    logger.info("=" * 50)
    logger.info(f"监控 token: {POLYMARKET_TOKEN_ID[:30]}...")
    logger.info(f"买1减少超过 {BID1_DROP_PERCENT*100:.0f}% → 撤单")
    logger.info(f"买1数量低于 {BID1_MIN_SIZE} → 撤单")
    logger.info(f"挂单参数: {ORDER_SIDE} x {ORDER_SIZE}")
    logger.info(f"轮询间隔: {POLL_INTERVAL}秒")
    logger.info(f"恢复等待: {RECOVER_WAIT_TIME}秒")
    logger.info("=" * 50)

    trader = PredictTrader()
    watcher = OrderbookWatcher()
    has_active_order = False
    recover_time = 0

    while running:
        try:
            # 1. 获取 Polymarket 盘口
            orderbook = get_orderbook()
            if orderbook is None:
                logger.warning("获取盘口失败, 等待重试...")
                time.sleep(POLL_INTERVAL)
                continue

            # 2. 检查买1状态
            status = watcher.check_bid1(orderbook)

            if status == "DANGER":
                # ===== 危险! 立刻撤单 =====
                if has_active_order:
                    logger.warning("🚨 检测到买1撤单/大幅减少，立刻撤单!")
                    trader.cancel_all_orders()
                    has_active_order = False
                    logger.info("已撤单，进入等待观望状态...")
                else:
                    logger.info("已在观望中，继续等待...")

            elif status == "RECOVERING":
                # ===== 恢复中，等一会再挂单 =====
                logger.info(f"盘口恢复，等待 {RECOVER_WAIT_TIME} 秒确认安全...")
                recover_time = time.time()

            elif status == "SAFE":
                # ===== 安全，可以挂单 =====
                if not has_active_order:
                    # 如果刚从恢复状态来，要等待一段时间
                    if recover_time > 0:
                        elapsed = time.time() - recover_time
                        if elapsed < RECOVER_WAIT_TIME:
                            logger.debug(
                                f"恢复等待中... "
                                f"还剩{RECOVER_WAIT_TIME - elapsed:.0f}秒"
                            )
                            time.sleep(POLL_INTERVAL)
                            continue
                        recover_time = 0

                    # 严格检查 spread 条件，确认不会被吃单
                    bid1_price = orderbook["best_bid"]
                    ask1_price = orderbook["best_ask"]
                    spread = ask1_price - bid1_price

                    # 条件1: spread 必须 > 0（ask 必须严格大于 bid）
                    # 条件2: spread 至少 0.01（1分钱），防止挂上去瞬间被吃
                    if spread < 0.01:
                        logger.warning(
                            f"⛔ Spread 过小，拒绝挂单! "
                            f"bid1={bid1_price:.4f}, ask1={ask1_price:.4f}, "
                            f"spread={spread:.4f} < 0.01"
                        )
                        time.sleep(POLL_INTERVAL)
                        continue

                    # 条件3: 买1价格不能 >= ask1（否则直接成交）
                    if bid1_price >= ask1_price:
                        logger.warning(
                            f"⛔ bid >= ask，市场异常，拒绝挂单! "
                            f"bid1={bid1_price:.4f}, ask1={ask1_price:.4f}"
                        )
                        time.sleep(POLL_INTERVAL)
                        continue

                    # 所有条件通过，挂买1价格
                    logger.info(
                        f"✅ 盘口安全 (spread={spread:.4f}), 挂单: "
                        f"{ORDER_SIDE} @ {bid1_price:.4f} x {ORDER_SIZE}"
                    )
                    result = trader.create_order(
                        side=ORDER_SIDE,
                        price=bid1_price,
                        size=ORDER_SIZE,
                    )
                    if result:
                        has_active_order = True
                        logger.info("挂单成功!")

        except Exception as e:
            logger.error(f"异常: {e}", exc_info=True)

        time.sleep(POLL_INTERVAL)

    # 退出清理
    logger.info("Bot 停止, 撤销所有挂单...")
    trader.cancel_all_orders()
    logger.info("已退出.")


if __name__ == "__main__":
    run_bot()
