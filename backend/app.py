"""FastAPI backend: auth-checked fraud scoring, history and stats on top of Supabase."""
import json
import os
import re
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


UPI_RE = re.compile(r"^[a-z0-9._\-]{2,}@[a-z][a-z0-9]{1,}$")


class TxnIn(BaseModel):
    txn_ref: str = Field(min_length=6, max_length=40, pattern=r"^[A-Za-z0-9_\-]+$")
    sender_name: str = Field(min_length=1, max_length=80)
    receiver_name: str = Field(min_length=1, max_length=80)
    receiver_id: str = Field(min_length=3, max_length=60, pattern=r"^[A-Za-z0-9@._\-]+$")
    note: str | None = Field(default=None, max_length=200)
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
    t.txn_ref = t.txn_ref.upper()
    t.receiver_id = t.receiver_id.lower()
    risk, verdict = score(t)
    reasons = explain(t)

    async with httpx.AsyncClient(timeout=15) as c:
        dup = await c.get(f"{SUPABASE_URL}/rest/v1/transactions",
                          params={"select": "id", "txn_ref": f"eq.{t.txn_ref}", "limit": 1},
                          headers=rest_headers(user))
        if dup.status_code < 300 and dup.json():
            raise HTTPException(409, f"Transaction ID {t.txn_ref} was already checked. Open it in Track to see the result.")
        hist = await c.get(f"{SUPABASE_URL}/rest/v1/transactions",
                           params={"select": "verdict", "receiver_id": f"eq.{t.receiver_id}", "limit": 200},
                           headers=rest_headers(user))
        past = hist.json() if hist.status_code < 300 else []

        flagged = sum(1 for p in past if p["verdict"] == "suspicious")
        if flagged:
            reasons.insert(0, f"This receiver was flagged as likely fraud in {flagged} earlier check{'s' if flagged > 1 else ''}")
            risk, verdict = max(risk, 90.0), "suspicious"
        if t.txn_type == "upi" and not UPI_RE.match(t.receiver_id):
            reasons.append("Receiver UPI ID does not look valid")
            risk = max(risk, 45.0)
            if verdict == "normal":
                verdict = "review"
        if not past and t.amount >= 25000:
            reasons.append("First payment to this receiver and the amount is large")
            if verdict == "normal":
                risk, verdict = max(risk, 40.0), "review"

        row = {**t.model_dump(), "risk_score": risk, "verdict": verdict, "reasons": reasons}
        r = await c.post(f"{SUPABASE_URL}/rest/v1/transactions", json=row,
                         headers=rest_headers(user, **{"Content-Type": "application/json",
                                                       "Prefer": "return=representation"}))
    if r.status_code == 409:
        raise HTTPException(409, f"Transaction ID {t.txn_ref} was already checked.")
    if r.status_code >= 300:
        raise HTTPException(502, f"Could not save result: {r.text[:200]}")
    out = r.json()[0]
    out["receiver_checks"] = len(past)
    return out


@app.get("/api/lookup/{ref}")
async def lookup(ref: str, user: dict = Depends(current_user)):
    ref = ref.strip().upper()
    if not re.fullmatch(r"[A-Z0-9_\-]{3,40}", ref):
        raise HTTPException(422, "Transaction IDs use letters, numbers, dashes and underscores only.")
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(f"{SUPABASE_URL}/rest/v1/transactions",
                        params={"select": "*", "txn_ref": f"eq.{ref}", "limit": 1},
                        headers=rest_headers(user))
        if r.status_code >= 300:
            raise HTTPException(502, "Could not search right now. Try again.")
        rows = r.json()
        if not rows:
            raise HTTPException(404, f"No transaction with ID {ref} has been checked yet. Check it first, then it will appear here.")
        txn = rows[0]
        rel = await c.get(f"{SUPABASE_URL}/rest/v1/transactions",
                          params={"select": "txn_ref,amount,verdict,created_at", "receiver_id": f"eq.{txn['receiver_id']}",
                                  "id": f"neq.{txn['id']}", "order": "created_at.desc", "limit": 5},
                          headers=rest_headers(user))
    return {"txn": txn, "related": rel.json() if rel.status_code < 300 else []}


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
