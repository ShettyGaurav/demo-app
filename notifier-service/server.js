const express = require('express');
const Redis = require('ioredis');
const { Pool } = require('pg');

const app = express();

const PORT = process.env.PORT || 3002;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const TASK_EVENTS_CHANNEL = process.env.TASK_EVENTS_CHANNEL || 'task_events';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://notifier:notifier@localhost:5432/notifierdb'
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      task_id TEXT NOT NULL,
      task_type TEXT,
      status TEXT,
      processing_time_s REAL,
      received_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

initDB().then(() => console.log('Notifier DB initialized'))
  .catch(err => { console.error('DB init failed:', err.message); process.exit(1); });

const subscriber = new Redis(REDIS_URL, {
  retryStrategy: (times) => Math.min(times * 200, 5000),
  maxRetriesPerRequest: null
});

subscriber.on('connect', () => {
  console.log('Notifier connected to Redis');
  subscriber.subscribe(TASK_EVENTS_CHANNEL, (err) => {
    if (err) {
      console.error(`Failed to subscribe to ${TASK_EVENTS_CHANNEL}:`, err.message);
    } else {
      console.log(`Subscribed to channel: ${TASK_EVENTS_CHANNEL}`);
    }
  });
});

subscriber.on('error', (err) => console.error('Redis error:', err.message));

subscriber.on('message', async (channel, message) => {
  try {
    const event = JSON.parse(message);

    await pool.query(
      'INSERT INTO notifications (task_id, task_type, status, processing_time_s) VALUES ($1, $2, $3, $4)',
      [event.task_id, event.type, event.status, event.processing_time_s]
    );

    console.log(`[NOTIFICATION] Task ${event.task_id} completed (type=${event.type}, took ${event.processing_time_s}s)`);
  } catch (err) {
    console.error('Failed to process event:', err.message);
  }
});

app.get('/healthz', (req, res) => {
  res.json({ service: 'notifier-service', status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/notifications', async (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const result = await pool.query('SELECT * FROM notifications ORDER BY id DESC LIMIT $1', [limit]);
  const total = await pool.query('SELECT COUNT(*) as count FROM notifications');
  res.json({
    total: parseInt(total.rows[0].count),
    showing: result.rows.length,
    notifications: result.rows
  });
});

app.get('/notifications/stats', async (req, res) => {
  const total = await pool.query('SELECT COUNT(*) as count FROM notifications');
  const byType = await pool.query('SELECT task_type, COUNT(*) as count FROM notifications GROUP BY task_type');
  const avgTime = await pool.query('SELECT COALESCE(AVG(processing_time_s), 0) as avg FROM notifications');
  res.json({
    total_notifications: parseInt(total.rows[0].count),
    by_type: byType.rows,
    average_processing_time_s: Math.round(parseFloat(avgTime.rows[0].avg) * 1000) / 1000
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Notifier Service running on port ${PORT}`);
  console.log(`Listening for events on channel: ${TASK_EVENTS_CHANNEL}`);
});
