"""
全自动做市 Bot - 扫描所有市场 + 买1跟单 + 异动撤单
============================================================
功能:
  1. 扫描所有可交易市场，过滤有星星/可挂单的
  2. 每个市场看 Yes/No 两边买1，哪边量多挂哪边
  3. 所有市场统一每3秒查一次订单簿，买1大量减少 → 立刻撤单，等30秒恢复后重挂
  4. 体育/电竞市场额外对齐 Polymarket 订单簿，异动就撤单
  5. 每次都挂买1量多的那一边
  6. 所有异动/撤单事件都发 Telegram 报警

使用:
  python3 market_maker.py
"""

import time
import logging
import signal
import threading
from enum import Enum

import requests

from config import (
    PREDICT_API_URL,
    PREDICT_API_KEY,
    PREDICT_JWT_TOKEN,
    POLYMARKET_CLOB_URL,
    ORDER_SIZE,
    TOTAL_BUDGET,
    BID1_DROP_PERCENT,
    BID1_MIN_SIZE,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
)
from notify import send_telegram, notify_danger

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

# ============ 全局控制 ============
running = True
POLL_INTERVAL = 3               # 所有市场统一3秒轮询
RECOVER_WAIT_TIME = 30          # 撤单后等待恢复时间(秒)


def signal_handler(sig, frame):
    global running
    logger.info("收到退出信号, 正在停止所有监控...")
    running = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


# ============ 市场分类 ============
class MarketType(Enum):
    GENERAL = "general"
    SPORTS = "sports"
    ESPORTS = "esports"


SPORTS_KEYWORDS = [
    "nba", "nfl", "mlb", "nhl", "soccer", "football", "basketball",
    "baseball", "tennis", "cricket", "boxing", "mma", "ufc",
    "f1", "formula", "golf", "rugby", "hockey",
    "premier league", "la liga", "serie a", "bundesliga",
    "champions league", "world cup",
]

ESPORTS_KEYWORDS = [
    "esports", "e-sports", "league of legends", "lol", "dota",
    "cs2", "csgo", "valorant", "overwatch", "fortnite",
    "pubg", "apex", "call of duty", "cod",
]


CRYPTO_SHORT_KEYWORDS = [
    "15min", "15 min", "15m", "1hour", "1 hour", "1h",
    "30min", "30 min", "30m", "5min", "5 min", "5m",
    "hourly", "每小时", "每15分钟",
]


def classify_market(market):
    """根据标题/分类判断市场类型"""
    title = (market.get("title") or market.get("question") or "").lower()
    category = (market.get("category") or "").lower()
    tags = [t.lower() for t in (market.get("tags") or [])]

    combined = f"{title} {category} {' '.join(tags)}"

    for kw in ESPORTS_KEYWORDS:
        if kw in combined:
            return MarketType.ESPORTS

    for kw in SPORTS_KEYWORDS:
        if kw in combined:
            return MarketType.SPORTS

    return MarketType.GENERAL


def is_live_event(market):
    """判断市场是否处于比赛进行中(LIVE)状态"""
    # 检查 tradingStatus / status 字段
    status = ""
    ts = market.get("tradingStatus")
    if isinstance(ts, dict):
        status = (ts.get("status") or "").upper()
    elif isinstance(ts, str):
        status = ts.upper()

    live_statuses = ["LIVE", "IN_PROGRESS", "STARTED", "HALTED", "PLAYING"]
    if status in live_statuses:
        return True

    # 检查标题中是否有 [LIVE] 标记
    title = (market.get("title") or market.get("question") or "")
    if "[LIVE]" in title or "(LIVE)" in title or "🔴" in title:
        return True

    # 检查 isLive 字段
    if market.get("isLive") or market.get("is_live"):
        return True

    return False


def is_crypto_short_term(market):
    """
    判断是否为加密货币短期盘(15分钟/小时级别)
    这类盘子变化太快不适合做市
    """
    title = (market.get("title") or market.get("question") or "").lower()
    category = (market.get("category") or "").lower()
    tags = [t.lower() for t in (market.get("tags") or [])]
    combined = f"{title} {category} {' '.join(tags)}"

    # 先判断是否是加密相关
    crypto_keywords = [
        "bitcoin", "btc", "ethereum", "eth", "crypto", "sol", "solana",
        "bnb", "xrp", "doge", "ada", "avax", "matic", "dot",
        "token", "defi", "加密", "币",
    ]
    is_crypto = any(kw in combined for kw in crypto_keywords)
    if not is_crypto:
        return False

    # 是加密的前提下，判断是否为短期盘
    for kw in CRYPTO_SHORT_KEYWORDS:
        if kw in combined:
            return True

    # 检查 resolution 时间相关字段
    resolution = (market.get("resolutionType") or market.get("resolution") or "").lower()
    if any(kw in resolution for kw in ["15min", "1hour", "hourly", "30min"]):
        return True

    return False


# ============ API 客户端 ============
class PredictClient:
    """Predict.fun API 客户端"""

    def __init__(self):
        self.base_url = PREDICT_API_URL
        self.session = requests.Session()
        jwt = PREDICT_JWT_TOKEN if PREDICT_JWT_TOKEN else PREDICT_API_KEY
        self.session.headers.update({
            "Authorization": f"Bearer {jwt}",
            "Content-Type": "application/json",
            "x-api-key": PREDICT_API_KEY,
        })

    def get_markets(self):
        """获取所有开放且有奖励的市场"""
        url = f"{self.base_url}/v1/markets"
        params = {
            "status": "OPEN",
            "first": 100,
            "hasActiveRewards": "true",
        }
        try:
            resp = self.session.get(url, params=params, timeout=10)
            resp.raise_for_status()
            data = resp.json()
            markets = data.get("data", [])
            if not markets:
                markets = data if isinstance(data, list) else []
            return markets
        except requests.exceptions.RequestException as e:
            logger.error(f"获取市场列表失败: {e}")
            return []

    def get_orderbook(self, market_id):
        """
        获取市场订单簿，返回 Yes 和 No 两边的买1
        返回: {"yes_bid1_price", "yes_bid1_size", "no_bid1_price", "no_bid1_size", "raw"}
        """
        url = f"{self.base_url}/v1/markets/{market_id}/orderbook"
        try:
            resp = self.session.get(url, timeout=10)
            resp.raise_for_status()
            data = resp.json()
            orderbook = data.get("data", data)

            result = {"raw": orderbook}

            # Yes 方向的买盘
            yes_bids = orderbook.get("bids", [])
            if yes_bids:
                b = yes_bids[0]
                if isinstance(b, dict):
                    result["yes_bid1_price"] = float(b.get("price", 0))
                    result["yes_bid1_size"] = float(b.get("size", 0))
                elif isinstance(b, list):
                    result["yes_bid1_price"] = float(b[0])
                    result["yes_bid1_size"] = float(b[1]) if len(b) > 1 else 0
                else:
                    result["yes_bid1_price"] = float(b)
                    result["yes_bid1_size"] = 0
            else:
                result["yes_bid1_price"] = 0
                result["yes_bid1_size"] = 0

            # No 方向的买盘 (asks 的镜像，或者 noBids)
            no_bids = orderbook.get("noBids", orderbook.get("asks", []))
            if no_bids:
                b = no_bids[0]
                if isinstance(b, dict):
                    result["no_bid1_price"] = float(b.get("price", 0))
                    result["no_bid1_size"] = float(b.get("size", 0))
                elif isinstance(b, list):
                    result["no_bid1_price"] = float(b[0])
                    result["no_bid1_size"] = float(b[1]) if len(b) > 1 else 0
                else:
                    result["no_bid1_price"] = float(b)
                    result["no_bid1_size"] = 0
            else:
                result["no_bid1_price"] = 0
                result["no_bid1_size"] = 0

            return result

        except requests.exceptions.RequestException as e:
            logger.error(f"获取盘口失败 (market={market_id}): {e}")
            return None

    def create_order(self, market_id, side, price, size):
        """创建限价单"""
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
            order_id = (
                order.get("data", {}).get("orderId")
                or order.get("id")
                or order.get("orderId")
            )
            logger.info(f"  ✅ 挂单成功: {side} @ {price:.4f} x {size}, id={order_id}")
            return order_id
        except requests.exceptions.RequestException as e:
            logger.error(f"  ❌ 挂单失败: {e}")
            if hasattr(e, "response") and e.response is not None:
                logger.error(f"  响应: {e.response.text}")
            return None

    def cancel_order(self, order_id):
        """撤销指定订单"""
        url = f"{self.base_url}/v1/orders/{order_id}"
        try:
            resp = self.session.delete(url, timeout=10)
            resp.raise_for_status()
            return True
        except requests.exceptions.RequestException as e:
            logger.error(f"撤单失败 (order={order_id}): {e}")
            return False

    def cancel_orders_batch(self, order_ids):
        """批量撤单"""
        url = f"{self.base_url}/v1/orders"
        payload = {"orderHashes": order_ids}
        try:
            resp = self.session.delete(url, json=payload, timeout=10)
            resp.raise_for_status()
            logger.info(f"批量撤单成功: {len(order_ids)} 笔")
            return True
        except:
            # fallback: 逐个撤
            success = 0
            for oid in order_ids:
                if self.cancel_order(oid):
                    success += 1
            logger.info(f"逐个撤单: {success}/{len(order_ids)}")
            return success > 0

    def get_order_status(self, order_id):
        """
        查询订单状态
        返回: "OPEN" / "FILLED" / "PARTIALLY_FILLED" / "CANCELLED" / None
        """
        url = f"{self.base_url}/v1/orders/{order_id}"
        try:
            resp = self.session.get(url, timeout=10)
            resp.raise_for_status()
            data = resp.json()
            order = data.get("data", data)
            return order.get("status") or order.get("state") or "UNKNOWN"
        except requests.exceptions.RequestException as e:
            logger.error(f"查询订单状态失败 (order={order_id}): {e}")
            return None


# ============ Polymarket 盘口 (体育市场对齐用) ============
def get_polymarket_orderbook(token_id):
    """获取 Polymarket 订单簿"""
    url = f"{POLYMARKET_CLOB_URL}/book"
    params = {"token_id": token_id}
    try:
        resp = requests.get(url, params=params, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        bids = data.get("bids", [])
        if bids:
            return {
                "bid1_price": float(bids[0]["price"]),
                "bid1_size": float(bids[0]["size"]),
                "bids": bids,
            }
        return None
    except:
        return None


# ============ 单市场监控器 ============
class MarketMonitor:
    """单个市场的监控和做市逻辑"""

    def __init__(self, market, client, market_type):
        self.market = market
        self.client = client
        self.market_type = market_type
        self.market_id = market.get("id") or market.get("marketId")
        self.market_name = (
            market.get("title") or market.get("question") or f"Market#{self.market_id}"
        )

        # 轮询间隔 (统一3秒)
        self.poll_interval = POLL_INTERVAL

        # 状态
        self.active_order_id = None
        self.active_side = None
        self.last_bid1_size = None
        self.is_cooling_down = False
        self.cooldown_start = 0

        # Polymarket token (体育市场对齐)
        self.polymarket_token_id = market.get("polymarketTokenId")

    def choose_side(self, book):
        """
        选择挂哪边: Yes 还是 No, 挂买1量多的那边
        返回: ("BUY", price) 或 ("SELL", price) 或 None
        """
        yes_size = book.get("yes_bid1_size", 0)
        no_size = book.get("no_bid1_size", 0)
        yes_price = book.get("yes_bid1_price", 0)
        no_price = book.get("no_bid1_price", 0)

        if yes_size <= 0 and no_size <= 0:
            return None, 0

        if yes_size >= no_size:
            # Yes 那边买1量多，跟 Yes 方向挂买单
            return "BUY", yes_price
        else:
            # No 那边买1量多，挂 No 方向 (即 sell Yes 或 buy No)
            return "SELL", no_price

    def check_anomaly(self, book):
        """
        检测买1异动:
        - 当前挂的那边买1量 vs 上次，减少超过阈值 → 异动
        """
        if self.active_side == "BUY":
            current_size = book.get("yes_bid1_size", 0)
        else:
            current_size = book.get("no_bid1_size", 0)

        if self.last_bid1_size is None:
            self.last_bid1_size = current_size
            return False

        if self.last_bid1_size <= 0:
            self.last_bid1_size = current_size
            return False

        drop_ratio = (self.last_bid1_size - current_size) / self.last_bid1_size

        # 买1量低于安全值
        too_small = current_size < BID1_MIN_SIZE

        is_anomaly = drop_ratio >= BID1_DROP_PERCENT or too_small

        if is_anomaly:
            logger.warning(
                f"⚠️ [{self.market_name[:30]}] 异动! "
                f"买1: {self.last_bid1_size:.1f} → {current_size:.1f} "
                f"(↓{drop_ratio*100:.1f}%)"
            )
            # 发通知
            notify_danger(
                self.market_name,
                self.last_bid1_size,
                current_size,
                drop_ratio,
            )

        self.last_bid1_size = current_size
        return is_anomaly

    def check_polymarket_anomaly(self):
        """
        体育/电竞市场: 对齐 Polymarket 盘口，检测异动
        """
        if not self.polymarket_token_id:
            return False

        poly_book = get_polymarket_orderbook(self.polymarket_token_id)
        if poly_book is None:
            return False

        # 简单检测: Polymarket 买1量突然大幅减少
        poly_bid1_size = poly_book["bid1_size"]
        if not hasattr(self, "_last_poly_bid1"):
            self._last_poly_bid1 = poly_bid1_size
            return False

        if self._last_poly_bid1 > 0:
            drop = (self._last_poly_bid1 - poly_bid1_size) / self._last_poly_bid1
            if drop >= BID1_DROP_PERCENT:
                logger.warning(
                    f"⚠️ [{self.market_name[:30]}] Polymarket异动! "
                    f"买1: {self._last_poly_bid1:.1f} → {poly_bid1_size:.1f}"
                )
                # TG 报警
                notify_danger(
                    f"[Polymarket] {self.market_name}",
                    self._last_poly_bid1,
                    poly_bid1_size,
                    drop,
                )
                self._last_poly_bid1 = poly_bid1_size
                return True

        self._last_poly_bid1 = poly_bid1_size
        return False

    def cancel_active_order(self):
        """撤掉当前活跃订单"""
        if self.active_order_id:
            self.client.cancel_order(self.active_order_id)
            logger.info(f"🛡️ [{self.market_name[:30]}] 已撤单保护")
            send_telegram(
                f"🛡️ <b>已撤单保护</b>\n"
                f"📊 市场: {self.market_name}\n"
                f"类型: {self.market_type.value}"
            )
            self.active_order_id = None
            self.active_side = None

    def place_order(self, side, price):
        """挂单"""
        order_id = self.client.create_order(
            market_id=self.market_id,
            side=side,
            price=price,
            size=ORDER_SIZE,
        )
        if order_id:
            self.active_order_id = order_id
            self.active_side = side
        return order_id

    def tick(self):
        """
        单次循环逻辑:
        1. 冷却期内 → 跳过
        2. 获取盘口
        3. 有活跃单 → 检测异动 → 异动则撤单+冷却
        4. 无活跃单 → 选边挂单
        """
        # 冷却期
        if self.is_cooling_down:
            elapsed = time.time() - self.cooldown_start
            if elapsed < RECOVER_WAIT_TIME:
                return  # 还在冷却
            else:
                logger.info(
                    f"✅ [{self.market_name[:30]}] 冷却结束({RECOVER_WAIT_TIME}s), 准备重新挂单"
                )
                self.is_cooling_down = False
                self.last_bid1_size = None  # 重置基准

        # 获取盘口
        book = self.client.get_orderbook(self.market_id)
        if book is None:
            return

        # 检测挂单是否被吃 (成交检测)
        if self.active_order_id:
            status = self.client.get_order_status(self.active_order_id)
            if status in ("FILLED", "PARTIALLY_FILLED", "MATCHED"):
                logger.warning(
                    f"🔔 [{self.market_name[:30]}] 挂单被吃! "
                    f"side={self.active_side}, orderId={self.active_order_id}, status={status}"
                )
                send_telegram(
                    f"🔔 <b>挂单被吃!</b>\n\n"
                    f"📊 市场: {self.market_name}\n"
                    f"📈 方向: {self.active_side}\n"
                    f"🆔 订单: {self.active_order_id}\n"
                    f"📋 状态: {status}\n"
                    f"⏰ 立即关注!"
                )
                # 清除状态，下一轮重新挂
                self.active_order_id = None
                self.active_side = None
                self.last_bid1_size = None

        # 体育/电竞市场额外检查 Polymarket
        if self.market_type in (MarketType.SPORTS, MarketType.ESPORTS):
            if self.check_polymarket_anomaly():
                self.cancel_active_order()
                self.is_cooling_down = True
                self.cooldown_start = time.time()
                return

        # 有活跃订单 → 检测异动
        if self.active_order_id:
            if self.check_anomaly(book):
                self.cancel_active_order()
                self.is_cooling_down = True
                self.cooldown_start = time.time()
                return
            # 检查是否需要换边 (买1量多的边变了)
            side, price = self.choose_side(book)
            if side and side != self.active_side:
                logger.info(
                    f"🔄 [{self.market_name[:30]}] 换边: {self.active_side} → {side}"
                )
                self.cancel_active_order()
                self.place_order(side, price)
        else:
            # 无活跃单 → 选边挂单
            side, price = self.choose_side(book)
            if side and price > 0:
                logger.info(
                    f"📈 [{self.market_name[:30]}] 挂单: {side} @ {price:.4f}"
                )
                self.place_order(side, price)


# ============ 主控循环 ============
def run_market_maker():
    global running

    logger.info("=" * 60)
    logger.info("全自动做市 Bot - 扫描市场 + 跟买1 + 异动撤单")
    logger.info("=" * 60)
    logger.info(f"所有市场轮询: 每 {POLL_INTERVAL} 秒")
    logger.info(f"异动阈值: 买1减少 {BID1_DROP_PERCENT*100:.0f}% 或低于 {BID1_MIN_SIZE}")
    logger.info(f"撤单冷却: {RECOVER_WAIT_TIME} 秒")
    logger.info(f"每笔份额: {ORDER_SIZE}")
    logger.info(f"总预算: {TOTAL_BUDGET} USDB")
    logger.info("=" * 60)

    client = PredictClient()

    # 1. 扫描所有市场
    logger.info("\n🔍 扫描可交易市场...")
    markets = client.get_markets()
    if not markets:
        logger.error("没有找到可交易市场!")
        return

    # 2. 过滤并分类，创建监控器
    monitors = []
    general_count = 0
    sports_count = 0
    skip_live = 0
    skip_crypto_short = 0

    for m in markets:
        # 跳过比赛进行中的
        if is_live_event(m):
            skip_live += 1
            mname = (m.get("title") or m.get("question") or "")[:40]
            logger.info(f"  ⏭️ 跳过(比赛中): {mname}")
            continue

        # 跳过加密短期盘(15分钟/小时)
        if is_crypto_short_term(m):
            skip_crypto_short += 1
            mname = (m.get("title") or m.get("question") or "")[:40]
            logger.info(f"  ⏭️ 跳过(加密短期): {mname}")
            continue

        mtype = classify_market(m)
        monitor = MarketMonitor(m, client, mtype)
        monitors.append(monitor)

        if mtype == MarketType.GENERAL:
            general_count += 1
        else:
            sports_count += 1

    logger.info(f"✅ 共 {len(monitors)} 个市场 (跳过: {skip_live}比赛中 + {skip_crypto_short}加密短期)")
    logger.info(f"   普通: {general_count} 个")
    logger.info(f"   体育/电竞: {sports_count} 个")
    logger.info(f"   统一轮询: 每{POLL_INTERVAL}秒")

    # 3. 预算控制
    total_spent = 0.0
    max_concurrent = int(TOTAL_BUDGET / (ORDER_SIZE * 0.5))  # 粗略估算最多挂几个
    logger.info(f"   最大并发挂单数: ~{max_concurrent}")
    logger.info("")

    # 4. 主循环 - 统一3秒轮询所有市场
    while running:
        active_count = sum(1 for m in monitors if m.active_order_id)

        for monitor in monitors:
            if not running:
                break

            # 预算控制: 已挂单数量上限
            if not monitor.active_order_id and active_count >= max_concurrent:
                continue

            try:
                monitor.tick()
            except Exception as e:
                logger.error(
                    f"[{monitor.market_name[:30]}] 异常: {e}",
                    exc_info=False,
                )

            # 请求间防止过快
            time.sleep(0.3)

        # 每轮结束等待
        time.sleep(POLL_INTERVAL)

    # ===== 退出清理 =====
    logger.info("\n🛑 正在撤销所有活跃订单...")
    active_ids = [m.active_order_id for m in monitors if m.active_order_id]
    if active_ids:
        client.cancel_orders_batch(active_ids)
        logger.info(f"已撤销 {len(active_ids)} 笔订单")
    else:
        logger.info("无活跃订单")

    logger.info("Bot 已安全退出。")
    send_telegram("🛑 做市Bot已停止，所有挂单已撤销。")


# ============ 入口 ============
if __name__ == "__main__":
    run_market_maker()
