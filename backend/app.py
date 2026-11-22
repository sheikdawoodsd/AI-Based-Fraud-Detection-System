"""FastAPI backend: auth-checked fraud scoring, history and stats on top of Supabase."""
import json
import math
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import httpx
import joblib
import pandas as pd
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.concurrency import run_in_threadpool
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

_shared: httpx.AsyncClient | None = None


@asynccontextmanager
async def client():
    """One shared HTTP client: Supabase connections are reused, so there is no new TLS handshake per request."""
    global _shared
    if _shared is None or _shared.is_closed:
        _shared = httpx.AsyncClient(timeout=15, limits=httpx.Limits(max_keepalive_connections=10, keepalive_expiry=60))
    yield _shared


UPI_RE = re.compile(r"^[a-z0-9._\-]{2,}@[a-z][a-z0-9]{1,}$")


class Core(BaseModel):
    """Fields the model scores on. Account age is asked in whole years only."""
    amount: float = Field(ge=0, le=1e9)
    txn_hour: int = Field(ge=0, le=23)
    txn_type: Literal[tuple(TXN_TYPES)]  # type: ignore[valid-type]
    merchant_category: Literal[tuple(MERCHANTS)] = "other"  # type: ignore[valid-type]
    is_international: bool = False
    new_device: bool = False
    new_beneficiary: bool = False
    txns_last_24h: int = Field(default=1, ge=0, le=500)
    account_age_years: int = Field(default=1, ge=0, le=80)  # 0 means less than 1 year
    avg_amount_30d: float = Field(default=0, ge=0, le=1e9)

    @property
    def age_days(self) -> int:
        # "Less than 1 year" is stored as about half a year; otherwise whole years.
        return 180 if self.account_age_years == 0 else self.account_age_years * 365

    def feature_row(self) -> dict:
        d = self.model_dump(exclude={"account_age_years"})
        d["account_age_days"] = self.age_days
        if not d["avg_amount_30d"]:  # usual amount unknown: compare against a typical user instead of 1 rupee
            d["avg_amount_30d"] = TYPICAL_AVG
        return d


class PreviewIn(Core):
    receiver_id: str | None = Field(default=None, max_length=60, pattern=r"^[A-Za-z0-9@._\-]+$")


class TxnIn(Core):
    txn_ref: str = Field(min_length=6, max_length=40, pattern=r"^[A-Za-z0-9_\-]+$")
    sender_name: str = Field(min_length=1, max_length=80)
    receiver_name: str = Field(min_length=1, max_length=80)
    receiver_id: str = Field(min_length=3, max_length=60, pattern=r"^[A-Za-z0-9@._\-]+$")
    note: str | None = Field(default=None, max_length=200)


TYPICAL_AVG = 1300.0
MERCH_LABEL = {"electronics": "Electronics", "jewellery": "Jewellery", "gaming": "Gaming", "crypto": "Crypto"}


def _logit(p: float) -> float:
    p = min(max(p, 1e-4), 1 - 1e-4)
    return math.log(p / (1 - p))


def _probs(rows: list[dict]) -> list[float]:
    X = build_frame(pd.DataFrame(rows))[COLUMNS]
    return [float(p) for p in MODEL.predict_proba(X)[:, 1]]


def strength(drop: float) -> str:
    return "high" if drop >= 1.5 else "medium" if drop >= 0.7 else "low"


def model_reasons(t: Core, p0: float) -> list[str]:
    """Why is the risk what it is? Every unusual signal is switched between 'as entered' and
    'normal value', all combinations are scored by the model, and each signal's share of the
    risk is computed exactly (Shapley values on the log-odds scale)."""
    base = t.feature_row()
    avg = t.avg_amount_30d
    cands: list[tuple[str, dict]] = []
    if avg > 0 and t.amount >= 2 * avg:
        cands.append((f"Amount \u20b9{t.amount:,.0f} is {t.amount / avg:.1f}x your usual payment of \u20b9{avg:,.0f}", {"amount": avg}))
    elif avg == 0 and t.amount >= 20000:
        cands.append((f"Large amount (\u20b9{t.amount:,.0f}) and no usual payment amount to compare with", {"amount": TYPICAL_AVG}))
    if t.txn_hour >= 23 or t.txn_hour <= 4:
        cands.append((f"Paid at an unusual hour ({t.txn_hour:02d}:00, late night)", {"txn_hour": 14}))
    if t.is_international:
        cands.append(("International payment", {"is_international": 0}))
    if t.new_device:
        cands.append(("Made from a new device", {"new_device": 0}))
    if t.new_beneficiary:
        cands.append(("Paying a new beneficiary", {"new_beneficiary": 0}))
    if t.txns_last_24h >= 5:
        cands.append((f"{t.txns_last_24h} payments in the last 24 hours (sudden burst)", {"txns_last_24h": 2}))
    if t.account_age_years == 0:
        cands.append(("Sender account is less than 1 year old", {"account_age_days": 1500}))
    if t.merchant_category in MERCH_LABEL:
        cands.append((f"Paid for {MERCH_LABEL[t.merchant_category]}, a category fraudsters often use", {"merchant_category": "grocery"}))
    n = len(cands)
    if n == 0:
        return []
    rows = []
    for mask in range(1 << n):  # bit i set = signal i kept as entered, else set to a normal value
        row = dict(base)
        for i, (_, change) in enumerate(cands):
            if not mask >> i & 1:
                row.update(change)
        rows.append(row)
    f = [_logit(p) for p in _probs(rows)]
    fact = [math.factorial(k) for k in range(n + 1)]
    phi = [0.0] * n
    for mask in range(1 << n):
        k = bin(mask).count("1")
        for i in range(n):
            if not mask >> i & 1:
                phi[i] += fact[k] * fact[n - k - 1] / fact[n] * (f[mask | 1 << i] - f[mask])
    scored = sorted(zip(phi, (c[0] for c in cands)), reverse=True)
    keep = [(d, x) for d, x in scored if d >= 0.05]
    if not keep and p0 >= 0.35:  # risky overall but no single signal stands out: show the strongest
        keep = [(d, x) for d, x in scored[:2] if d > 0]
    return [f"{x} ({strength(d)} impact)" for d, x in keep]


def score(t: Core) -> tuple[float, str, list[str]]:
    p = _probs([t.feature_row()])[0]
    verdict = "suspicious" if p >= THRESHOLD else "review" if p >= 0.35 else "normal"
    return round(p * 100, 2), verdict, model_reasons(t, p)


async def current_user(authorization: str = Header(default="")) -> dict:
    if not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Not signed in")
    async with client() as c:
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


async def analyze(t: Core, receiver_id: str | None, user: dict, c: httpx.AsyncClient):
    """Model score and reasons, plus checks on the receiver's history."""
    risk, verdict, reasons = await run_in_threadpool(score, t)
    past: list = []
    if receiver_id:
        hist = await c.get(f"{SUPABASE_URL}/rest/v1/transactions",
                           params={"select": "verdict", "receiver_id": f"eq.{receiver_id}", "limit": 200},
                           headers=rest_headers(user))
        past = hist.json() if hist.status_code < 300 else []
        flagged = sum(1 for p in past if p["verdict"] == "suspicious")
        if flagged:
            reasons.insert(0, f"This receiver was flagged as likely fraud in {flagged} earlier check{'s' if flagged > 1 else ''} (high impact)")
            risk, verdict = max(risk, 90.0), "suspicious"
        if t.txn_type == "upi" and not UPI_RE.match(receiver_id):
            reasons.append("Receiver UPI ID does not look valid (medium impact)")
            risk = max(risk, 45.0)
            if verdict == "normal":
                verdict = "review"
        if not past and t.amount >= 25000:
            reasons.append("First payment to this receiver and the amount is large (medium impact)")
            if verdict == "normal":
                risk, verdict = max(risk, 40.0), "review"
    return risk, verdict, reasons, past


@app.post("/api/preview")
async def preview(t: PreviewIn, user: dict = Depends(current_user)):
    """Live result while the form is being filled in. Nothing is saved."""
    rid = t.receiver_id.lower() if t.receiver_id and len(t.receiver_id) >= 3 else None
    async with client() as c:
        risk, verdict, reasons, past = await analyze(t, rid, user, c)
    return {"risk_score": risk, "verdict": verdict, "reasons": reasons, "receiver_checks": len(past)}


@app.post("/api/predict")
async def predict(t: TxnIn, user: dict = Depends(current_user)):
    t.txn_ref = t.txn_ref.upper()
    t.receiver_id = t.receiver_id.lower()

    async with client() as c:
        dup = await c.get(f"{SUPABASE_URL}/rest/v1/transactions",
                          params={"select": "id", "txn_ref": f"eq.{t.txn_ref}", "limit": 1},
                          headers=rest_headers(user))
        if dup.status_code < 300 and dup.json():
            raise HTTPException(409, f"Transaction ID {t.txn_ref} was already checked. Open it in Track to see the result.")
        risk, verdict, reasons, past = await analyze(t, t.receiver_id, user, c)

        row = {**t.model_dump(exclude={"account_age_years"}), "account_age_days": t.age_days,
               "risk_score": risk, "verdict": verdict, "reasons": reasons}
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
    async with client() as c:
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
    async with client() as c:
        r = await c.get(f"{SUPABASE_URL}/rest/v1/transactions",
                        params={"select": "*", "order": "created_at.desc", "limit": limit},
                        headers=rest_headers(user))
    if r.status_code >= 300:
        raise HTTPException(502, "Could not load history")
    return r.json()


@app.delete("/api/transactions/{txn_id}")
async def delete_txn(txn_id: str, user: dict = Depends(current_user)):
    async with client() as c:
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
