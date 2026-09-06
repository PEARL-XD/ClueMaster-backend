const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { Server } = require('socket.io');

// Public Quick Match uses standard sizes. Private Classic rooms can use up to
// ten players on either team and may have any role distribution that satisfies
// the start rule (one Spymaster + one Guesser per team).
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_TEAM_SIZES = new Set([2, 4, 6, 8]);
const PRIVATE_MAX_TEAM_SIZE = 10;
const RECONNECT_WINDOW_MS = 60_000;

const WORDS = [
  'APPLE', 'BANK', 'BRIDGE', 'CROWN', 'SHADOW', 'ROCKET', 'OCEAN', 'LIGHT',
  'MATCH', 'CHARGE', 'FIELD', 'STAR', 'CODE', 'AGENT', 'TARGET', 'SIGNAL',
  'CASTLE', 'TRAIN', 'PITCH', 'SPRING', 'BAT', 'JAM', 'BARK', 'MUSEUM',
  'RIVER', 'LASER', 'MISSION', 'KEY', 'MASK', 'WAVE', 'CURRENT', 'SCALE',
  'FOREST', 'MARKET', 'DIAMOND', 'PLANET', 'HACKER', 'EAGLE', 'DESERT',
  'KING', 'VIOLIN', 'SATELLITE', 'DRAGON', 'MIRROR', 'BOTTLE', 'SECRET',
  'DOSSIER', 'CAMERA', 'WITNESS', 'CIPHER', 'ESCAPE', 'WIRE', 'ROBOT',
];

const rooms = new Map();
const publicQueues = new Map();
const players = new Map();

function logEvent(event, details = {}) {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      event,
      ...details,
    }),
  );
}

function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function makeBoard(redStarts = true) {
  const selectedWords = shuffle(WORDS).slice(0, 25);
  const roles = shuffle([
    ...Array(redStarts ? 9 : 8).fill('red'),
    ...Array(redStarts ? 8 : 9).fill('blue'),
    'assassin',
    ...Array(7).fill('neutral'),
  ]);
  return { words: selectedWords, roles };
}

function newRoom(host, teamSize, code) {
  const room = {
    id: randomUUID(),
    code,
    mode: 'classic',
    teamSize,
    status: 'lobby',
    hostId: host.id,
    players: new Map(),
    words: [],
    roles: [],
    revealed: new Set(),
    currentTeam: 'red',
    clue: null,
  };
  rooms.set(room.id, room);
  addPlayerToRoom(room, host);
  return room;
}

function addPlayerToRoom(room, player) {
  player.roomId = room.id;
  room.players.set(player.id, player);
}

function assignPublicMatch(queuePlayers, teamSize) {
  const room = newRoom(queuePlayers[0], teamSize);
  queuePlayers.forEach((player, index) => {
    player.team = index < teamSize ? 'red' : 'blue';
    player.role = index === 0 || index === teamSize ? 'spymaster' : 'guesser';
    addPlayerToRoom(room, player);
  });
  room.status = 'playing';
  const board = makeBoard(true);
  room.words = board.words;
  room.roles = board.roles;
  return room;
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    team: player.team || null,
    role: player.role || null,
    connected: player.connected,
  };
}

// Never broadcast the hidden key to the entire room. Each socket receives a
// tailored state; every Spymaster can see the key, Guessers only see words and
// cards that have already been revealed.
function stateFor(room, viewer) {
  return {
    roomId: room.id,
    code: room.code || null,
    hostId: room.hostId,
    mode: room.mode,
    teamSize: room.teamSize,
    status: room.status,
    currentTeam: room.currentTeam,
    clue: room.clue
      ? { text: room.clue.text, count: room.clue.count, remaining: room.clue.remaining }
      : null,
    words: room.words,
    revealed: [...room.revealed],
    revealedRoles: [...room.revealed].map((index) => ({ index, role: room.roles[index] })),
    players: [...room.players.values()].map(publicPlayer),
    roles: viewer.role === 'spymaster' ? room.roles : undefined,
  };
}

function emitRoom(io, room, event = 'room:state', payloadFactory = (viewer) => stateFor(room, viewer)) {
  for (const viewer of room.players.values()) {
    if (!viewer.socketId) continue;
    const payload = payloadFactory(viewer);
    io.to(viewer.socketId).emit(event, payload);
  }
}

function error(socket, message, ack) {
  ack?.({ error: message });
  logEvent('request.rejected', {
    socketId: socket.id,
    playerId: socket.data.playerId || null,
    message,
  });
  socket.emit('room:error', { message });
}

function teamHasRole(room, team, role) {
  return [...room.players.values()].some((player) => player.team === team && player.role === role);
}

function validAssignments(room) {
  const eachTeamHasPlayer = ['red', 'blue'].every((team) =>
    [...room.players.values()].some((player) => player.team === team),
  );

  // Allow a two-device private test room to start with one player per team.
  // The normal custom-room rule remains active once more players join.
  if (room.code && room.players.size === 2) return eachTeamHasPlayer;

  return ['red', 'blue'].every(
    (team) =>
      teamHasRole(room, team, 'spymaster') &&
      teamHasRole(room, team, 'guesser'),
  );
}

function endTurn(room) {
  room.currentTeam = room.currentTeam === 'red' ? 'blue' : 'red';
  room.clue = null;
}

function finish(room, winner, assassin = false) {
  room.status = 'finished';
  room.winner = winner;
  room.assassin = assassin;
}

function checkWinner(room) {
  for (const team of ['red', 'blue']) {
    const remaining = room.roles.some((role, index) => role === team && !room.revealed.has(index));
    if (!remaining) return team;
  }
  return null;
}

function removeFromQueue(player) {
  for (const queue of publicQueues.values()) {
    const index = queue.findIndex((candidate) => candidate.id === player.id);
    if (index >= 0) queue.splice(index, 1);
  }
}

const httpServer = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, service: 'clue-master', rooms: rooms.size }));
    return;
  }
  response.writeHead(404);
  response.end('Not found');
});

const io = new Server(httpServer, {
  cors: { origin: process.env.CORS_ORIGIN || '*' },
});

io.engine.on('connection_error', (error) => {
  logEvent('socket.connection_error', {
    message: error.message,
    code: error.code,
  });
});

io.on('connection', (socket) => {
  logEvent('socket.connected', { socketId: socket.id });

  socket.on('player:register', ({ name, playerId } = {}, ack) => {
    let player = playerId ? players.get(playerId) : null;
    const reconnecting = Boolean(player);
    if (player) {
      player.socketId = socket.id;
      player.name = name?.trim() || player.name;
      player.connected = true;
      if (player.roomId) {
        const room = rooms.get(player.roomId);
        if (room) {
          socket.join(room.id);
          emitRoom(io, room);
        }
      }
    } else {
      player = { id: randomUUID(), socketId: socket.id, name: name?.trim() || 'Detective', connected: true };
      players.set(player.id, player);
    }
    socket.data.playerId = player.id;
    ack?.({ playerId: player.id });
    logEvent('player.registered', {
      socketId: socket.id,
      playerId: player.id,
      reconnecting,
      roomId: player.roomId || null,
    });
  });

  socket.on('matchmaking:join', ({ teamSize } = {}, ack) => {
    const player = players.get(socket.data.playerId);
    if (!player || !PUBLIC_TEAM_SIZES.has(teamSize)) return error(socket, 'Choose 2v2, 4v4, 6v6, or 8v8.', ack);
    removeFromQueue(player);
    const queue = publicQueues.get(teamSize) || [];
    queue.push(player);
    publicQueues.set(teamSize, queue);
    ack?.({ queued: true, teamSize, position: queue.length });
    logEvent('matchmaking.joined', {
      playerId: player.id,
      teamSize,
      position: queue.length,
    });
    socket.emit('matchmaking:queued', { teamSize, position: queue.length });
    if (queue.length >= teamSize * 2) {
      const matchPlayers = queue.splice(0, teamSize * 2);
      const room = assignPublicMatch(matchPlayers, teamSize);
      logEvent('matchmaking.started', {
        roomId: room.id,
        teamSize,
        playerCount: matchPlayers.length,
      });
      for (const member of matchPlayers) io.sockets.sockets.get(member.socketId)?.join(room.id);
      emitRoom(io, room);
      emitRoom(io, room, 'match:started', (viewer) => ({ roomId: room.id, state: stateFor(room, viewer) }));
    }
  });

  socket.on('matchmaking:cancel', (ack) => {
    const player = players.get(socket.data.playerId);
    if (player) removeFromQueue(player);
    ack?.({ cancelled: true });
  });

  socket.on('room:create', ({ teamSize } = {}, ack) => {
    const player = players.get(socket.data.playerId);
    if (!player || !Number.isInteger(teamSize) || teamSize < 1 || teamSize > PRIVATE_MAX_TEAM_SIZE) return error(socket, 'Private rooms support up to 10 players per team.', ack);
    const code = Math.random().toString(36).slice(2, 7).toUpperCase();
    const room = newRoom(player, teamSize, code);
    socket.join(room.id);
    const roomDetails = { roomId: room.id, code: room.code };
    ack?.(roomDetails);
    socket.emit('room:created', roomDetails);
    logEvent('room.created', {
      roomId: room.id,
      teamSize,
      playerId: player.id,
    });
    emitRoom(io, room);
  });

  socket.on('room:join', ({ code } = {}, ack) => {
    const player = players.get(socket.data.playerId);
    const room = [...rooms.values()].find((candidate) => candidate.code === code?.trim().toUpperCase() && candidate.status === 'lobby');
    if (!player || !room) return error(socket, 'Room code is invalid or the match has started.', ack);
    if (room.players.size >= room.teamSize * 2) return error(socket, 'This room is full.', ack);
    addPlayerToRoom(room, player);
    socket.join(room.id);
    const roomDetails = { roomId: room.id, code: room.code };
    ack?.(roomDetails);
    socket.emit('room:joined', roomDetails);
    logEvent('room.joined', {
      roomId: room.id,
      playerId: player.id,
      playerCount: room.players.size,
    });
    emitRoom(io, room);
  });

  socket.on('room:assign', ({ roomId, team, role } = {}, ack) => {
    const player = players.get(socket.data.playerId);
    const room = rooms.get(roomId);
    if (!player || !room || room.players.get(player.id) !== player) return error(socket, 'You are not in this room.', ack);
    if (room.status === 'playing' && room.clue) return error(socket, 'Wait until the current turn ends before changing roles.', ack);
    if (!['red', 'blue'].includes(team) || !['spymaster', 'guesser'].includes(role)) return error(socket, 'Invalid team or role.', ack);
    player.team = team;
    player.role = role;
    ack?.({ assigned: true });
    logEvent('room.assignment', {
      roomId: room.id,
      playerId: player.id,
      team,
      role,
    });
    emitRoom(io, room);
  });

  socket.on('room:start', ({ roomId } = {}, ack) => {
    const player = players.get(socket.data.playerId);
    const room = rooms.get(roomId);
    if (!room || room.hostId !== player?.id) return error(socket, 'Only the room host can start the match.', ack);
    if (!validAssignments(room)) {
      return error(
        socket,
        room.code && room.players.size === 2
          ? 'Assign the two players to opposite teams to start the test room.'
          : 'Each team needs at least one Spymaster and one Guesser.',
        ack,
      );
    }
    room.status = 'playing';
    const board = makeBoard(true);
    room.words = board.words;
    room.roles = board.roles;
    ack?.({ started: true });
    logEvent('room.started', {
      roomId: room.id,
      playerCount: room.players.size,
    });
    emitRoom(io, room);
    emitRoom(io, room, 'match:started', (viewer) => ({ roomId: room.id, state: stateFor(room, viewer) }));
  });

  socket.on('game:clue', ({ roomId, text, count } = {}, ack) => {
    const player = players.get(socket.data.playerId);
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing' || player?.team !== room.currentTeam || player.role !== 'spymaster') return error(socket, 'Only the active team Spymaster can give a clue.', ack);
    if (room.clue || typeof text !== 'string' || !text.trim() || !Number.isInteger(count) || count < 1 || count > 9) return error(socket, 'Enter a clue and a number from 1 to 9.', ack);
    room.clue = { text: text.trim(), count, remaining: count };
    ack?.({ accepted: true });
    logEvent('game.clue_accepted', {
      roomId: room.id,
      playerId: player.id,
      count,
    });
    emitRoom(io, room);
  });

  socket.on('game:guess', ({ roomId, index } = {}, ack) => {
    const player = players.get(socket.data.playerId);
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing' || player?.team !== room.currentTeam || player.role !== 'guesser' || !room.clue || !Number.isInteger(index) || index < 0 || index >= room.words.length || room.revealed.has(index)) return error(socket, 'That guess is not allowed right now.', ack);
    room.revealed.add(index);
    const selected = room.roles[index];
    if (selected === 'assassin') finish(room, room.currentTeam === 'red' ? 'blue' : 'red', true);
    else if (selected !== room.currentTeam) endTurn(room);
    else {
      room.clue.remaining -= 1;
      const winner = checkWinner(room);
      if (winner) finish(room, winner);
      else if (room.clue.remaining <= 0) endTurn(room);
    }
    ack?.({ accepted: true, result: selected });
    logEvent('game.guess_accepted', {
      roomId: room.id,
      playerId: player.id,
      index,
      status: room.status,
    });
    emitRoom(io, room);
    if (room.status === 'finished') io.to(room.id).emit('match:finished', { winner: room.winner, assassin: room.assassin });
  });

  socket.on('game:pass', ({ roomId } = {}, ack) => {
    const player = players.get(socket.data.playerId);
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing' || player?.team !== room.currentTeam || !room.clue) return error(socket, 'You cannot pass this turn right now.', ack);
    endTurn(room);
    ack?.({ accepted: true });
    logEvent('game.turn_passed', { roomId: room.id, playerId: player.id });
    emitRoom(io, room);
  });

  socket.on('match:returnToLobby', ({ roomId } = {}, ack) => {
    const player = players.get(socket.data.playerId);
    const room = rooms.get(roomId);
    if (!room || room.status !== 'finished' || room.hostId !== player?.id) return error(socket, 'Only the host can return the room to the lobby.', ack);
    room.status = 'lobby'; room.words = []; room.roles = []; room.revealed.clear(); room.clue = null; room.winner = null; room.assassin = false;
    for (const member of room.players.values()) { member.team = undefined; member.role = undefined; }
    ack?.({ returned: true });
    emitRoom(io, room);
  });

  socket.on('disconnect', () => {
    const player = players.get(socket.data.playerId);
    logEvent('socket.disconnected', {
      socketId: socket.id,
      playerId: player?.id || null,
    });
    if (!player) return;
    player.connected = false;
    removeFromQueue(player);
    const room = player.roomId ? rooms.get(player.roomId) : null;
    if (room) emitRoom(io, room);
    setTimeout(() => {
      if (!player.connected && player.roomId) {
        const currentRoom = rooms.get(player.roomId);
        currentRoom?.players.delete(player.id);
        players.delete(player.id);
        if (currentRoom) emitRoom(io, currentRoom);
      }
    }, RECONNECT_WINDOW_MS);
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Clue Master server listening on port ${PORT}`);
});
