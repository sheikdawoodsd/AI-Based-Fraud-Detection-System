"""Shared feature engineering for training and inference."""
import numpy as np
import pandas as pd

TXN_TYPES = ["upi", "card_online", "card_pos", "net_banking", "wallet", "atm_withdrawal"]
MERCHANTS = ["grocery", "food", "travel", "electronics", "jewellery", "gaming", "crypto", "utilities", "other"]

NUMERIC = [
    "amount", "txn_hour", "is_international", "new_device", "new_beneficiary",
    "txns_last_24h", "account_age_days", "avg_amount_30d",
]


def build_frame(df: pd.DataFrame) -> pd.DataFrame:
    """Turn raw transaction fields into the model's feature matrix."""
    out = pd.DataFrame(index=df.index)
    for c in NUMERIC:
        out[c] = df[c].astype(float)
    avg = df["avg_amount_30d"].astype(float).clip(lower=1.0)
    out["amount_ratio"] = (df["amount"].astype(float) / avg).clip(upper=100)
    out["log_amount"] = np.log1p(df["amount"].astype(float))
    hour = df["txn_hour"].astype(float)
    out["is_night"] = ((hour >= 23) | (hour <= 4)).astype(float)
    for t in TXN_TYPES:
        out[f"type_{t}"] = (df["txn_type"] == t).astype(float)
    for m in MERCHANTS:
        out[f"merchant_{m}"] = (df["merchant_category"] == m).astype(float)
    return out
