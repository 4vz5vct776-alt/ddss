"""
配置文件 - 请填入你的实际参数
"""

# ============ Polymarket 配置 ============
# Polymarket CLOB API (公开，无需认证即可读取盘口)
POLYMARKET_CLOB_URL = "https://clob.polymarket.com"
# Polymarket Gamma API (获取市场列表)
POLYMARKET_GAMMA_URL = "https://gamma-api.polymarket.com"

# 你要监控的 Polymarket 市场 token_id
# Knicks(尼克斯)赢的 Token ID
POLYMARKET_TOKEN_ID = "55297441786017085969636905582063725290032450865351029055580704018493906917875"

# ============ Predict.fun 配置 ============
# Predict.fun API
PREDICT_API_URL = "https://api.predict.fun"

# 认证方式: JWT Bearer Token
# 你需要从 Predict.fun 获取 API key 或 JWT token
PREDICT_API_KEY = "YOUR_PREDICT_FUN_JWT_TOKEN_HERE"

# 你要在 Predict.fun 上交易的市场ID
PREDICT_MARKET_ID = "YOUR_PREDICT_MARKET_ID_HERE"

# ============ 交易参数 ============
# 总预算 (USDB) - 所有市场加起来不超过这个金额
TOTAL_BUDGET = 30.0

# 每个市场挂单的份额数
ORDER_SIZE = 10.0

# 挂单方向: "buy" 或 "sell"
ORDER_SIDE = "buy"

# 轮询间隔 (秒) - 多久检查一次盘口
POLL_INTERVAL = 3

# ============ 过滤参数 ============
# 只挂有星星(有奖励)的市场
ONLY_WITH_REWARDS = True

# 跳过已经开始/进行中的比赛
SKIP_LIVE_EVENTS = True

# ============ 撤单保护参数 ============
# 买1数量减少超过多少比例就撤单 (0.5 = 减少50%)
BID1_DROP_PERCENT = 0.5

# 买1数量低于这个值就撤单 (绝对值)
BID1_MIN_SIZE = 50.0

# 盘口恢复后等待多少秒再重新挂单
RECOVER_WAIT_TIME = 10

# 是否跟随 Polymarket 的 best bid
FOLLOW_BID = True



# ============ 手机报警通知 (Telegram) ============
# 设置方法:
# 1. 打开 Telegram，搜索 @BotFather
# 2. 发送 /newbot，按提示创建一个Bot，拿到 Token
# 3. 搜索 @userinfobot，给它发消息，获取你的 Chat ID
# 4. 填入下面两个值

# Telegram Bot Token (从 @BotFather 获取)
TELEGRAM_BOT_TOKEN = "YOUR_TELEGRAM_BOT_TOKEN_HERE"

# 你的 Telegram Chat ID (从 @userinfobot 获取)
TELEGRAM_CHAT_ID = "YOUR_TELEGRAM_CHAT_ID_HERE"
