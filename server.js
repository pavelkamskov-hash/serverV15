const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const Ajv = require('ajv');
const config = JSON.parse(fs.readFileSync('./config.json'));
const agent = require('./smartAgent');

const app = express();
const ajv = new Ajv();

app.use(express.json());
app.use(session({ secret: 'secret', resave: false, saveUninitialized: false }));
app.use(express.static('public'));

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'auth required' });
}

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const hash = config.users[username];
  if (!hash) return res.status(401).json({ error: 'bad credentials' });
  const ok = await bcrypt.compare(password, hash);
  if (ok) {
    req.session.user = username;
    res.json({ ok: true });
  } else res.status(401).json({ error: 'bad credentials' });
});

app.get('/status', requireAuth, (req, res) => {
  res.json(agent.getStatus());
});

const dataSchema = {
  type: 'object',
  required: ['lineId', 'pulses', 'duration'],
  properties: {
    lineId: { type: 'string' },
    pulses: { type: 'integer' },
    duration: { type: 'integer' },
    ts: { type: 'integer' }
  }
};
const validate = ajv.compile(dataSchema);

app.post('/data', (req, res) => {
  const body = req.body;
  const arr = Array.isArray(body.batch) ? body.batch : [body];
  for (const pkt of arr) {
    if (!validate(pkt)) {
      res.status(400).json({ error: 'schema' });
      return;
    }
    agent.handlePacket(pkt);
  }
  res.json({ ok: true });
});

const PORT = 3000;
app.listen(PORT, () => console.log('Server running on', PORT));
