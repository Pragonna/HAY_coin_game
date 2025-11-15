import { Wallet, renderUser } from './wallet.js';

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const startBtn = document.getElementById('startBtn');
const jumpBtn = document.getElementById('jumpBtn');
const scoreEl = document.getElementById('score');
const timeEl = document.getElementById('time');
const roundMinutesEl = document.getElementById('roundMinutes');
const gameMsg = document.getElementById('gameMsg');

let gameState = 'idle'; // idle | running | dead
let score = 0;
let t0 = 0;
let lastFrame = 0;
let elapsedMsLocal = 0;
let glowPhase = 0;
let trailPhase = 0;
const groundY = 220;
let roundPoints = 0;
let speedTier = 0; // increases every 50 points

const player = {
	x: 72,
	y: groundY - 48,
	w: 38,
	h: 48,
	vy: 0,
	onGround: true,
	jumpsUsed: 0 // double jump
};

let obstacles = [];
function spawnObstacle() {
	const difficultyScale = 1 + Math.min(2, speedTier * 0.2);
	// All obstacles are candles now
	const width = 24;
	const height = 35 + Math.floor(Math.random() * 25);
	const candleX = canvas.width;
	const candleY = groundY - height;
	obstacles.push({
		type: 'candle',
		x: candleX,
		y: candleY,
		w: width,
		h: height,
		speed: (3 + Math.random() * 2) * difficultyScale,
		color: '#fbbf24',
		flamePhase: Math.random() * Math.PI * 2,
		passed: false
	});
}

function resetGame() {
	gameState = 'idle';
	score = 0;
	t0 = performance.now();
	lastFrame = t0;
	elapsedMsLocal = 0;
	player.x = 72;
	player.y = groundY - player.h;
	player.vy = 0;
	player.onGround = true;
	player.jumpsUsed = 0;
	obstacles = [];
	roundPoints = 0;
	speedTier = 0;
	gameMsg.textContent = '';
	scoreEl.textContent = '0';
	timeEl.textContent = '0s';
	roundMinutesEl.textContent = '0';
	startBtn.disabled = false; // Re-enable start button when reset
	render();
}

function jump() {
	if (gameState !== 'running') return;
	// double jump: allow 2 jumps total before touching ground
	const maxJumps = 2;
	if (player.jumpsUsed < maxJumps) {
		player.vy = player.jumpsUsed === 0 ? -9.8 : -7.2;
		player.onGround = false;
		player.jumpsUsed += 1;
	}
}

function collide(a, b) {
	return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

async function heartbeat() {
	if (!Wallet.sessionId) return;
	try {
		const res = await fetch('/api/heartbeat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sessionId: Wallet.sessionId })
		});
		if (!res.ok) return;
		const data = await res.json();
		if (data.status === 'dead') return;
		timeEl.textContent = `${Math.floor(data.elapsedMs / 1000)}s`;
		roundMinutesEl.textContent = `${roundPoints}`;
		if (data.user) {
			Wallet.user = data.user;
			renderUser();
		}
	} catch (e) {
		// ignore transient issues
	}
}
setInterval(heartbeat, 2000);

async function reportGameOver() {
	if (!Wallet.sessionId) return;
	try {
		await fetch('/api/gameover', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sessionId: Wallet.sessionId })
		});
	} catch (e) {}
}

async function saveBestScore(finalScore) {
	if (!Wallet.sessionId) return;
	try {
		const res = await fetch('/api/save-score', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sessionId: Wallet.sessionId, score: finalScore })
		});
		if (res.ok) {
			const data = await res.json();
			if (data.user) {
				Wallet.user = data.user;
				renderUser();
				// Reload leaderboard to show updated scores
				if (window.loadLeaderboard) {
					window.loadLeaderboard();
				}
			}
		}
	} catch (e) {}
}

async function sendProgress(passedCount) {
	if (!Wallet.sessionId) return;
	try {
		const res = await fetch('/api/progress', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sessionId: Wallet.sessionId, passed: passedCount })
		});
		if (res.ok) {
			const data = await res.json();
			if (data.user) {
				Wallet.user = data.user;
				renderUser();
			}
		}
	} catch (e) {}
}

function render() {
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	drawBackground();
	drawPlayer();
	obstacles.forEach(drawObstacle);
	drawGroundOverlay();
}

function update(dt) {
	// physics
	player.vy += 24 * dt; // gravity
	player.y += player.vy;
	if (player.y >= groundY - player.h) {
		player.y = groundY - player.h;
		player.vy = 0;
		player.onGround = true;
		player.jumpsUsed = 0;
	}
	// obstacles
	if (obstacles.length === 0 || obstacles[obstacles.length - 1].x < canvas.width - 200 - Math.random() * 200) {
		spawnObstacle();
	}
	obstacles.forEach(o => {
		o.x -= o.speed;
		if (o.type === 'candle') {
			o.flamePhase += dt * 6;
		}
	});
	// count passes
	let passedThisFrame = 0;
	obstacles.forEach(o => {
		if (!o.passed && (o.x + o.w) < player.x) {
			o.passed = true;
			passedThisFrame += 1;
		}
	});
	if (passedThisFrame > 0) {
		roundPoints += passedThisFrame;
		score += passedThisFrame; // 1 point per obstacle
		// increase speed tier every 50 points
		const newTier = Math.floor(roundPoints / 50);
		if (newTier > speedTier) speedTier = newTier;
		sendProgress(passedThisFrame);
	}
	obstacles = obstacles.filter(o => o.x + o.w > -40);

	// collision
	for (const o of obstacles) {
		if (collide(player, o)) {
			gameState = 'dead';
			gameMsg.textContent = 'Game Over!';
			startBtn.disabled = false; // Re-enable start button
			reportGameOver();
			// Save best score
			saveBestScore(score);
			render();
			break;
		}
	}
	// score/time
	elapsedMsLocal += dt * 1000;
	scoreEl.textContent = score.toString();
	timeEl.textContent = `${Math.floor(elapsedMsLocal / 1000)}s`;
	roundMinutesEl.textContent = `${roundPoints}`;
	// Update sidebar current score
	const currentScoreEl = document.getElementById('currentScore');
	if (currentScoreEl) currentScoreEl.textContent = String(score);
	glowPhase += dt * 3.8;
	trailPhase += dt * 4.5;
}

function loop(now) {
	if (gameState !== 'running') return;
	const dt = Math.min(0.05, (now - lastFrame) / 1000);
	lastFrame = now;
	update(dt);
	render();
	requestAnimationFrame(loop);
}

startBtn.addEventListener('click', () => {
	if (!Wallet.sessionId) {
		gameMsg.textContent = 'Connect Phantom wallet first.';
		return;
	}
	if (gameState === 'running') {
		return; // Already running
	}
	resetGame();
	gameState = 'running';
	startBtn.disabled = true;
	requestAnimationFrame(ts => {
		lastFrame = ts;
		requestAnimationFrame(loop);
	});
});

jumpBtn.addEventListener('click', jump);
window.addEventListener('keydown', (e) => {
	if (e.code === 'Space' || e.code === 'ArrowUp') {
		e.preventDefault();
		jump();
	}
});

resetGame();

function drawBackground() {
	const sky = ctx.createLinearGradient(0, 0, 0, canvas.height);
	sky.addColorStop(0, '#0d1b2a');
	sky.addColorStop(0.4, '#111827');
	sky.addColorStop(1, '#0b0f17');
	ctx.fillStyle = sky;
	ctx.fillRect(0, 0, canvas.width, canvas.height);

	// distant glow
	ctx.save();
	ctx.globalAlpha = 0.18;
	const glow = ctx.createRadialGradient(canvas.width * 0.6, groundY, 20, canvas.width * 0.6, groundY, 260);
	glow.addColorStop(0, '#38fbd6');
	glow.addColorStop(1, 'transparent');
	ctx.fillStyle = glow;
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.restore();
}

function drawGroundOverlay() {
	const groundGradient = ctx.createLinearGradient(0, groundY, 0, canvas.height);
	groundGradient.addColorStop(0, 'rgba(15,23,42,0.8)');
	groundGradient.addColorStop(1, 'rgba(8,11,19,1)');
	ctx.fillStyle = groundGradient;
	ctx.fillRect(0, groundY, canvas.width, canvas.height - groundY);

	ctx.fillStyle = 'rgba(94,234,212,0.15)';
	for (let i = 0; i < canvas.width; i += 60) {
		ctx.fillRect(i + (trailPhase * 12 % 60), groundY + 14, 28, 2);
	}
}

function drawPlayer() {
	const { x, y, w, h } = player;
	const depth = 12;
	const pulse = 6 + Math.sin(glowPhase) * 3;

	// Aura
	ctx.save();
	ctx.translate(x + w / 2, y + h / 2);
	ctx.globalAlpha = 0.22;
	ctx.fillStyle = '#70f7c4';
	ctx.beginPath();
	ctx.ellipse(0, 4, w * 0.8 + pulse, h * 0.7 + pulse, 0, 0, Math.PI * 2);
	ctx.fill();
	ctx.restore();

	ctx.save();
	ctx.translate(x, y);

	// Tail
	ctx.beginPath();
	ctx.moveTo(-depth * 0.8, h * 0.55);
	ctx.lineTo(0, h * 0.4);
	ctx.lineTo(0, h * 0.75);
	ctx.closePath();
	ctx.fillStyle = '#47e5b3';
	ctx.fill();

	// Top face
	ctx.beginPath();
	ctx.moveTo(0, 0);
	ctx.lineTo(depth, -depth);
	ctx.lineTo(w + depth, -depth);
	ctx.lineTo(w, 0);
	ctx.closePath();
	const topGradient = ctx.createLinearGradient(0, -depth, w, -depth);
	topGradient.addColorStop(0, '#9cfcd6');
	topGradient.addColorStop(1, '#6ee7b7');
	ctx.fillStyle = topGradient;
	ctx.fill();

	// Side face
	ctx.beginPath();
	ctx.moveTo(w, 0);
	ctx.lineTo(w + depth, -depth);
	ctx.lineTo(w + depth, h - depth);
	ctx.lineTo(w, h);
	ctx.closePath();
	const sideGradient = ctx.createLinearGradient(w, 0, w + depth, depth);
	sideGradient.addColorStop(0, '#27ddb0');
	sideGradient.addColorStop(1, '#0a9a84');
	ctx.fillStyle = sideGradient;
	ctx.fill();

	// Front face
	const frontGradient = ctx.createLinearGradient(0, 0, 0, h);
	frontGradient.addColorStop(0, '#7ef7c8');
	frontGradient.addColorStop(1, '#37d0a4');
	ctx.fillStyle = frontGradient;
	ctx.fillRect(0, 0, w, h);

	// Eye
	ctx.fillStyle = '#0f172a';
	const eyeSize = w * 0.18;
	ctx.fillRect(w * 0.62, h * 0.28, eyeSize, eyeSize);
	ctx.fillStyle = '#f8fafc';
	ctx.fillRect(w * 0.62 + 2, h * 0.28 + 2, eyeSize - 4, eyeSize - 4);

	// Eye pupil
	ctx.fillStyle = '#0f172a';
	ctx.fillRect(w * 0.62 + 4, h * 0.28 + 4, eyeSize - 8, eyeSize - 6);

	// Mouth line
	ctx.fillStyle = '#0f172a';
	ctx.fillRect(w * 0.2, h * 0.65, w * 0.36, 3);

	// Cheek highlight
	ctx.fillStyle = 'rgba(255,255,255,0.22)';
	ctx.beginPath();
	ctx.ellipse(w * 0.32, h * 0.5, 8, 5, 0, 0, Math.PI * 2);
	ctx.fill();

	// Top spikes
	ctx.fillStyle = '#46f4c5';
	for (let i = 0; i < 3; i++) {
		ctx.beginPath();
		const spikeX = w * 0.2 + i * 10;
		ctx.moveTo(spikeX, -6);
		ctx.lineTo(spikeX + 6, -14 - Math.sin(glowPhase + i) * 3);
		ctx.lineTo(spikeX + 12, -6);
		ctx.closePath();
		ctx.fill();
	}

	// Feet
	ctx.fillStyle = '#0f172a';
	ctx.fillRect(4, h - 4, 10, 4);
	ctx.fillRect(w - 14, h - 4, 10, 4);

	ctx.restore();

	// Trail
	ctx.save();
	const trailAlpha = 0.18;
	ctx.fillStyle = `rgba(110, 231, 183, ${trailAlpha})`;
	const segments = 6;
	for (let i = 0; i < segments; i++) {
		const offset = i * 14 + (Math.sin(trailPhase + i) * 4);
		ctx.fillRect(x - 18 - offset, y + h * 0.65, 12, 8);
	}
	ctx.restore();
}

function drawObstacle(obstacle) {
	const { x, y, w, h, type, flamePhase } = obstacle;
	ctx.save();
	if (type === 'candle') {
		// Candle body
		const candleGradient = ctx.createLinearGradient(x, y, x + w, y + h);
		candleGradient.addColorStop(0, '#fef3c7');
		candleGradient.addColorStop(0.5, '#fbbf24');
		candleGradient.addColorStop(1, '#d97706');
		ctx.fillStyle = candleGradient;
		ctx.fillRect(x, y, w, h);
		
		// Candle wick
		const wickX = x + w / 2;
		const wickY = y;
		ctx.fillStyle = '#1f2937';
		ctx.fillRect(wickX - 1, y - 4, 2, 4);
		
		// Flame (animated)
		const flameOffset = Math.sin(flamePhase) * 2;
		const flameHeight = 12 + Math.sin(flamePhase * 1.5) * 3;
		const flameWidth = 6 + Math.sin(flamePhase * 1.2) * 2;
		
		// Outer flame (orange/yellow)
		const flameGradient = ctx.createRadialGradient(wickX + flameOffset, wickY - flameHeight / 2, 0, wickX + flameOffset, wickY - flameHeight / 2, flameWidth);
		flameGradient.addColorStop(0, '#fef3c7');
		flameGradient.addColorStop(0.5, '#fbbf24');
		flameGradient.addColorStop(1, 'rgba(251, 191, 36, 0)');
		ctx.fillStyle = flameGradient;
		ctx.beginPath();
		ctx.ellipse(wickX + flameOffset, wickY - flameHeight / 2, flameWidth, flameHeight, 0, 0, Math.PI * 2);
		ctx.fill();
		
		// Inner flame (white/yellow core)
		const coreGradient = ctx.createRadialGradient(wickX + flameOffset, wickY - flameHeight / 2, 0, wickX + flameOffset, wickY - flameHeight / 2, flameWidth * 0.5);
		coreGradient.addColorStop(0, '#ffffff');
		coreGradient.addColorStop(1, 'rgba(254, 243, 199, 0)');
		ctx.fillStyle = coreGradient;
		ctx.beginPath();
		ctx.ellipse(wickX + flameOffset, wickY - flameHeight / 2, flameWidth * 0.5, flameHeight * 0.6, 0, 0, Math.PI * 2);
		ctx.fill();
		
		// Candle highlight
		ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
		ctx.fillRect(x + 2, y, w - 4, h * 0.3);
	}
	ctx.restore();
}

window.addEventListener('wallet-disconnected', () => {
	resetGame();
	gameMsg.textContent = 'Connect wallet to start a new run.';
});

window.addEventListener('wallet-connected', () => {
	gameMsg.textContent = 'Press Start to begin your cube run!';
});


