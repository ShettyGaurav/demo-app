const express = require('express');
const axios = require('axios');
const Redis = require('ioredis');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const ANALYTICS_ENGINE_URL = process.env.ANALYTICS_ENGINE_URL || 'http://localhost:8000';
const HEALTH_AGGREGATOR_URL = process.env.HEALTH_AGGREGATOR_URL || 'http://localhost:3003';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const TASK_QUEUE = process.env.TASK_QUEUE || 'task_queue';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://gateway:gateway@localhost:5432/gatewaydb'
});

const redis = new Redis(REDIS_URL, {
  retryStrategy: (times) => Math.min(times * 200, 5000),
  maxRetriesPerRequest: 3
});

redis.on('connect', () => console.log('Gateway connected to Redis'));
redis.on('error', (err) => console.error('Redis error:', err.message));

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT,
      status TEXT DEFAULT 'queued',
      created_at TIMESTAMP NOT NULL,
      updated_at TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS request_log (
      id SERIAL PRIMARY KEY,
      method TEXT,
      path TEXT,
      status_code INTEGER,
      timestamp TIMESTAMP DEFAULT NOW()
    );
  `);
}

initDB().then(() => console.log('Gateway DB initialized'))
  .catch(err => { console.error('DB init failed:', err.message); process.exit(1); });

app.use((req, res, next) => {
  res.on('finish', () => {
    pool.query('INSERT INTO request_log (method, path, status_code) VALUES ($1, $2, $3)', [req.method, req.path, res.statusCode])
      .catch(err => console.error('Failed to log request:', err.message));
  });
  next();
});

app.get('/healthz', (req, res) => {
  res.json({ service: 'api-gateway', status: 'healthy', timestamp: new Date().toISOString() });
});

app.post('/auth/login', async (req, res) => {
  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/login`, req.body);
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    res.status(status).json({ error: 'Auth service error', detail: err.message });
  }
});

app.post('/auth/verify', async (req, res) => {
  try {
    const response = await axios.post(`${AUTH_SERVICE_URL}/verify`, req.body);
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    res.status(status).json({ error: 'Auth service error', detail: err.message });
  }
});

app.post('/analytics/process', async (req, res) => {
  try {
    const response = await axios.post(`${ANALYTICS_ENGINE_URL}/process`, req.body);
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    res.status(status).json({ error: 'Analytics engine error', detail: err.message });
  }
});

app.get('/analytics/stats', async (req, res) => {
  try {
    const response = await axios.get(`${ANALYTICS_ENGINE_URL}/stats`);
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    res.status(status).json({ error: 'Analytics engine error', detail: err.message });
  }
});

app.post('/tasks', async (req, res) => {
  const taskId = uuidv4();
  const now = new Date().toISOString();
  const task = {
    id: taskId,
    type: req.body.type || 'default',
    payload: req.body.payload || {},
    created_at: now
  };

  try {
    await pool.query(
      'INSERT INTO tasks (id, type, payload, status, created_at) VALUES ($1, $2, $3, $4, $5)',
      [taskId, task.type, JSON.stringify(task.payload), 'queued', now]
    );
    await redis.lpush(TASK_QUEUE, JSON.stringify(task));
    console.log(`Task ${taskId} queued`);
    res.status(202).json({ message: 'Task accepted', task_id: taskId, status: 'queued' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to queue task', detail: err.message });
  }
});

app.get('/tasks', async (req, res) => {
  const status = req.query.status;
  let result;
  if (status) {
    result = await pool.query('SELECT * FROM tasks WHERE status = $1 ORDER BY created_at DESC', [status]);
  } else {
    result = await pool.query('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 50');
  }
  res.json({ count: result.rows.length, tasks: result.rows });
});

app.patch('/tasks/:id/status', async (req, res) => {
  const { status } = req.body;
  await pool.query('UPDATE tasks SET status = $1, updated_at = $2 WHERE id = $3', [status, new Date().toISOString(), req.params.id]);
  res.json({ task_id: req.params.id, status: status });
});

app.get('/tasks/pending', async (req, res) => {
  try {
    const length = await redis.llen(TASK_QUEUE);
    res.json({ queue: TASK_QUEUE, pending_tasks: length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check queue', detail: err.message });
  }
});

app.get('/gateway/stats', async (req, res) => {
  const taskCounts = await pool.query('SELECT status, COUNT(*) as count FROM tasks GROUP BY status');
  const totalRequests = await pool.query('SELECT COUNT(*) as count FROM request_log');
  res.json({ task_summary: taskCounts.rows, total_requests: parseInt(totalRequests.rows[0].count) });
});

app.get('/system/health', async (req, res) => {
  try {
    const response = await axios.get(`${HEALTH_AGGREGATOR_URL}/aggregate`);
    res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    res.status(status).json({ error: 'Health aggregator error', detail: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`API Gateway running on port ${PORT}`);
});
