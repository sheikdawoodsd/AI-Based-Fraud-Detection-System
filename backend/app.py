"""FastAPI backend: auth-checked fraud scoring, history and stats on top of Supabase."""
import json
import os
from pathlib import Path
from typing import Literal

import httpx
import joblib
import pandas as pd
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from features import MERCHANTS, TXN_TYPES, build_frame

HERE = Path(__file__).parent
FRONTEND = HERE.parent / "frontend"

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://pztozuruszilpzoubftq.supabase.co").rstrip("/")
# Publishable (anon) key: designed to be public; row-level security protects the data.
SUPABASE_KEY = os.environ.get("SUPABASE_ANON_KEY", "sb_publishable_9FYtwds_ONlw3npSNFrP4Q_mV8hZbwK")

bundle = joblib.load(HERE / "model.joblib")
MODEL, COLUMNS, THRESHOLD = bundle["model"], bundle["columns"], bundle["threshold"]
METRICS = json.loads((HERE / "metrics.json").read_text())

app = FastAPI(title="AI Fraud Detection", docs_url=None, redoc_url=None)


class TxnIn(BaseModel):
    amount: float = Field(ge=0, le=1e9)
    txn_hour: int = Field(ge=0, le=23)
    txn_type: Literal[tuple(TXN_TYPES)]  # type: ignore[valid-type]
    merchant_category: Literal[tuple(MERCHANTS)] = "other"  # type: ignore[valid-type]
    is_international: bool = False
    new_device: bool = False
    new_beneficiary: bool = False
    txns_last_24h: int = Field(default=1, ge=0, le=500)
    account_age_days: int = Field(default=365, ge=0, le=36500)
    avg_amount_30d: float = Field(default=0, ge=0, le=1e9)


def explain(t: TxnIn) -> list[str]:
    r = []
    base = t.avg_amount_30d
    if base > 0 and t.amount >= 3 * base:
        r.append(f"Amount is {t.amount / base:.1f}x your 30-day average")
    elif base == 0 and t.amount >= 50000:
        r.append("Very large amount with no spending history")
    if t.txn_hour >= 23 or t.txn_hour <= 4:
        r.append(f"Unusual hour ({t.txn_hour:02d}:00 - late night)")
    if t.is_international:
        r.append("International transaction")
    if t.new_device:
        r.append("Initiated from a new device")
    if t.new_beneficiary:
        r.append("Payment to a new beneficiary")
    if t.txns_last_24h >= 6:
        r.append(f"{t.txns_last_24h} transactions in the last 24 hours (burst activity)")
    if t.account_age_days < 45:
        r.append(f"Recently opened account ({t.account_age_days} days old)")
    if t.merchant_category in ("crypto", "gaming", "jewellery", "electronics") and t.amount >= 10000:
        r.append(f"High-value purchase in a high-risk category ({t.merchant_category})")
    return r


def score(t: TxnIn) -> tuple[float, str]:
    row = pd.DataFrame([t.model_dump()])
    p = float(MODEL.predict_proba(build_frame(row)[COLUMNS])[0, 1])
    risk = round(p * 100, 2)
    if p >= THRESHOLD:
        verdict = "suspicious"
    elif p >= 0.35:
        verdict = "review"
    else:
        verdict = "normal"
    return risk, verdict


async def current_user(authorization: str = Header(default="")) -> dict:
    if not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Not signed in")
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(f"{SUPABASE_URL}/auth/v1/user",
                        headers={"apikey": SUPABASE_KEY, "Authorization": authorization})
    if r.status_code != 200:
        raise HTTPException(401, "Session expired, please sign in again")
    user = r.json()
    user["_token"] = authorization.split(" ", 1)[1]
    return user


def rest_headers(user: dict, **extra) -> dict:
    return {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {user['_token']}", **extra}


@app.get("/api/config")
def config():
    return {"supabase_url": SUPABASE_URL, "supabase_key": SUPABASE_KEY,
            "txn_types": TXN_TYPES, "merchants": MERCHANTS}


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/model")
def model_info(user: dict = Depends(current_user)):
    return {k: v for k, v in METRICS.items() if k != "features"}


@app.post("/api/predict")
async def predict(t: TxnIn, user: dict = Depends(current_user)):
    risk, verdict = score(t)
    reasons = explain(t)
    row = {**t.model_dump(), "risk_score": risk, "verdict": verdict, "reasons": reasons}
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(f"{SUPABASE_URL}/rest/v1/transactions", json=row,
                         headers=rest_headers(user, **{"Content-Type": "application/json",
                                                       "Prefer": "return=representation"}))
    if r.status_code >= 300:
        raise HTTPException(502, f"Could not save result: {r.text[:200]}")
    return r.json()[0]


@app.get("/api/transactions")
async def transactions(limit: int = 200, user: dict = Depends(current_user)):
    limit = max(1, min(limit, 1000))
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(f"{SUPABASE_URL}/rest/v1/transactions",
                        params={"select": "*", "order": "created_at.desc", "limit": limit},
                        headers=rest_headers(user))
    if r.status_code >= 300:
        raise HTTPException(502, "Could not load history")
    return r.json()


@app.delete("/api/transactions/{txn_id}")
async def delete_txn(txn_id: str, user: dict = Depends(current_user)):
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.delete(f"{SUPABASE_URL}/rest/v1/transactions", params={"id": f"eq.{txn_id}"},
                           headers=rest_headers(user))
    if r.status_code >= 300:
        raise HTTPException(502, "Could not delete")
    return {"ok": True}


if FRONTEND.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND / "assets"), name="assets")

    @app.get("/")
    def index():
        return FileResponse(FRONTEND / "index.html")
