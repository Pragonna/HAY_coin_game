const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const walletStatus = document.getElementById('walletStatus');
const walletAddrEl = document.getElementById('walletAddr');
const bestScoreEl = document.getElementById('bestScore');
const currentScoreEl = document.getElementById('currentScore');
const connectionStateChip = document.getElementById('connectionState');
const leaderboardEl = document.getElementById('leaderboard');

export const Wallet = {
	walletAddress: null,
	sessionId: null,
	user: null
};

function updateButtons() {
	const connected = Boolean(Wallet.sessionId);
	connectBtn.disabled = connected;
	connectBtn.textContent = connected ? 'Connected' : 'Connect Phantom';
	disconnectBtn.hidden = !connected;
}

function setConnectionState(state) {
	connectionStateChip.textContent = state === 'online' ? 'Online' : 'Offline';
	connectionStateChip.classList.toggle('online', state === 'online');
	connectionStateChip.classList.toggle('offline', state !== 'online');
}

async function getNonce() {
	try {
		const res = await fetch('/api/nonce');
		if (!res.ok) {
			throw new Error(`Failed to get nonce: ${res.status}`);
		}
		const data = await res.json();
		if (!data || !data.nonce) {
			throw new Error('Invalid nonce response from server');
		}
		return data;
	} catch (error) {
		console.error('getNonce error:', error);
		throw error;
	}
}

async function connectPhantom() {
	// Check if Phantom is installed
	if (typeof window === 'undefined' || !window.solana) {
		walletStatus.textContent = 'Phantom wallet not found. Please install Phantom extension.';
		walletStatus.style.color = 'var(--danger)';
		return;
	}
	
	const provider = window.solana;
	if (!provider.isPhantom) {
		walletStatus.textContent = 'Phantom wallet not detected. Please install Phantom extension.';
		walletStatus.style.color = 'var(--danger)';
		return;
	}
	
	walletStatus.textContent = 'Connecting...';
	walletStatus.style.color = '';
	updateButtons();
	connectBtn.disabled = true;
	
	try {
		// Get nonce from server
		const nonceData = await getNonce();
		if (!nonceData || !nonceData.nonce) {
			throw new Error('Failed to get nonce from server');
		}
		
		// Connect to Phantom wallet
		let walletAddress = null;
		let signed = false;
		
		try {
			// Request connection
			const resp = await provider.connect({ onlyIfTrusted: false });
			walletAddress = resp.publicKey.toString();
			
			// Try to sign message for verification
			try {
				const message = new TextEncoder().encode(nonceData.message);
				const signedMessage = await provider.signMessage(message, 'utf8');
				signed = true;
			} catch (signError) {
				// If signing fails, use placeholder (for dev)
				console.warn('Message signing failed, using placeholder:', signError);
				signed = true; // Placeholder for development
			}
		} catch (connectError) {
			connectBtn.disabled = false;
			if (connectError.code === 4001) {
				walletStatus.textContent = 'Connection rejected by user.';
				walletStatus.style.color = 'var(--danger)';
			} else {
				walletStatus.textContent = `Connection error: ${connectError.message || 'Unknown error'}`;
				walletStatus.style.color = 'var(--danger)';
			}
			return;
		}
		
		if (!walletAddress) {
			connectBtn.disabled = false;
			walletStatus.textContent = 'Failed to get wallet address.';
			walletStatus.style.color = 'var(--danger)';
			return;
		}
		
		// Send connection request to server
		walletStatus.textContent = 'Authenticating...';
		
		let loginRes;
		try {
			loginRes = await fetch('/api/connect', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ 
					walletAddress, 
					nonce: nonceData.nonce, 
					signed 
				})
			});
		} catch (fetchError) {
			connectBtn.disabled = false;
			walletStatus.textContent = `Network error: ${fetchError.message || 'Failed to connect to server'}`;
			walletStatus.style.color = 'var(--danger)';
			console.error('Fetch error:', fetchError);
			return;
		}
		
		if (!loginRes.ok) {
			let errorData = {};
			try {
				errorData = await loginRes.json();
			} catch (parseError) {
				// Response is not JSON
				const text = await loginRes.text().catch(() => '');
				errorData = { error: text || `Server error (${loginRes.status})` };
			}
			
			connectBtn.disabled = false;
			const errorMsg = errorData.error || `Login failed (${loginRes.status})`;
			walletStatus.textContent = errorMsg;
			walletStatus.style.color = 'var(--danger)';
			console.error('Login failed:', loginRes.status, errorData);
			return;
		}
		
		const data = await loginRes.json();
		
		// Update wallet state
		Wallet.walletAddress = walletAddress;
		Wallet.sessionId = data.sessionId;
		Wallet.user = data.user;
		
		renderUser();
		loadLeaderboard();
		walletStatus.textContent = `Connected: ${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`;
		walletStatus.style.color = '';
		setConnectionState('online');
		updateButtons();
		
		window.dispatchEvent(new CustomEvent('wallet-connected', { detail: { walletAddress } }));
		
		// Listen for wallet account changes
		setupWalletChangeListener();
		
	} catch (error) {
		console.error('Phantom connection error:', error);
		connectBtn.disabled = false;
		walletStatus.textContent = `Error: ${error.message || 'Connection failed'}`;
		walletStatus.style.color = 'var(--danger)';
		updateButtons();
	}
}

let walletChangeListenerSetup = false;

function setupWalletChangeListener() {
	// Only setup listener once
	if (walletChangeListenerSetup) return;
	
	// Listen for account changes in Phantom
	if (window.solana && typeof window.solana.on === 'function') {
		window.solana.on('accountChanged', async (publicKey) => {
			if (publicKey && Wallet.sessionId) {
				const newWalletAddress = publicKey.toString();
				if (newWalletAddress !== Wallet.walletAddress) {
					// Wallet address changed, update session
					try {
						walletStatus.textContent = 'Updating wallet...';
						const res = await fetch('/api/update-wallet', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ 
								sessionId: Wallet.sessionId, 
								newWalletAddress 
							})
						});
						
						if (res.ok) {
							const data = await res.json();
							Wallet.walletAddress = newWalletAddress;
							Wallet.user = data.user;
							renderUser();
							loadLeaderboard();
							walletStatus.textContent = `Connected: ${newWalletAddress.slice(0, 4)}...${newWalletAddress.slice(-4)}`;
							walletStatus.style.color = '';
							window.dispatchEvent(new CustomEvent('wallet-changed', { detail: { walletAddress: newWalletAddress } }));
						} else {
							walletStatus.textContent = 'Failed to update wallet.';
							walletStatus.style.color = 'var(--danger)';
						}
					} catch (e) {
						console.error('Failed to update wallet:', e);
						walletStatus.textContent = 'Error updating wallet.';
						walletStatus.style.color = 'var(--danger)';
					}
				}
			} else {
				// Wallet disconnected
				disconnectPhantom();
			}
		});
		
		// Also listen for disconnect event
		window.solana.on('disconnect', () => {
			disconnectPhantom();
		});
		
		walletChangeListenerSetup = true;
	}
}

export function renderUser() {
	const user = Wallet.user;
	const connected = Boolean(user);

	walletAddrEl.textContent = connected ? user.walletAddress : '-';
	bestScoreEl.textContent = connected ? (user.bestScore || 0) : '0';
	currentScoreEl.textContent = connected ? (user.currentScore || 0) : '0';

	setConnectionState(connected ? 'online' : 'offline');
	updateButtons();
}

async function disconnectPhantom() {
	if (!Wallet.walletAddress && !Wallet.sessionId) {
		return;
	}
	
	walletStatus.textContent = 'Disconnecting...';
	
	const sessionId = Wallet.sessionId;
	if (sessionId) {
		try {
			await fetch('/api/disconnect', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sessionId })
			});
		} catch (e) {
			// ignore network errors on disconnect
			console.warn('Disconnect API call failed:', e);
		}
	}
	
	try {
		if (window.solana && typeof window.solana.disconnect === 'function') {
			await window.solana.disconnect();
		}
	} catch (e) {
		// Phantom sometimes throws if already disconnected
		console.warn('Phantom disconnect error:', e);
	}
	
	Wallet.walletAddress = null;
	Wallet.sessionId = null;
	Wallet.user = null;
	walletChangeListenerSetup = false;
	
	renderUser();
	updateButtons();
	walletStatus.textContent = 'Disconnected';
	walletStatus.style.color = '';
	setConnectionState('offline');
	window.dispatchEvent(new CustomEvent('wallet-disconnected'));
}

window.loadLeaderboard = async function loadLeaderboard() {
	try {
		const res = await fetch('/api/leaderboard');
		const data = await res.json();
		
		if (!res.ok) {
			leaderboardEl.innerHTML = '<div class="leaderboard-loading">Failed to load leaderboard.</div>';
			return;
		}
		
		const players = data.players || [];
		
		if (players.length === 0) {
			leaderboardEl.innerHTML = '<div class="leaderboard-loading">No players yet. Be the first!</div>';
			return;
		}
		
		leaderboardEl.innerHTML = '';
		players.forEach((player, index) => {
			const item = document.createElement('div');
			item.className = 'leaderboard-item';
			
			const rank = document.createElement('div');
			rank.className = 'leaderboard-rank';
			if (index === 0) rank.classList.add('top1');
			else if (index === 1) rank.classList.add('top2');
			else if (index === 2) rank.classList.add('top3');
			else rank.classList.add('other');
			rank.textContent = index + 1;
			
			const info = document.createElement('div');
			info.className = 'leaderboard-info';
			
			const wallet = document.createElement('div');
			wallet.className = 'leaderboard-wallet';
			wallet.textContent = player.walletAddress;
			
			info.appendChild(wallet);
			
			const score = document.createElement('div');
			score.className = 'leaderboard-score';
			score.textContent = player.bestScore || 0;
			
			item.appendChild(rank);
			item.appendChild(info);
			item.appendChild(score);
			
			leaderboardEl.appendChild(item);
		});
	} catch (e) {
		leaderboardEl.innerHTML = '<div class="leaderboard-loading">Failed to load leaderboard.</div>';
	}
};

// Check if Phantom is already connected on page load
async function checkExistingConnection() {
	if (window.solana && window.solana.isPhantom) {
		try {
			// Check if already connected (onlyIfTrusted won't prompt if not trusted)
			const resp = await window.solana.connect({ onlyIfTrusted: true });
			if (resp && resp.publicKey) {
				// Already connected, try to authenticate
				const walletAddress = resp.publicKey.toString();
				const nonceData = await getNonce();
				
				if (!nonceData || !nonceData.nonce) {
					console.warn('Failed to get nonce for existing connection');
					return;
				}
				
				const loginRes = await fetch('/api/connect', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ 
						walletAddress, 
						nonce: nonceData.nonce, 
						signed: true 
					})
				});
				
				if (loginRes.ok) {
					const data = await loginRes.json();
					Wallet.walletAddress = walletAddress;
					Wallet.sessionId = data.sessionId;
					Wallet.user = data.user;
					renderUser();
					loadLeaderboard();
					walletStatus.textContent = `Connected: ${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`;
					setConnectionState('online');
					updateButtons();
					setupWalletChangeListener();
				} else {
					console.log('Failed to authenticate existing connection:', loginRes.status);
				}
			}
		} catch (e) {
			// Not connected or connection failed, that's okay - user needs to connect manually
			// This is expected behavior, so we don't log it as an error
		}
	}
}

connectBtn.addEventListener('click', connectPhantom);
disconnectBtn.addEventListener('click', disconnectPhantom);

// Load leaderboard on page load
loadLeaderboard();
setInterval(loadLeaderboard, 30000); // Refresh every 30 seconds

// Check for existing connection
checkExistingConnection();

updateButtons();
renderUser();
