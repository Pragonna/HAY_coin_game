# HAY Token Game

Chrome Dino–style endless runner with Phantom wallet authentication, candle obstacles, best score tracking, and leaderboard system.

## Features

- Infinite gameplay with candle obstacles (1 point per candle passed)
- Phantom wallet authentication (connect/disconnect, auto-detects wallet changes)
- Best score tracking (saved permanently in database)
- Leaderboard system (Top 10 players sorted by best score)
- Weekly token distribution rewards (every Friday)
- Mobile-responsive UI (adapts to mobile screen sizes)
- Basic anti-bot protections: rate limiting and signed login flow

## Quick start

1. Install Node 18+
2. Install dependencies (none to install beyond built-ins in this repo)
3. Configure environment variables (optional for SMTP)
4. Run:

```bash
npm start
# or
npm run dev
```

Open `http://localhost:3000`.

## Environment variables

Create a `.env` file in the project root:

```
PORT=3000

# Dev only: allows placeholder signature verification
ALLOW_DEV_SIGNATURE_PLACEHOLDER=true

# Email notifications (optional, if not set, fallback to file log data/withdrawals.log)
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_smtp_user
SMTP_PASS=your_smtp_password
MAIL_FROM="HAY Game <no-reply@yourdomain.com>"
WITHDRAW_ALERT_EMAIL=pragonna.example@gmail.com
```

If SMTP variables are not set, withdrawals will be appended to `data/withdrawals.log`.

## Security and anti-bot

- Server is authoritative for scoring and best score tracking
- Login requires wallet ownership via message signing. For production, implement proper signature verification with `@solana/web3.js` and `tweetnacl` on the server, and disable `ALLOW_DEV_SIGNATURE_PLACEHOLDER`.
- Rate limiting is enabled by IP (basic protection).
- Data is stored server-side only under `data/db.json` with atomic writes.
- Wallet address changes are automatically detected and session is updated

## Endpoints (brief)

- `GET /api/nonce` → returns a nonce message to sign
- `POST /api/connect` `{ walletAddress, nonce, signed }` → returns `{ sessionId, user }`
- `POST /api/update-wallet` `{ sessionId, newWalletAddress }` → updates session with new wallet address
- `POST /api/heartbeat` `{ sessionId }` → returns `elapsedMs` and user data
- `POST /api/gameover` `{ sessionId }` → marks round as over
- `POST /api/save-score` `{ sessionId, score }` → saves best score if higher than previous
- `GET /api/leaderboard` → returns Top 10 players sorted by best score
- `POST /api/disconnect` `{ sessionId }` → disconnects wallet and ends session

## Notes

- The game uses candle obstacles (1 point each)
- Best score is saved permanently and displayed in leaderboard
- Phantom wallet connection is required to play
- UI is mobile-responsive and adapts to different screen sizes
- Wallet address changes are automatically detected and handled


