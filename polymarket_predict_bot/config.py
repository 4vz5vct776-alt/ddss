"""
配置文件 - 请填入你的实际参数
"""

# ============ Polymarket 配置 ============
# Polymarket CLOB API (公开，无需认证即可读取盘口)
POLYMARKET_CLOB_URL = "https://clob.polymarket.com"
# Polymarket Gamma API (获取市场列表)
POLYMARKET_GAMMA_URL = "https://gamma-api.polymarket.com"

# 你要监控的 Polymarket 市场 token_id (条件代币ID)
# 示例: 在 Polymarket 某个市场页面可以找到 clob_token_ids
# YES token 和 NO token 各有一个 ID
POLYMARKET_TOKEN_ID = "YOUR_POLYMARKET_TOKEN_ID_HERE"

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

# 盘口价格变化阈值 (超过这个差值才触发挂单/撤单)
# 例如 0.01 表示价格变化超过 1 分钱才操作
PRICE_CHANGE_THRESHOLD = 0.01

# 轮询间隔 (秒)
POLL_INTERVAL = 5

# 挂单方向: "buy" 或 "sell"
ORDER_SIDE = "buy"

# 是否跟随 Polymarket 的 best bid
# True = 跟随 best bid (买方), False = 跟随 best ask (卖方)
FOLLOW_BID = True
