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
# 每次挂单的数量 (USDB)
ORDER_SIZE = 10.0

# 挂单方向: "buy" 或 "sell"
ORDER_SIDE = "buy"

# 轮询间隔 (秒) - 多久检查一次盘口
POLL_INTERVAL = 3

# ============ 撤单保护参数 ============
# 买1数量减少超过多少比例就撤单 (0.5 = 减少50%)
# 例如: 买1原来挂了1000张, 突然变成400张(减少60%), 就触发撤单
BID1_DROP_PERCENT = 0.5

# 买1数量低于这个值就撤单 (绝对值)
# 例如: 买1只剩下50张，太薄了，撤单保护
BID1_MIN_SIZE = 50.0

# 盘口恢复后等待多少秒再重新挂单
# 防止反复触发，等稳定了再挂
RECOVER_WAIT_TIME = 10

# 是否跟随 Polymarket 的 best bid
FOLLOW_BID = True
