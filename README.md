# FraudShield AI

Website that checks whether an online payment looks normal or suspicious using machine learning.

- **Frontend:** plain HTML/CSS/JS in `frontend/` (login, dashboard, check payment, history, reports, model page)
- **Backend:** FastAPI in `backend/` (`app.py`), serves the API and the frontend
- **Model:** gradient boosting classifier (`train.py` trains and evaluates; `model.joblib` is the saved result)
- **Database and login:** Supabase (tables `profiles`, `transactions`, row-level security per user)

## Run locally

```bash
cd backend
pip install -r requirements.txt
python train.py          # optional: retrain, writes model.joblib and metrics.json
uvicorn app:app --reload
```

Open http://localhost:8000.

## Environment variables (optional)

`SUPABASE_URL` and `SUPABASE_ANON_KEY` override the built-in project values. The anon key is a public key; data is protected by row-level security.

## Note

The model is trained on generated data that follows common fraud patterns, not real bank records. It is a checking tool and cannot stop or reverse real payments.
