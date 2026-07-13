import os
import time
import sqlite3
import hashlib
from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional

app = FastAPI(title="Analytics Engine", version="1.0.0")

PORT = int(os.environ.get("PORT", 8000))
DB_PATH = os.environ.get("DB_PATH", "/opt/app-root/src/data/analytics.db")

os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS processing_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            operation TEXT NOT NULL,
            input_size INTEGER,
            processing_time_ms REAL,
            timestamp TEXT DEFAULT (datetime('now'))
        )
    """)
    conn.commit()
    conn.close()


init_db()


class ProcessRequest(BaseModel):
    data: list
    operation: Optional[str] = "summary"


class ProcessResponse(BaseModel):
    operation: str
    result: dict
    processing_time_ms: float


@app.get("/healthz")
def health():
    return {"service": "analytics-engine", "status": "healthy"}


@app.post("/process", response_model=ProcessResponse)
def process_data(request: ProcessRequest):
    start = time.time()

    if request.operation == "summary":
        numeric = [x for x in request.data if isinstance(x, (int, float))]
        result = {
            "count": len(request.data),
            "numeric_count": len(numeric),
            "sum": sum(numeric) if numeric else 0,
            "average": sum(numeric) / len(numeric) if numeric else 0,
            "min": min(numeric) if numeric else None,
            "max": max(numeric) if numeric else None
        }

    elif request.operation == "hash":
        result = {
            "hashes": [
                {"value": str(item), "sha256": hashlib.sha256(str(item).encode()).hexdigest()}
                for item in request.data
            ]
        }

    elif request.operation == "sort":
        try:
            sorted_data = sorted(request.data)
        except TypeError:
            sorted_data = sorted(request.data, key=str)
        result = {"sorted": sorted_data, "count": len(sorted_data)}

    elif request.operation == "simulate":
        duration = 1.5
        time.sleep(duration)
        result = {
            "simulated_records": len(request.data),
            "simulation_duration_s": duration,
            "outcome": "completed"
        }

    else:
        result = {"echo": request.data, "note": f"Unknown operation '{request.operation}', echoing input"}

    elapsed_ms = round((time.time() - start) * 1000, 2)

    conn = get_db()
    conn.execute(
        "INSERT INTO processing_history (operation, input_size, processing_time_ms) VALUES (?, ?, ?)",
        (request.operation, len(request.data), elapsed_ms)
    )
    conn.commit()
    conn.close()

    return ProcessResponse(operation=request.operation, result=result, processing_time_ms=elapsed_ms)


@app.get("/stats")
def get_stats():
    conn = get_db()
    total = conn.execute("SELECT COUNT(*) as cnt FROM processing_history").fetchone()["cnt"]
    avg = conn.execute("SELECT COALESCE(AVG(processing_time_ms), 0) as avg FROM processing_history").fetchone()["avg"]
    last = conn.execute("SELECT timestamp FROM processing_history ORDER BY id DESC LIMIT 1").fetchone()
    by_op = conn.execute(
        "SELECT operation, COUNT(*) as count, ROUND(AVG(processing_time_ms), 2) as avg_ms FROM processing_history GROUP BY operation"
    ).fetchall()
    conn.close()

    return {
        "total_processed": total,
        "average_processing_time_ms": round(avg, 2),
        "last_processed_at": last["timestamp"] if last else None,
        "by_operation": [dict(row) for row in by_op]
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
