# Clue Master Classic server

This is the first online milestone: server-authoritative Classic Quick Match
and Classic room codes. Relay, Evolving Board, and Solo are intentionally not
implemented here yet.

## Run locally

```powershell
npm install
npm run dev
```

The server listens on `http://localhost:3000` by default. Set `PORT` to change
it. MongoDB is not required yet; room and queue state are intentionally in
memory for this milestone. A MongoDB connection string will be needed when we
add persistence for accounts, word packs, and match history.

The Flutter client defaults to the deployed service URL
`https://cluemaster-backend.onrender.com`. For local development, override it
with `flutter run --dart-define=CLUE_MASTER_SERVER=http://localhost:3000` (or
`http://10.0.2.2:3000` on an Android emulator).

## Deploy on Render

This folder includes `render.yaml` for a Render Web Service. If this folder is
the repository root, Render can use the Blueprint directly. Otherwise create a
Node Web Service and set:

- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/health`

No environment variables are required for the first deployment. The server
uses Render's `PORT` automatically and allows all origins by default for this
testing milestone. Later, set `CORS_ORIGIN` to the released app origin.

After deployment, pass the HTTPS service URL to Flutter, for example:
`flutter run --dart-define=CLUE_MASTER_SERVER=https://your-service.onrender.com`.

## Events

Clients register with `player:register`, then use `matchmaking:join` for public
Classic queues or `room:create`/`room:join` for private rooms. Gameplay commands
are `game:clue`, `game:guess`, and `game:pass`. The server validates all moves
and sends a private `room:state` to each socket; hidden roles are sent only to
Spymasters. `GET /health` provides a basic health check.

The server writes JSON logs to stdout. In Render Live Logs, look for
`socket.connected` to confirm the app reached the server,
`player.registered` to confirm the Flutter client completed registration, and
`socket.connection_error` or `request.rejected` when diagnosing failures.
