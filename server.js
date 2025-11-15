import fs from 'fs';
import path from 'path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import http from 'http';
import https from 'https';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

// Security headers
app.use(helmet({
	contentSecurityPolicy: {
		useDefaults: true,
		directives: {
			"default-src": ["'self'"],
			"script-src": ["'self'", "'unsafe-inline'"],
			"style-src": ["'self'", "'unsafe-inline'"],
			"img-src": ["'self'"],
			"connect-src": ["'self'"],
			"frame-ancestors": ["'none'"]
		}
	}
}));
app.use(cors({ origin: true, credentials: true }));
app.set('trust proxy', 1);
if (process.env.FORCE_HTTPS === 'true') {
	app.use((req, res, next) => {
		if (req.secure) return next();
		const host = req.headers.host;
		return res.redirect(`https://${host}${req.originalUrl}`);
	});
}
app.use(express.json());
app.use(cookieParser());
app.use(morgan('tiny'));

// Data storage
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, sessions: {} }, null, 2));

function loadDb() {
	const content = fs.readFileSync(DB_FILE, 'utf-8');
	return JSON.parse(content);
}
function saveDb(db) {
	const tmpFile = DB_FILE + '.tmp';
	fs.writeFileSync(tmpFile, JSON.stringify(db, null, 2));
	fs.renameSync(tmpFile, DB_FILE);
}

function endSession(db, sessionId, { removeSession = false } = {}) {
	const session = db.sessions[sessionId];
	if (!session || session.type !== 'game') return;
	if (session.isAlive) {
		session.isAlive = false;
	}
	const user = db.users[session.walletAddress];
	if (user && typeof session.points === 'number') {
		// calculate only 15-like increments
		const earned = Math.floor(session.points / 15) * 15;
		if (earned > 0) {
			user.savedPointsTotal = (user.savedPointsTotal || 0) + earned;
			console.log(`✅ ${user.walletAddress} qazandı: ${earned} xal | Cəmi: ${user.savedPointsTotal}`);
		}
	}
	// reset session
	session.points = 0;
	session.pointsAwarded = 0;

	if (removeSession) delete db.sessions[sessionId];
}

// Rate limiting (basic anti-bot)
const limiter = new RateLimiterMemory({
	points: 100,
	duration: 60
});
app.use(async (req, res, next) => {
	try {
		await limiter.consume(req.ip);
		next();
	} catch {
		res.status(429).json({ error: 'Too many requests' });
	}
});

// Helper: create email transporter (requires env)
function createTransporter() {
	if (!process.env.SMTP_HOST) return null;
	return nodemailer.createTransport({
		host: process.env.SMTP_HOST,
		port: Number(process.env.SMTP_PORT || 587),
		secure: process.env.SMTP_SECURE === 'true',
		auth: process.env.SMTP_USER && process.env.SMTP_PASS ? {
			user: process.env.SMTP_USER,
			pass: process.env.SMTP_PASS
		} : undefined
	});
}

// Nonce generation for wallet signature
const NONCE_TTL_MS = 5 * 60 * 1000;
app.get('/api/nonce', (req, res) => {
	const db = loadDb();
	const nonceId = uuidv4();
	const expiresAt = Date.now() + NONCE_TTL_MS;
	db.sessions[nonceId] = { type: 'nonce', expiresAt };
	saveDb(db);
	res.json({ nonce: nonceId, message: `Sign to login: ${nonceId}` });
});

// Minimal Solana signature verification placeholder
// In production, verify signature server-side using @solana/web3.js and tweetnacl.
function verifySignaturePlaceholder() {
	// Without network/deps, we accept signed=true as placeholder in dev.
	return process.env.ALLOW_DEV_SIGNATURE_PLACEHOLDER === 'true';
}

// Connect Phantom wallet (verifies ownership via signed message)
app.post('/api/connect', (req, res) => {
	console.log('Connect endpoint hit:', req.method, req.path);
	try {
		const { walletAddress, nonce, signed } = req.body || {};
		console.log('Connect request body:', { walletAddress: walletAddress?.slice(0, 8) + '...', nonce: nonce?.slice(0, 8) + '...', signed });
		
		if (!walletAddress || !nonce) {
			console.error('Connect: Missing parameters', { walletAddress: !!walletAddress, nonce: !!nonce });
			return res.status(400).json({ error: 'Missing walletAddress or nonce' });
		}
		
		const db = loadDb();
		const nonceRec = db.sessions[nonce];
		
		if (!nonceRec) {
			console.error('Connect: Nonce not found', { nonce });
			return res.status(400).json({ error: 'Invalid or expired nonce' });
		}
		
		if (nonceRec.type !== 'nonce') {
			console.error('Connect: Invalid nonce type', { nonce, type: nonceRec.type });
			return res.status(400).json({ error: 'Invalid or expired nonce' });
		}
		
		if (nonceRec.expiresAt < Date.now()) {
			console.error('Connect: Nonce expired', { nonce, expiresAt: nonceRec.expiresAt, now: Date.now() });
			return res.status(400).json({ error: 'Invalid or expired nonce' });
		}
		
		// Verify signature (placeholder unless configured)
		if (!verifySignaturePlaceholder() && !signed) {
			return res.status(400).json({ error: 'Signature verification failed' });
		}
		
		// Create user if not exists
		if (!db.users[walletAddress]) {
			db.users[walletAddress] = {
				userId: walletAddress,
				walletAddress,
				bestScore: 0,
				currentScore: 0,
				hayBalance: 0,
				totalMinutes: 0,
				totalAchievements: 0,
				savedPointsTotal: 0,
				hayFromPointsAwarded: 0,
				lastWithdrawalAt: null
			};
		} else {
			// Ensure bestScore exists for existing users
			if (typeof db.users[walletAddress].bestScore !== 'number') {
				db.users[walletAddress].bestScore = 0;
			}
		}
		
		// Create gameplay session
		const sessionId = uuidv4();
		db.sessions[sessionId] = {
			type: 'game',
			walletAddress,
			startedAt: Date.now(),
			lastHeartbeat: Date.now(),
			elapsedMsServer: 0,
			isAlive: true,
			points: 0,
			pointsAwarded: 0
		};
		
		// Clean nonce
		delete db.sessions[nonce];
		saveDb(db);
		
		res.json({ sessionId, user: db.users[walletAddress] });
	} catch (error) {
		console.error('Connect wallet error:', error);
		res.status(500).json({ error: 'Internal server error. Please try again.' });
	}
});

// Update wallet address (handle wallet change)
app.post('/api/update-wallet', (req, res) => {
	try {
		const { sessionId, newWalletAddress } = req.body || {};
		if (!sessionId || !newWalletAddress) {
			return res.status(400).json({ error: 'Missing sessionId or newWalletAddress' });
		}
		
		const db = loadDb();
		const session = db.sessions[sessionId];
		
		if (!session || session.type !== 'game') {
			return res.status(404).json({ error: 'Invalid session' });
		}
		
		const oldWalletAddress = session.walletAddress;
		
		// Validate new wallet address
		if (typeof newWalletAddress !== 'string' || newWalletAddress.length < 32) {
			return res.status(400).json({ error: 'Invalid wallet address' });
		}
		
		// If wallet changed, update session
		if (oldWalletAddress !== newWalletAddress) {
			// Create or get user for new wallet
			if (!db.users[newWalletAddress]) {
				db.users[newWalletAddress] = {
					userId: newWalletAddress,
					walletAddress: newWalletAddress,
					bestScore: 0,
					currentScore: 0,
					hayBalance: 0,
					totalMinutes: 0,
					totalAchievements: 0,
					savedPointsTotal: 0,
					hayFromPointsAwarded: 0,
					lastWithdrawalAt: null
				};
			}
			
			// Update session with new wallet
			session.walletAddress = newWalletAddress;
			saveDb(db);
		}
		
		res.json({ sessionId, user: db.users[newWalletAddress] });
	} catch (error) {
		console.error('Update wallet error:', error);
		res.status(500).json({ error: 'Internal server error. Please try again.' });
	}
});

// Heartbeat: server-side timing and awards
// Client should call every ~2s while alive
app.post('/api/heartbeat', (req, res) => {
	const { sessionId } = req.body || {};
	if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
	const db = loadDb();
	const session = db.sessions[sessionId];
	if (!session || session.type !== 'game') return res.status(404).json({ error: 'Invalid session' });
	if (!session.isAlive) {
		return res.json({ status: 'dead', elapsedMs: session.elapsedMsServer });
	}

	const now = Date.now();
	const delta = Math.min(5000, Math.max(0, now - session.lastHeartbeat));
	session.lastHeartbeat = now;
	session.elapsedMsServer += delta;

	saveDb(db);
	res.json({
		status: 'alive',
		elapsedMs: session.elapsedMsServer,
		points: session.points,
		user: db.users[session.walletAddress]
	});
});

// Progress endpoint: client reports obstacles passed (point-based)
app.post('/api/progress', (req, res) => {
	const { sessionId, passed = 0 } = req.body || {};
	if (!sessionId || typeof passed !== 'number' || passed <= 0) {
		return res.status(400).json({ error: 'Missing sessionId or invalid passed count' });
	}
	const db = loadDb();
	const session = db.sessions[sessionId];
	if (!session || session.type !== 'game') return res.status(404).json({ error: 'Invalid session' });
	if (!session.isAlive) return res.status(400).json({ error: 'Session not alive' });

	session.points += Math.floor(passed);
	const user = db.users[session.walletAddress];
	// Persist newly earned eligible points (multiples of 15)
	const alreadyAwarded = typeof session.pointsAwarded === 'number'
		? session.pointsAwarded
		: (session.savedStepsAwarded || 0) * 15;
	const eligible = Math.floor(session.points / 15) * 15;
	const delta = Math.max(0, eligible - alreadyAwarded);
	if (delta > 0) {
		// add total for each 15-like increment (15, 30, 45, etc.)
		user.savedPointsTotal = (user.savedPointsTotal || 0) + eligible;
		session.pointsAwarded = eligible;
	}
	user.totalAchievements += Math.floor(passed);
	saveDb(db);
	res.json({
		ok: true,
		points: session.points,
		savedPointsTotal: user.savedPointsTotal,
		user
	});
});

// Report game over (resets round progress if < 3 minutes)
app.post('/api/gameover', (req, res) => {
	const { sessionId } = req.body || {};
	if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
	const db = loadDb();
	const session = db.sessions[sessionId];
	if (!session || session.type !== 'game') return res.status(404).json({ error: 'Invalid session' });
	if (!session.isAlive) {
		const user = db.users[session.walletAddress] || null;
		return res.json({ ok: true, user });
	}

	// End session and persist confirmed increments
	endSession(db, sessionId, { removeSession: false });
	saveDb(db);
	res.json({ ok: true, user: db.users[session.walletAddress] });
});

// Get user status
app.get('/api/user/:walletAddress', (req, res) => {
	const { walletAddress } = req.params;
	const db = loadDb();
	const user = db.users[walletAddress];
	if (!user) return res.status(404).json({ error: 'User not found' });
	res.json(user);
});

// Get user by session ID
app.post('/api/user-by-session', (req, res) => {
	const { sessionId } = req.body || {};
	if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
	const db = loadDb();
	const session = db.sessions[sessionId];
	if (!session || session.type !== 'game') return res.status(404).json({ error: 'Invalid session' });
	const user = db.users[session.walletAddress];
	if (!user) return res.status(404).json({ error: 'User not found' });
	res.json({ user, sessionId });
});

// Convert saved points to HAY tokens (1000 points = 1 HAY)
app.post('/api/convert', (req, res) => {
	const { walletAddress, tokens = 1 } = req.body || {};
	if (!walletAddress) return res.status(400).json({ error: 'Missing walletAddress' });
	const n = Number(tokens);
	if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
		return res.status(400).json({ error: 'Invalid tokens value' });
	}
	const db = loadDb();
	const user = db.users[walletAddress];
	if (!user) return res.status(404).json({ error: 'User not found' });
	const neededPoints = n * 1000;
	const available = user.savedPointsTotal || 0;
	if (available < neededPoints) {
		return res.status(400).json({ error: `Insufficient saved points (${available})` });
	}
	user.savedPointsTotal = available - neededPoints;
	user.hayBalance = (user.hayBalance || 0) + n;
	saveDb(db);
	res.json({ ok: true, user });
});

// Withdrawal
app.post('/api/withdraw', async (req, res) => {
	const { walletAddress, amount } = req.body || {};
	if (!walletAddress || typeof amount !== 'number') {
		return res.status(400).json({ error: 'Missing walletAddress or amount' });
	}
	if (amount < 100) return res.status(400).json({ error: 'Minimum withdrawal is 100 HAY' });
	const db = loadDb();
	const user = db.users[walletAddress];
	if (!user) return res.status(404).json({ error: 'User not found' });
	if (user.hayBalance < amount) return res.status(400).json({ error: 'Insufficient balance' });

	user.hayBalance -= amount;
	user.lastWithdrawalAt = new Date().toISOString();
	saveDb(db);

	const transporter = createTransporter();
	const toEmail = process.env.WITHDRAW_ALERT_EMAIL || 'pragonna.example@gmail.com';
	const mail = {
		from: process.env.MAIL_FROM || 'no-reply@haygame.local',
		to: toEmail,
		subject: 'HAY Withdrawal Request',
		text: `User ID: ${user.userId}\nWallet: ${user.walletAddress}\nAmount: ${amount} HAY\nAt: ${user.lastWithdrawalAt}`
	};

	try {
		if (transporter) {
			await transporter.sendMail(mail);
		} else {
			// Fallback: log to file
			const logPath = path.join(DATA_DIR, 'withdrawals.log');
			fs.appendFileSync(logPath, `[NO SMTP] ${JSON.stringify(mail)}\n`);
		}
	} catch (e) {
		return res.status(500).json({ error: 'Failed to send withdrawal email' });
	}

	res.json({ ok: true, user });
});

// Save best score
app.post('/api/save-score', (req, res) => {
	const { sessionId, score } = req.body || {};
	if (!sessionId || typeof score !== 'number') {
		return res.status(400).json({ error: 'Missing sessionId or invalid score' });
	}
	const db = loadDb();
	const session = db.sessions[sessionId];
	if (!session || session.type !== 'game') {
		return res.status(404).json({ error: 'Invalid session' });
	}
	const user = db.users[session.walletAddress];
	if (!user) {
		return res.status(404).json({ error: 'User not found' });
	}
	
	// Update current score
	user.currentScore = score;
	
	// Update best score if this is better
	if (score > (user.bestScore || 0)) {
		user.bestScore = score;
	}
	
	saveDb(db);
	res.json({ ok: true, user });
});


// Get leaderboard (Top 10)
app.get('/api/leaderboard', (req, res) => {
	const db = loadDb();
	const users = Object.values(db.users || {});
	
	// Filter users with best score, sort by best score descending
	const players = users
		.filter(u => typeof u.bestScore === 'number' && u.bestScore > 0)
		.sort((a, b) => (b.bestScore || 0) - (a.bestScore || 0))
		.slice(0, 10)
		.map(u => ({
			walletAddress: u.walletAddress,
			bestScore: u.bestScore || 0
		}));
	
	res.json({ players });
});

// Disconnect wallet/session
app.post('/api/disconnect', (req, res) => {
	const { sessionId } = req.body || {};
	if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
	const db = loadDb();
	const session = db.sessions[sessionId];
	if (!session || session.type !== 'game') return res.status(404).json({ error: 'Invalid session' });
	const user = db.users[session.walletAddress] || null;

	// Treat disconnect as session end; persist confirmed points and remove session
	endSession(db, sessionId, { removeSession: true });
	saveDb(db);

	res.json({ ok: true, user });
});

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// No SPA routing; keep simple

const SSL_KEY = process.env.SSL_KEY_PATH;
const SSL_CERT = process.env.SSL_CERT_PATH;
if (SSL_KEY && SSL_CERT && fs.existsSync(SSL_KEY) && fs.existsSync(SSL_CERT)) {
	const sslOptions = { key: fs.readFileSync(SSL_KEY), cert: fs.readFileSync(SSL_CERT) };
	https.createServer(sslOptions, app).listen(PORT, () => {
		console.log(`HAY Token Game server running securely on https://localhost:${PORT}`);
	});
} else {
	http.createServer(app).listen(PORT, () => {
		console.log(`HAY Token Game server running on http://localhost:${PORT}`);
	});
}
