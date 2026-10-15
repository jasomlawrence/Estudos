'use strict';
// Barramento interno de eventos + Server-Sent Events para atualização em tempo real
const { EventEmitter } = require('node:events');

const bus = new EventEmitter();
bus.setMaxListeners(50);

const clients = new Set(); // { res, userId }

function addClient(res, userId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const client = { res, userId };
  clients.add(client);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  res.on('close', () => { clearInterval(ping); clients.delete(client); });
}

function send(client, type, data) {
  client.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(type, data) {
  for (const c of clients) send(c, type, data);
}

function sendToUser(userId, type, data) {
  for (const c of clients) if (c.userId === userId) send(c, type, data);
}

// Agrupa várias alterações seguidas do mesmo quadro em um único aviso
const pending = new Map();
function boardChanged(boardId, userId, cardId) {
  const key = boardId;
  const entry = pending.get(key) || { userId, cardIds: new Set() };
  if (cardId) entry.cardIds.add(cardId);
  entry.userId = userId;
  if (!entry.timer) {
    entry.timer = setTimeout(() => {
      pending.delete(key);
      broadcast('board', { boardId, userId: entry.userId, cardIds: [...entry.cardIds] });
    }, 150);
  }
  pending.set(key, entry);
}

module.exports = { bus, addClient, broadcast, sendToUser, boardChanged };
