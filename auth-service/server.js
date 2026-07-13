const express = require('express');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'smart-task-secret-key-change-in-prod';
const TOKEN_EXPIRY = process.env.TOKEN_EXPIRY || '1h';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://auth:auth@localhost:5432/authdb'
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'viewer',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS login_history (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      success INTEGER,
      ip_address TEXT,
      timestamp TIMESTAMP DEFAULT NOW()
    );
  `);

  const { rows } = await pool.query('SELECT COUNT(*) as count FROM users');
  if (parseInt(rows[0].count) === 0) {
    await pool.query(
      'INSERT INTO users (username, password, role) VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)',
      ['admin', 'admin123', 'admin', 'developer', 'dev123', 'developer', 'viewer', 'view123', 'viewer']
    );
    console.log('Seeded default users');
  }
}

initDB().then(() => console.log('Auth DB initialized'))
  .catch(err => { console.error('DB init failed:', err.message); process.exit(1); });

app.get('/healthz', (req, res) => {
  res.json({ service: 'auth-service', status: 'healthy', timestamp: new Date().toISOString() });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  const user = rows[0];

  if (!user || user.password !== password) {
    if (user) await pool.query('INSERT INTO login_history (user_id, success, ip_address) VALUES ($1, $2, $3)', [user.id, 0, req.ip]);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  await pool.query('INSERT INTO login_history (user_id, success, ip_address) VALUES ($1, $2, $3)', [user.id, 1, req.ip]);

  const payload = { id: user.id, username: user.username, role: user.role };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });

  console.log(`User '${username}' authenticated successfully`);
  res.json({
    message: 'Authentication successful',
    token: token,
    user: { id: user.id, username: user.username, role: user.role }
  });
});

app.post('/verify', (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    console.log(`Token verified for user '${decoded.username}'`);
    res.json({ valid: true, user: decoded });
  } catch (err) {
    res.status(401).json({ valid: false, error: 'Invalid or expired token' });
  }
});

app.get('/users', async (req, res) => {
  const { rows } = await pool.query('SELECT id, username, role, created_at FROM users');
  res.json({ count: rows.length, users: rows });
});

app.get('/login-history', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT lh.id, u.username, lh.success, lh.ip_address, lh.timestamp
    FROM login_history lh JOIN users u ON lh.user_id = u.id
    ORDER BY lh.timestamp DESC LIMIT 50
  `);
  res.json({ count: rows.length, history: rows });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Auth Service running on port ${PORT}`);
});
