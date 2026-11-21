"""Generate a labelled transaction dataset, train the fraud model, evaluate it, save artifacts.

Run:  python train.py
Outputs: model.joblib, metrics.json
"""
import json
import time
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import (average_precision_score, classification_report,
                             confusion_matrix, precision_recall_curve, roc_auc_score)
from sklearn.model_selection import train_test_split

from features import MERCHANTS, TXN_TYPES, build_frame

HERE = Path(__file__).parent
RNG = np.random.default_rng(42)


def generate(n: int = 60000, fraud_rate: float = 0.06) -> pd.DataFrame:
    """Synthetic but pattern-realistic data: fraud correlates with night hours, large amounts
    relative to the user's norm, new devices/beneficiaries, international use, bursts and new accounts."""
    n_fraud = int(n * fraud_rate)
    n_ok = n - n_fraud

    def common(k):
        return pd.DataFrame({
            "txn_type": RNG.choice(TXN_TYPES, k),
            "merchant_category": RNG.choice(MERCHANTS, k),
        })

    # ---- legitimate ----
    ok = common(n_ok)
    ok["avg_amount_30d"] = RNG.lognormal(7.2, 0.8, n_ok).round(2)
    ok["amount"] = (ok["avg_amount_30d"] * RNG.lognormal(0, 0.7, n_ok)).round(2)
    ok["txn_hour"] = np.clip(RNG.normal(14, 4.5, n_ok), 0, 23).astype(int)
    ok["is_international"] = RNG.random(n_ok) < 0.04
    ok["new_device"] = RNG.random(n_ok) < 0.07
    ok["new_beneficiary"] = RNG.random(n_ok) < 0.12
    ok["txns_last_24h"] = RNG.poisson(2.0, n_ok)
    ok["account_age_days"] = RNG.integers(30, 3650, n_ok)
    ok["is_fraud"] = 0

    # ---- fraudulent ----
    fr = common(n_fraud)
    fr["merchant_category"] = RNG.choice(
        MERCHANTS, n_fraud, p=[.04, .05, .12, .22, .17, .12, .20, .01, .07])
    fr["txn_type"] = RNG.choice(TXN_TYPES, n_fraud, p=[.22, .30, .05, .20, .10, .13])
    fr["avg_amount_30d"] = RNG.lognormal(7.0, 0.8, n_fraud).round(2)
    fr["amount"] = (fr["avg_amount_30d"] * RNG.lognormal(1.6, 0.9, n_fraud)).round(2)
    night = RNG.random(n_fraud) < 0.62
    fr["txn_hour"] = np.where(night, RNG.choice([0, 1, 2, 3, 4, 23], n_fraud), RNG.integers(5, 23, n_fraud))
    fr["is_international"] = RNG.random(n_fraud) < 0.38
    fr["new_device"] = RNG.random(n_fraud) < 0.62
    fr["new_beneficiary"] = RNG.random(n_fraud) < 0.66
    fr["txns_last_24h"] = RNG.poisson(6.5, n_fraud)
    fr["account_age_days"] = np.where(RNG.random(n_fraud) < 0.35,
                                      RNG.integers(1, 45, n_fraud), RNG.integers(30, 3650, n_fraud))
    fr["is_fraud"] = 1

    df = pd.concat([ok, fr], ignore_index=True).sample(frac=1, random_state=1).reset_index(drop=True)
    for c in ("is_international", "new_device", "new_beneficiary"):
        df[c] = df[c].astype(int)
    # label noise: real data is never perfectly separable
    flip = RNG.random(len(df)) < 0.01
    df.loc[flip, "is_fraud"] = 1 - df.loc[flip, "is_fraud"]
    return df


def main():
    t0 = time.time()
    df = generate()
    X, y = build_frame(df), df["is_fraud"]
    X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.2, stratify=y, random_state=7)

    model = HistGradientBoostingClassifier(
        max_iter=300, learning_rate=0.06, max_depth=6, l2_regularization=1.0,
        class_weight="balanced", random_state=7, early_stopping=True, validation_fraction=0.15)
    model.fit(X_tr, y_tr)

    proba = model.predict_proba(X_te)[:, 1]
    prec, rec, thr = precision_recall_curve(y_te, proba)
    f1 = 2 * prec * rec / np.clip(prec + rec, 1e-9, None)
    best = int(np.nanargmax(f1[:-1]))
    threshold = float(thr[best])
    pred = (proba >= threshold).astype(int)
    tn, fp, fn, tp = confusion_matrix(y_te, pred).ravel()

    metrics = {
        "trained_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "data": "synthetic, pattern-based (not real bank data)",
        "rows": int(len(df)), "train_rows": int(len(X_tr)), "test_rows": int(len(X_te)),
        "fraud_rate": round(float(y.mean()), 4),
        "roc_auc": round(float(roc_auc_score(y_te, proba)), 4),
        "pr_auc": round(float(average_precision_score(y_te, proba)), 4),
        "threshold": round(threshold, 4),
        "precision": round(float(prec[best]), 4),
        "recall": round(float(rec[best]), 4),
        "f1": round(float(f1[best]), 4),
        "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
        "features": list(X.columns),
    }
    joblib.dump({"model": model, "columns": list(X.columns), "threshold": threshold}, HERE / "model.joblib", compress=3)
    (HERE / "metrics.json").write_text(json.dumps(metrics, indent=2))
    print(classification_report(y_te, pred, target_names=["normal", "fraud"], digits=3))
    print(json.dumps({k: v for k, v in metrics.items() if k != "features"}, indent=2))
    print(f"done in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
