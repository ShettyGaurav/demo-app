import os
import json
import time
import psycopg2
import redis

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
TASK_QUEUE = os.environ.get("TASK_QUEUE", "task_queue")
TASK_EVENTS_CHANNEL = os.environ.get("TASK_EVENTS_CHANNEL", "task_events")
BLOCK_TIMEOUT = int(os.environ.get("BLOCK_TIMEOUT", "5"))
DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://worker:worker@localhost:5432/workerdb")


def get_db_connection():
    return psycopg2.connect(DATABASE_URL)


def init_db():
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS completed_tasks (
            id TEXT PRIMARY KEY,
            type TEXT,
            status TEXT,
            processing_time_s REAL,
            input_summary TEXT,
            completed_at TEXT
        )
    """)
    conn.commit()
    cur.close()
    conn.close()


def save_result(result):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        """INSERT INTO completed_tasks (id, type, status, processing_time_s, input_summary, completed_at)
           VALUES (%s, %s, %s, %s, %s, %s)
           ON CONFLICT (id) DO UPDATE SET
             type = EXCLUDED.type, status = EXCLUDED.status,
             processing_time_s = EXCLUDED.processing_time_s,
             input_summary = EXCLUDED.input_summary,
             completed_at = EXCLUDED.completed_at""",
        (result["task_id"], result["type"], result["status"], result["processing_time_s"],
         json.dumps(result.get("input_keys", [])), result["completed_at"])
    )
    conn.commit()
    cur.close()
    conn.close()


def connect_redis():
    while True:
        try:
            client = redis.Redis.from_url(REDIS_URL, decode_responses=True)
            client.ping()
            print(f"Worker connected to Redis at {REDIS_URL}")
            return client
        except redis.ConnectionError as e:
            print(f"Redis not ready: {e}. Retrying in 3s...")
            time.sleep(3)


def process_task(task_data):
    task = json.loads(task_data)
    task_id = task.get("id", "unknown")
    task_type = task.get("type", "default")
    payload = task.get("payload", {})

    print(f"Processing task {task_id} (type={task_type})")

    duration = 2.0
    time.sleep(duration)

    result = {
        "task_id": task_id,
        "type": task_type,
        "status": "completed",
        "processing_time_s": round(duration, 3),
        "input_keys": list(payload.keys()) if isinstance(payload, dict) else len(payload),
        "completed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    }

    print(f"Task {task_id} completed in {duration:.2f}s")
    return result


def main():
    print("Task Worker starting...")
    print(f"  Queue: {TASK_QUEUE}")
    print(f"  Events channel: {TASK_EVENTS_CHANNEL}")
    print(f"  Database: {DATABASE_URL}")

    init_db()
    r = connect_redis()
    processed = 0

    print("Waiting for tasks...")
    while True:
        try:
            item = r.brpop(TASK_QUEUE, timeout=BLOCK_TIMEOUT)

            if item is None:
                continue

            queue_name, task_data = item
            processed += 1
            print(f"\n--- Task #{processed} received from '{queue_name}' ---")

            result = process_task(task_data)
            save_result(result)

            event = json.dumps(result)
            r.publish(TASK_EVENTS_CHANNEL, event)
            print(f"Published completion event for task {result['task_id']}")

        except redis.ConnectionError as e:
            print(f"Redis connection lost: {e}. Reconnecting...")
            r = connect_redis()
        except json.JSONDecodeError as e:
            print(f"Invalid task JSON: {e}")
        except KeyboardInterrupt:
            print(f"\nWorker shutting down. Processed {processed} tasks total.")
            break


if __name__ == "__main__":
    main()
