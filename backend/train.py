"""Generate a labelled transaction dataset, tune and train the fraud model, evaluate it, save artifacts.

Run:  python train.py
Outputs: model.joblib, metrics.json

There is no real bank data in this project, so the data is synthetic. It is built from the
patterns fraud analysts describe, and deliberately includes the hard cases:
  * genuine payments that look unusual (festival purchases, phone upgrades, travel, night owls)
  * fraud that looks almost normal (account takeover) and card-testing bursts of small amounts
"""
import itertools
import json
import time
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import (average_precision_score, brier_score_loss, confusion_matrix,
                             precision_recall_curve, roc_auc_score)
from sklearn.model_selection import StratifiedKFold, cross_val_predict, train_test_split

from features import MERCHANTS, TXN_TYPES, build_frame

HERE = Path(__file__).parent


def _common(rng, k):
    return pd.DataFrame({"txn_type": rng.choice(TXN_TYPES, k), "merchant_category": rng.choice(MERCHANTS, k)})


def legit(rng, k):
    d = _common(rng, k)
    d["avg_amount_30d"] = rng.lognormal(7.2, 0.8, k).round(2)
    d["amount"] = (d["avg_amount_30d"] * rng.lognormal(0, 0.7, k)).round(2)
    d["txn_hour"] = np.clip(rng.normal(14, 4.5, k), 0, 23).astype(int)
    d["is_international"] = rng.random(k) < 0.03
    d["new_device"] = rng.random(k) < 0.05
    d["new_beneficiary"] = rng.random(k) < 0.12
    d["txns_last_24h"] = rng.poisson(2.0, k)
    d["account_age_days"] = rng.integers(60, 3650, k)
    d["is_fraud"] = 0
    # hard negatives: genuine but unusual (about 14% of genuine payments)
    h = rng.random(k)
    big = h < 0.04          # festival / wedding purchases: big amount, electronics or jewellery
    d.loc[big, "amount"] = (d.loc[big, "avg_amount_30d"] * rng.lognormal(1.5, 0.5, big.sum())).round(2)
    d.loc[big, "merchant_category"] = rng.choice(["electronics", "jewellery", "travel"], big.sum())
    night = (h >= 0.04) & (h < 0.08)    # night owls and shift workers
    d.loc[night, "txn_hour"] = rng.choice([23, 0, 1, 2, 3, 4], night.sum())
    phone = (h >= 0.08) & (h < 0.11)    # bought a new phone, pays a new person
    d.loc[phone, "new_device"] = True
    d.loc[phone, "new_beneficiary"] = rng.random(phone.sum()) < 0.5
    trip = (h >= 0.11) & (h < 0.13)     # travelling abroad
    d.loc[trip, "is_international"] = True
    d.loc[trip, "txns_last_24h"] = rng.poisson(4, trip.sum())
    new = (h >= 0.13) & (h < 0.14)      # genuinely new account
    d.loc[new, "account_age_days"] = rng.integers(5, 60, new.sum())
    return d


def fraud(rng, k):
    n_blatant, n_ato = int(k * 0.55), int(k * 0.30)
    n_test = k - n_blatant - n_ato
    parts = []

    b = _common(rng, n_blatant)  # blatant: huge amount, odd hour, new device and payee
    b["merchant_category"] = rng.choice(MERCHANTS, n_blatant, p=[.04, .05, .12, .22, .17, .12, .20, .01, .07])
    b["txn_type"] = rng.choice(TXN_TYPES, n_blatant, p=[.22, .30, .05, .20, .10, .13])
    b["avg_amount_30d"] = rng.lognormal(7.0, 0.8, n_blatant).round(2)
    b["amount"] = (b["avg_amount_30d"] * rng.lognormal(1.6, 0.9, n_blatant)).round(2)
    night = rng.random(n_blatant) < 0.6
    b["txn_hour"] = np.where(night, rng.choice([0, 1, 2, 3, 4, 23], n_blatant), rng.integers(5, 23, n_blatant))
    b["is_international"] = rng.random(n_blatant) < 0.35
    b["new_device"] = rng.random(n_blatant) < 0.62
    b["new_beneficiary"] = rng.random(n_blatant) < 0.66
    b["txns_last_24h"] = rng.poisson(6.5, n_blatant)
    b["account_age_days"] = np.where(rng.random(n_blatant) < 0.35, rng.integers(1, 60, n_blatant), rng.integers(60, 3650, n_blatant))
    parts.append(b)

    a = _common(rng, n_ato)  # account takeover: amounts look normal, but device and payee are new
    a["avg_amount_30d"] = rng.lognormal(7.2, 0.8, n_ato).round(2)
    a["amount"] = (a["avg_amount_30d"] * rng.lognormal(0.5, 0.6, n_ato)).round(2)
    a["txn_hour"] = np.where(rng.random(n_ato) < 0.35, rng.choice([0, 1, 2, 3, 4, 23], n_ato), rng.integers(6, 23, n_ato))
    a["is_international"] = rng.random(n_ato) < 0.12
    a["new_device"] = rng.random(n_ato) < 0.88
    a["new_beneficiary"] = rng.random(n_ato) < 0.88
    a["txns_last_24h"] = rng.poisson(4, n_ato)
    a["account_age_days"] = rng.integers(60, 3650, n_ato)
    parts.append(a)

    t = _common(rng, n_test)  # card testing: bursts of small payments
    t["merchant_category"] = rng.choice(["gaming", "crypto", "electronics", "other", "food"], n_test)
    t["txn_type"] = rng.choice(["card_online", "wallet", "upi"], n_test)
    t["avg_amount_30d"] = rng.lognormal(7.0, 0.8, n_test).round(2)
    t["amount"] = (t["avg_amount_30d"] * rng.uniform(0.15, 0.9, n_test)).round(2)
    t["txn_hour"] = np.where(rng.random(n_test) < 0.5, rng.choice([0, 1, 2, 3, 4, 23], n_test), rng.integers(5, 23, n_test))
    t["is_international"] = rng.random(n_test) < 0.5
    t["new_device"] = rng.random(n_test) < 0.4
    t["new_beneficiary"] = rng.random(n_test) < 0.7
    t["txns_last_24h"] = rng.poisson(11, n_test)
    t["account_age_days"] = rng.integers(10, 3650, n_test)
    parts.append(t)

    d = pd.concat(parts, ignore_index=True)
    d["is_fraud"] = 1
    return d


def generate(seed: int, n: int, fraud_rate: float = 0.05) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    n_f = int(n * fraud_rate)
    df = pd.concat([legit(rng, n - n_f), fraud(rng, n_f)], ignore_index=True).sample(frac=1, random_state=seed).reset_index(drop=True)
    for c in ("is_international", "new_device", "new_beneficiary"):
        df[c] = df[c].astype(int)
    flip = rng.random(len(df)) < 0.008  # label noise: real data is never perfectly clean
    df.loc[flip, "is_fraud"] = 1 - df.loc[flip, "is_fraud"]
    return df


def best_threshold(y, p):
    prec, rec, thr = precision_recall_curve(y, p)
    f1 = 2 * prec * rec / np.clip(prec + rec, 1e-9, None)
    i = int(np.nanargmax(f1[:-1]))
    return float(thr[i])


def report(y, p, thr):
    pred = (p >= thr).astype(int)
    tn, fp, fn, tp = confusion_matrix(y, pred).ravel()
    prec, rec = tp / max(tp + fp, 1), tp / max(tp + fn, 1)
    return {"precision": round(prec, 4), "recall": round(rec, 4), "f1": round(2 * prec * rec / max(prec + rec, 1e-9), 4),
            "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
            "roc_auc": round(float(roc_auc_score(y, p)), 4), "pr_auc": round(float(average_precision_score(y, p)), 4),
            "brier": round(float(brier_score_loss(y, p)), 5)}


def main():
    t0 = time.time()
    df = generate(seed=42, n=120000)
    X, y = build_frame(df), df["is_fraud"]
    X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.2, stratify=y, random_state=7)

    # 1) tune with 3-fold cross-validation on the training part only
    grid = [dict(max_depth=d, learning_rate=lr, l2_regularization=l2, min_samples_leaf=msl)
            for d, lr, l2, msl in itertools.product([4, 6, 8], [0.05, 0.1], [1.0, 5.0], [40])]
    skf = StratifiedKFold(3, shuffle=True, random_state=1)
    best, best_score = None, -1
    for params in grid:
        m = HistGradientBoostingClassifier(max_iter=250, early_stopping=True, validation_fraction=0.12, random_state=7, **params)
        oof = cross_val_predict(m, X_tr, y_tr, cv=skf, method="predict_proba")[:, 1]
        s = average_precision_score(y_tr, oof)
        print(f"  {params} -> CV PR-AUC {s:.4f}")
        if s > best_score:
            best, best_score, best_oof = params, s, oof
    print("best:", best, round(best_score, 4))

    # 2) thresholds from out-of-fold predictions (so the test set stays untouched)
    thr = best_threshold(y_tr, best_oof)
    prec, rec, thr_all = precision_recall_curve(y_tr, best_oof)
    ok = np.where(rec[:-1] >= 0.92)[0]
    review = float(thr_all[ok[-1]]) if len(ok) else thr / 2
    review = float(np.clip(review, 0.15, thr * 0.7))

    # 3) final model on all training data, honest evaluation on the untouched test set
    model = HistGradientBoostingClassifier(max_iter=400, early_stopping=True, validation_fraction=0.12, random_state=7, **best)
    model.fit(X_tr, y_tr)
    p_te = model.predict_proba(X_te)[:, 1]
    test = report(y_te, p_te, thr)
    legit_te = p_te[y_te.values == 0]
    review_rate = float(((legit_te >= review) & (legit_te < thr)).mean())

    # 4) a completely fresh dataset from a different seed, as a second check
    fresh = generate(seed=2026, n=40000)
    p_fr = model.predict_proba(build_frame(fresh)[list(X.columns)])[:, 1]
    fresh_rep = report(fresh["is_fraud"], p_fr, thr)

    # 5) is the percentage honest? compare predicted risk with the real fraud rate in each band
    bands = []
    for lo, hi in [(0, .05), (.05, .2), (.2, .5), (.5, .8), (.8, 1.01)]:
        m_ = (p_te >= lo) & (p_te < hi)
        if m_.sum():
            bands.append({"predicted": f"{int(lo*100)}-{min(int(hi*100),100)}%", "payments": int(m_.sum()), "actual_fraud": round(float(y_te.values[m_].mean()), 3)})

    metrics = {
        "trained_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "data": "synthetic, pattern-based (not real bank data)",
        "rows": int(len(df)), "train_rows": int(len(X_tr)), "test_rows": int(len(X_te)),
        "fraud_rate": round(float(y.mean()), 4),
        "roc_auc": test["roc_auc"], "pr_auc": test["pr_auc"], "brier": test["brier"],
        "threshold": round(thr, 4), "review_threshold": round(review, 4),
        "precision": test["precision"], "recall": test["recall"], "f1": test["f1"], "confusion": test["confusion"],
        "cv_pr_auc": round(best_score, 4), "best_params": best,
        "fresh_data_check": {"rows": int(len(fresh)), **{k: fresh_rep[k] for k in ("precision", "recall", "f1", "roc_auc")}},
        "genuine_sent_to_review_rate": round(review_rate, 4),
        "calibration": bands,
        "features": list(X.columns),
    }
    joblib.dump({"model": model, "columns": list(X.columns), "threshold": thr, "review": review}, HERE / "model.joblib", compress=3)
    (HERE / "metrics.json").write_text(json.dumps(metrics, indent=2))
    print(json.dumps({k: v for k, v in metrics.items() if k != "features"}, indent=2))
    print(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
