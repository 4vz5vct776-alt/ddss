"""
Polymarket 盘口监控模块
- 通过 CLOB API 获取指定市场的 orderbook
- 返回 best_bid 和 best_ask
"""

import requests
import logging

from config import POLYMARKET_CLOB_URL, POLYMARKET_TOKEN_ID, POLYMARKET_GAMMA_URL

logger = logging.getLogger(__name__)


def get_orderbook(token_id=None):
    """
    获取 Polymarket 指定 token 的 orderbook

    返回格式:
    {
        "best_bid": 0.55,
        "best_ask": 0.56,
        "mid_price": 0.555
    }
    """
    if token_id is None:
        token_id = POLYMARKET_TOKEN_ID

    url = f"{POLYMARKET_CLOB_URL}/book"
    params = {"token_id": token_id}

    try:
        resp = requests.get(url, params=params, timeout=10)
        resp.raise_for_status()
        data = resp.json()

        bids = data.get("bids", [])
        asks = data.get("asks", [])

        best_bid = float(bids[0]["price"]) if bids else 0.0
        best_ask = float(asks[0]["price"]) if asks else 1.0
        mid_price = (best_bid + best_ask) / 2.0

        result = {
            "bids": bids,
            "asks": asks,
            "best_bid": best_bid,
            "best_ask": best_ask,
            "mid_price": mid_price,
        }

        logger.info(
            f"[Polymarket] best_bid={best_bid:.4f}, "
            f"best_ask={best_ask:.4f}, mid={mid_price:.4f}"
        )
        return result

    except requests.exceptions.RequestException as e:
        logger.error(f"[Polymarket] 获取 orderbook 失败: {e}")
        return None


def search_markets(query="", limit=5):
    """
    搜索 Polymarket 市场，用来找你要监控的 token_id
    """
    url = f"{POLYMARKET_GAMMA_URL}/markets"
    params = {"active": "true", "closed": "false", "limit": limit}
    if query:
        params["_q"] = query

    try:
        resp = requests.get(url, params=params, timeout=10)
        resp.raise_for_status()
        return resp.json()
    except requests.exceptions.RequestException as e:
        logger.error(f"[Polymarket] 搜索市场失败: {e}")
        return []


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print("=" * 50)
    print("搜索 Polymarket 活跃市场 (获取 token_id)")
    print("=" * 50)
    markets = search_markets(limit=5)
    for i, m in enumerate(markets, 1):
        print(f"\n{i}. {m.get('question', 'N/A')}")
        token_ids = m.get("clobTokenIds", [])
        print(f"   Token IDs: {token_ids}")
        print(f"   Slug: {m.get('slug', '')}")
