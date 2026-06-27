// Tiny in-process pub/sub that fans events out to connected SSE clients.
const clients = new Set();

export function addClient(res) {
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

export function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch { clients.delete(res); }
  }
}

export const clientCount = () => clients.size;
