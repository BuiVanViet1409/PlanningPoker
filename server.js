const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// In-memory game store
const games = new Map();

const VOTING_SYSTEMS = {
  fibonacci: { name: 'Fibonacci', cards: ['0', '1', '2', '3', '5', '8', '13', '21', '34', '55', '89', '?', '\u2615'] },
  estimation: { name: 'Estimation (Story Points)', cards: ['0', '1', '2', '3', '5', '8', '13', '20', '40', '100', '?', '\u2615'] },
  tshirt: { name: 'T-Shirt', cards: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '?', '\u2615'] },
  powers: { name: 'Powers of 2', cards: ['0', '1', '2', '4', '8', '16', '32', '64', '?', '\u2615'] },
  hours: { name: 'Hours', cards: ['0', '1', '2', '4', '8', '16', '24', '40', '?', '\u2615'] },
};

// REST: create game
app.post('/api/games', (req, res) => {
  const { name, votingSystem } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Game name is required' });
  }
  const id = uuidv4().slice(0, 8);
  const game = {
    id,
    name: name.trim(),
    votingSystem: votingSystem || 'fibonacci',
    players: new Map(),
    hostId: null,
    revealed: false,
    createdAt: Date.now(),
  };
  games.set(id, game);
  res.json({ id, name: game.name });
});

// REST: get game info
app.get('/api/games/:id', (req, res) => {
  const game = games.get(req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  res.json({
    id: game.id,
    name: game.name,
    votingSystem: game.votingSystem,
    cards: VOTING_SYSTEMS[game.votingSystem]?.cards || VOTING_SYSTEMS.fibonacci.cards,
  });
});

// Serve game room for any /game/:id route
app.get('/game/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

// Socket.IO
io.on('connection', (socket) => {
  let currentGameId = null;
  let currentPlayerId = null;

  // Send game info WITHOUT joining (for fast page load)
  socket.on('get-game-info', ({ gameId }) => {
    const game = games.get(gameId);
    if (!game) {
      socket.emit('error-msg', 'Game not found');
      return;
    }
    socket.emit('game-info', {
      id: game.id,
      name: game.name,
      cards: VOTING_SYSTEMS[game.votingSystem]?.cards || VOTING_SYSTEMS.fibonacci.cards,
    });
  });

  socket.on('join-game', ({ gameId, playerName, isSpectator }) => {
    const game = games.get(gameId);
    if (!game) {
      socket.emit('error-msg', 'Game not found');
      return;
    }

    currentGameId = gameId;
    currentPlayerId = socket.id;

    // First NON-spectator becomes host. If only spectators, first person is host.
    if (!game.hostId) {
      game.hostId = socket.id;
    } else if (game.players.get(game.hostId)?.isSpectator && !isSpectator) {
      // Promote this non-spectator to host if current host is spectator
      game.hostId = socket.id;
    }

    game.players.set(socket.id, {
      id: socket.id,
      name: playerName,
      vote: null,
      isSpectator: !!isSpectator,
    });

    socket.join(gameId);
    broadcastGameState(gameId);
  });

  socket.on('vote', ({ vote }) => {
    if (!currentGameId) return;
    const game = games.get(currentGameId);
    if (!game || game.revealed) return;

    const player = game.players.get(socket.id);
    if (player && !player.isSpectator) {
      player.vote = vote;
      broadcastGameState(currentGameId);
    }
  });

  socket.on('reveal', () => {
    if (!currentGameId) return;
    const game = games.get(currentGameId);
    if (!game || socket.id !== game.hostId) return;
    game.revealed = true;
    broadcastGameState(currentGameId);
  });

  socket.on('reset', () => {
    if (!currentGameId) return;
    const game = games.get(currentGameId);
    if (!game || socket.id !== game.hostId) return;
    game.revealed = false;
    for (const player of game.players.values()) {
      player.vote = null;
    }
    broadcastGameState(currentGameId);
  });

  socket.on('disconnect', () => {
    if (!currentGameId) return;
    const game = games.get(currentGameId);
    if (!game) return;
    game.players.delete(socket.id);
    if (game.players.size === 0) {
      games.delete(currentGameId);
    } else {
      // Reassign host if host left
      if (game.hostId === socket.id) {
        game.hostId = game.players.keys().next().value;
      }
      broadcastGameState(currentGameId);
    }
  });
});

function broadcastGameState(gameId) {
  const game = games.get(gameId);
  if (!game) return;

  const players = [];
  for (const p of game.players.values()) {
    players.push({
      id: p.id,
      name: p.name,
      hasVoted: p.vote !== null,
      vote: game.revealed ? p.vote : null,
      isHost: p.id === game.hostId,
      isSpectator: !!p.isSpectator,
    });
  }

  const numericVotes = players
    .filter(p => p.hasVoted && p.vote !== '?' && p.vote !== '\u2615')
    .map(p => parseFloat(p.vote))
    .filter(v => !isNaN(v));

  const stats = game.revealed && numericVotes.length > 0
    ? {
        average: (numericVotes.reduce((a, b) => a + b, 0) / numericVotes.length).toFixed(1),
        min: Math.min(...numericVotes),
        max: Math.max(...numericVotes),
        consensus: numericVotes.every(v => v === numericVotes[0]),
      }
    : null;

  // Send isHost per socket so each client knows if they are host
  for (const [socketId] of game.players) {
    io.to(socketId).emit('game-state', {
      gameName: game.name,
      players,
      revealed: game.revealed,
      stats,
      isHost: socketId === game.hostId,
    });
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Planning Poker running at http://localhost:${PORT}`);
  // Show LAN IP so other users can connect
  const nets = require('os').networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  LAN: http://${net.address}:${PORT}`);
      }
    }
  }
});
