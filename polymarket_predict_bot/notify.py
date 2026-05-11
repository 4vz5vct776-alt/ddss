"""
手机报警通知模块
- 当买单被成交(接到份额)时，发送通知到手机
- 支持 Telegram Bot 推送

设置方法:
1. 在 Telegram 搜索 @BotFather，创建一个 Bot，拿到 Token
2. 搜索 @userinfobot，发消息获取你的 Chat ID
3. 填入 config.py 的 TELEGRAM_BOT_TOKEN 和 TELEGRAM_CHAT_ID
"""

import requests
import logging

logger = logging.getLogger(__name__)

# ====== Telegram 配置 ======
# 在 config.py 中设置，这里从 config 导入
try:
    from config import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
except ImportError:
    TELEGRAM_BOT_TOKEN = ""
    TELEGRAM_CHAT_ID = ""


def send_telegram(message):
    """
    通过 Telegram Bot 发送消息到手机

    参数:
        message: 要发送的文字内容
    """
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        logger.warning("Telegram 未配置，跳过通知")
        return False

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": message,
        "parse_mode": "HTML",
    }

    try:
        resp = requests.post(url, json=payload, timeout=10)
        resp.raise_for_status()
        logger.info(f"[通知] Telegram 发送成功")
        return True
    except requests.exceptions.RequestException as e:
        logger.error(f"[通知] Telegram 发送失败: {e}")
        return False


def notify_order_filled(market_name, side, price, size):
    """
    订单成交通知

    参数:
        market_name: 市场名称
        side: 买/卖
        price: 成交价格
        size: 成交数量
    """
    message = (
        f"🔔 <b>订单成交!</b>\n\n"
        f"📊 市场: {market_name}\n"
        f"📈 方向: {side}\n"
        f"💰 价格: {price:.4f}\n"
        f"📦 数量: {size}\n"
        f"💵 金额: {price * size:.2f} USDB"
    )
    return send_telegram(message)


def notify_order_cancelled(market_name, reason):
    """
    撤单通知

    参数:
        market_name: 市场名称
        reason: 撤单原因
    """
    message = (
        f"⚠️ <b>已撤单!</b>\n\n"
        f"📊 市场: {market_name}\n"
        f"📝 原因: {reason}"
    )
    return send_telegram(message)


def notify_danger(market_name, old_size, new_size, drop_percent):
    """
    盘口异动警报

    参数:
        market_name: 市场名称
        old_size: 旧买1量
        new_size: 新买1量
        drop_percent: 下降百分比
    """
    message = (
        f"🚨 <b>盘口异动!</b>\n\n"
        f"📊 市场: {market_name}\n"
        f"📉 买1: {old_size:.2f} → {new_size:.2f}\n"
        f"📉 下降: {drop_percent*100:.1f}%\n"
        f"🛡️ 已自动撤单保护"
    )
    return send_telegram(message)


def test_notify():
    """测试通知是否正常"""
    message = "✅ Predict.fun Bot 通知测试成功！\n你的手机报警已设置好。"
    result = send_telegram(message)
    if result:
        print("✅ 通知发送成功! 检查你的 Telegram")
    else:
        print("❌ 通知发送失败，请检查配置")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    test_notify()
