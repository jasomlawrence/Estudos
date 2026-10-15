'use strict';
const crypto = require('node:crypto');
const { q, now } = require('./db');

const SESSION_DAYS = 30;
const COOKIE = 'kb_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return expected.length === hash.length && crypto.timingSafeEqual(hash, expected);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  q.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, userId, expires);
  return token;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(req, res, token) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function publicUser(u) {
  return u && { id: u.id, name: u.name, email: u.email, role: u.role, active: !!u.active, avatar_color: u.avatar_color };
}

// Middleware: carrega o usuário da sessão (se houver)
function loadUser(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    const row = q.get(`SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
                       WHERE s.token = ? AND u.active = 1`, token);
    if (row && row.expires_at > now()) {
      req.user = row;
      req.sessionToken = token;
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Faça login para continuar.' });
  // Visualizadores só podem ler
  if (req.user.role === 'viewer' && req.method !== 'GET' && !req.path.startsWith('/notifications') && !req.path.startsWith('/auth')) {
    return res.status(403).json({ error: 'Seu perfil é somente leitura.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Apenas administradores podem fazer isso.' });
  next();
}

module.exports = {
  hashPassword, verifyPassword, createSession, setSessionCookie, clearSessionCookie,
  loadUser, requireAuth, requireAdmin, publicUser,
};
