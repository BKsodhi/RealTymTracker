// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { exec } = require('child_process');
const util = require('util');
const path = require('path');
const fs = require('fs').promises;
const bodyParser = require('body-parser');

const execAsync = util.promisify(exec);

// --- CONFIG ---
const PORT = process.env.PORT || 3000;
const REPO_DIR = path.resolve(__dirname); // assume git repo initialized here
const LOGS_DIR = path.join(REPO_DIR, 'issue_logs'); // where we write JSON logs to commit
// ----------------

async function initDb() {
  const db = await open({
    filename: path.join(__dirname, 'issues.sqlite'),
    driver: sqlite3.Database
  });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      assignee TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      author TEXT,
      text TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(issue_id) REFERENCES issues(id)
    );
  `);
  return db;
}

// Commit queue to serialize git operations
class CommitQueue {
  constructor() {
    this.queue = [];
    this.running = false;
  }
  push(task) {
    this.queue.push(task);
    this._run();
  }
  async _run() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const task = this.queue.shift();
      try {
        await task();
      } catch (err) {
        console.error('Commit task error:', err);
      }
    }
    this.running = false;
  }
}

async function ensureLogsDir() {
  try {
    await fs.mkdir(LOGS_DIR, { recursive: true });
  } catch (e) {
    // ignore
  }
}

// utility to write log file and git commit it
function makeCommitTask(filename, content, message) {
  return async () => {
    const filePath = path.join(LOGS_DIR, filename);
    await fs.writeFile(filePath, JSON.stringify(content, null, 2), 'utf8');
    // git add & commit
    try {
      await execAsync(`git add "${path.relative(REPO_DIR, filePath)}"`, { cwd: REPO_DIR });
      // Using --no-verify to avoid hooks blocking; remove if you want hooks.
      await execAsync(`git commit -m "${message.replace(/"/g, '\\"')}" --no-verify`, { cwd: REPO_DIR });
      console.log('Committed', filePath);
    } catch (err) {
      // If nothing to commit or git error, log it
      console.error('Git error:', err.stderr || err.message);
    }
  };
}

(async () => {
  await ensureLogsDir();
  const db = await initDb();
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  app.use(bodyParser.json());
  app.use(express.static(path.join(__dirname, 'public'))); // serve client files

  const commitQueue = new CommitQueue();

  // REST APIs (CRUD)
  app.get('/api/issues', async (req, res) => {
    const issues = await db.all('SELECT * FROM issues ORDER BY updated_at DESC');
    // attach comments
    for (const issue of issues) {
      issue.comments = await db.all('SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at', [issue.id]);
    }
    res.json(issues);
  });

  app.post('/api/issues', async (req, res) => {
    const { title, description, assignee } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const result = await db.run(
      `INSERT INTO issues (title, description, assignee) VALUES (?, ?, ?)`,
      [title, description || '', assignee || null]
    );
    const issueId = result.lastID;
    const issue = await db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
    issue.comments = [];
    // Broadcast via sockets
    io.emit('issue:created', issue);

    // Create git log entry
    const ts = new Date().toISOString().replace(/[:.]/g,'-');
    const filename = `create-issue-${issueId}-${ts}.json`;
    const message = `Create issue #${issueId}: ${issue.title}`;
    commitQueue.push(makeCommitTask(filename, { action: 'create', issue }, message));

    res.status(201).json(issue);
  });

  app.put('/api/issues/:id', async (req, res) => {
    const id = Number(req.params.id);
    const { title, description, status, assignee } = req.body;
    const existing = await db.get('SELECT * FROM issues WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Issue not found' });

    await db.run(
      `UPDATE issues SET title = COALESCE(?, title), description = COALESCE(?, description), status = COALESCE(?, status), assignee = COALESCE(?, assignee), updated_at = datetime('now') WHERE id = ?`,
      [title, description, status, assignee, id]
    );
    const updated = await db.get('SELECT * FROM issues WHERE id = ?', [id]);
    updated.comments = await db.all('SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at', [id]);

    io.emit('issue:updated', updated);

    const ts = new Date().toISOString().replace(/[:.]/g,'-');
    const filename = `update-issue-${id}-${ts}.json`;
    const message = `Update issue #${id}: set ${status || 'no-status-change'}`;
    commitQueue.push(makeCommitTask(filename, { action: 'update', before: existing, after: updated }, message));

    res.json(updated);
  });

  app.post('/api/issues/:id/comments', async (req, res) => {
    const id = Number(req.params.id);
    const { author, text } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    const issue = await db.get('SELECT * FROM issues WHERE id = ?', [id]);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });

    const result = await db.run(
      `INSERT INTO comments (issue_id, author, text) VALUES (?, ?, ?)`,
      [id, author || 'anonymous', text]
    );
    const commentId = result.lastID;
    const comment = await db.get('SELECT * FROM comments WHERE id = ?', [commentId]);
    // update issue updated_at
    await db.run(`UPDATE issues SET updated_at = datetime('now') WHERE id = ?`, [id]);
    const updatedIssue = await db.get('SELECT * FROM issues WHERE id = ?', [id]);
    updatedIssue.comments = await db.all('SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at', [id]);

    io.emit('issue:comment', { issue: updatedIssue, comment });

    const ts = new Date().toISOString().replace(/[:.]/g,'-');
    const filename = `comment-issue-${id}-${commentId}-${ts}.json`;
    const message = `Comment on issue #${id} by ${comment.author || 'anon'}`;
    commitQueue.push(makeCommitTask(filename, { action: 'comment', issue: updatedIssue, comment }, message));

    res.status(201).json(comment);
  });

  // Socket.IO connections
  io.on('connection', (socket) => {
    console.log('socket connected', socket.id);
    socket.on('disconnect', () => console.log('disconnected', socket.id));
    // Optionally support client-initiated events (optimistic), but we use REST in this example.
  });

  server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
})();
