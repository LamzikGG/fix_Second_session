// ==================== СОСТОЯНИЕ ====================
let currentUser = null;
let currentChatUser = null;
let peerConnection = null;
let localStream = null;
let remoteStream = null;
let callId = null;
let isCaller = false;
let audioContext = null;
let analyser = null;
let users = [];
let messages = {};

const API_BASE_URL = 'http://localhost:8000';

// ==================== ИНИЦИАЛИЗАЦИЯ ====================
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded');
    initializeApp();
});

function initializeApp() {
    setupWindowControls();
    setupEventListeners();
    loadSavedCredentials();
    checkApiConnection();
    initAudioContext();
}

// ==================== ПРОВЕРКА СОЕДИНЕНИЙ ====================
async function checkApiConnection() {
    try {
        const response = await fetch(`${API_BASE_URL}/docs`, { method: 'HEAD' });
        console.log('✅ API connected on port 8000');
    } catch (error) {
        console.error('❌ API connection failed:', error);
        showError('Не удалось подключиться к серверу. Убедитесь, что бэкенд запущен на порту 8000');
    }
}

function initAudioContext() {
    try {
        window.AudioContext = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioContext();
        console.log('AudioContext initialized');
    } catch (e) {
        console.warn('Web Audio API not supported');
    }
}

// ==================== УПРАВЛЕНИЕ ОКНОМ ====================
function setupWindowControls() {
    const minimizeBtn = document.querySelector('.titlebar-btn.minimize');
    const maximizeBtn = document.querySelector('.titlebar-btn.maximize');
    const closeBtn = document.querySelector('.titlebar-btn.close');
    
    if (minimizeBtn) {
        minimizeBtn.onclick = (e) => {
            e.preventDefault();
            if (window.electronAPI) window.electronAPI.minimizeWindow();
        };
    }
    
    if (maximizeBtn) {
        maximizeBtn.onclick = (e) => {
            e.preventDefault();
            if (window.electronAPI) window.electronAPI.maximizeWindow();
        };
    }
    
    if (closeBtn) {
        closeBtn.onclick = (e) => {
            e.preventDefault();
            if (window.electronAPI) window.electronAPI.closeWindow();
        };
    }
}

// ==================== ОБРАБОТЧИКИ СОБЫТИЙ ====================
function setupEventListeners() {
    // Кнопки авторизации
    const loginBtn = document.getElementById('login-btn');
    const registerBtn = document.getElementById('register-btn');
    
    if (loginBtn) {
        loginBtn.onclick = (e) => {
            e.preventDefault();
            handleLogin();
        };
    }
    
    if (registerBtn) {
        registerBtn.onclick = (e) => {
            e.preventDefault();
            handleRegister();
        };
    }
    
    // Поля ввода
    const usernameInput = document.getElementById('username');
    const passwordInput = document.getElementById('password');
    
    if (passwordInput) {
        passwordInput.onkeypress = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleLogin();
            }
        };
    }
    
    // Отправка сообщения
    const sendBtn = document.getElementById('send-btn');
    const messageInput = document.getElementById('message-text');
    
    if (sendBtn) {
        sendBtn.onclick = sendMessage;
    }
    
    if (messageInput) {
        messageInput.onkeypress = (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        };
        
        messageInput.oninput = () => {
            if (currentChatUser && messageInput.value.trim() && window.electronAPI) {
                window.electronAPI.sendWebSocketMessage({
                    type: 'typing',
                    receiver_id: currentChatUser.id,
                    is_typing: true
                });
            }
        };
    }
    
    // Кнопки звонков
    const videoCallBtn = document.getElementById('video-call-btn');
    const audioCallBtn = document.getElementById('audio-call-btn');
    
    if (videoCallBtn) {
        videoCallBtn.onclick = () => initiateCall('video');
    }
    
    if (audioCallBtn) {
        audioCallBtn.onclick = () => initiateCall('audio');
    }
    
    // Кнопка новой группы
    const newGroupBtn = document.getElementById('new-group-btn');
    if (newGroupBtn) {
        newGroupBtn.onclick = createNewGroup;
    }
    
    // Поиск пользователей
    const searchInput = document.getElementById('search-users');
    if (searchInput) {
        searchInput.oninput = filterUsers;
    }
    
    // WebSocket события
    if (window.electronAPI) {
        window.electronAPI.onWebSocketConnected(() => {
            console.log('WebSocket connected');
            loadChatInterface();
        });
        
        window.electronAPI.onWebSocketMessage(handleWebSocketMessage);
        
        window.electronAPI.onWebSocketDisconnected(() => {
            console.log('WebSocket disconnected');
            showError('Отключено от сервера');
        });
        
        window.electronAPI.onCallResponse(handleCallResponse);
    }
}

// ==================== АВТОРИЗАЦИЯ ====================
async function handleLogin() {
    const username = document.getElementById('username')?.value.trim();
    const password = document.getElementById('password')?.value;
    
    if (!username || !password) {
        showError('Пожалуйста, заполните все поля');
        return;
    }
    
    showError('Вход в систему...');
    
    try {
        const formData = new URLSearchParams();
        formData.append('username', username);
        formData.append('password', password);
        
        const response = await fetch(`${API_BASE_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formData
        });
        
        const responseText = await response.text();
        
        if (!response.ok) {
            throw new Error(`Ошибка ${response.status}: ${responseText}`);
        }
        
        let data;
        try {
            data = JSON.parse(responseText);
        } catch (e) {
            data = { message: responseText };
        }
        
        // Извлекаем данные из ответа
        const accessToken = data.access_token || data.token;
        const userId = data.user_id || (data.data && data.data.user_id) || 1;
        
        currentUser = { 
            id: userId, 
            username: username,
            initial: username.charAt(0).toUpperCase()
        };
        
        // Сохраняем данные
        if (window.electronAPI) {
            if (accessToken) window.electronAPI.saveToStorage('token', accessToken);
            window.electronAPI.saveToStorage('userId', userId.toString());
            window.electronAPI.saveToStorage('username', username);
        }
        
        // Обновляем интерфейс
        document.getElementById('current-username').textContent = username;
        document.getElementById('current-username-initial').textContent = username.charAt(0).toUpperCase();
        
        // Подключаем WebSocket
        if (window.electronAPI) {
            window.electronAPI.connectWebSocket(userId.toString());
        }
        
        // Переключаем экраны
        document.getElementById('login-screen').classList.remove('active');
        document.getElementById('chat-screen').classList.add('active');
        
        showError('Вход выполнен успешно!');
        
    } catch (error) {
        console.error('Login error:', error);
        showError(error.message);
    }
}

async function handleRegister() {
    const username = document.getElementById('username')?.value.trim();
    const password = document.getElementById('password')?.value;
    
    if (!username || !password) {
        showError('Пожалуйста, заполните все поля');
        return;
    }
    
    showError('Регистрация...');
    
    try {
        const response = await fetch(`${API_BASE_URL}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        const responseText = await response.text();
        
        if (!response.ok) {
            throw new Error(`Ошибка ${response.status}: ${responseText}`);
        }
        
        showError('Регистрация успешна! Теперь можно войти.');
        document.getElementById('password').value = '';
        
    } catch (error) {
        console.error('Register error:', error);
        showError(error.message);
    }
}

function loadSavedCredentials() {
    if (!window.electronAPI) return;
    
    const savedUsername = window.electronAPI.getFromStorage('username');
    if (savedUsername) {
        document.getElementById('username').value = savedUsername;
    }
}

// ==================== ЧАТ ====================
function loadChatInterface() {
    console.log('Loading chat interface');
    if (window.electronAPI) {
        window.electronAPI.showNotification('Подключено', 'Вы в сети');
    }
    
    document.getElementById('message-text').disabled = false;
    document.getElementById('send-btn').disabled = false;
}

function handleWebSocketMessage(message) {
    console.log('WebSocket message:', message);
    
    switch (message.type) {
        case 'message':
            if (message.sender_id === currentChatUser?.id) {
                addMessageToChat(message, 'received');
            } else {
                // Уведомление о новом сообщении
                const sender = users.find(u => u.id === message.sender_id);
                if (sender && window.electronAPI) {
                    window.electronAPI.showNotification('Новое сообщение', 
                        `${sender.username}: ${message.content.substring(0, 50)}`);
                }
            }
            break;
            
        case 'users_list':
            updateUsersList(message.users);
            break;
            
        case 'typing':
            if (message.sender_id === currentChatUser?.id) {
                showTypingIndicator(message.is_typing);
            }
            break;
            
        case 'call_request':
            handleIncomingCall(message);
            break;
            
        case 'call_ended':
            handleCallEnded();
            break;
            
        case 'ice_candidate':
            handleIceCandidate(message);
            break;
    }
}

function updateUsersList(usersList) {
    users = usersList;
    const usersListEl = document.getElementById('users-list');
    if (!usersListEl) return;
    
    usersListEl.innerHTML = '';
    
    users.forEach(user => {
        if (user.id === currentUser?.id) return; // Не показываем себя
        
        const userEl = document.createElement('div');
        userEl.className = `user-item ${user.status}`;
        userEl.dataset.userId = user.id;
        
        userEl.innerHTML = `
            <div class="avatar">
                <span class="initial">${user.username.charAt(0).toUpperCase()}</span>
            </div>
            <div class="user-details">
                <span class="username">${user.username}</span>
                <span class="status ${user.status}">${user.status === 'online' ? 'Онлайн' : 'Не в сети'}</span>
            </div>
        `;
        
        userEl.onclick = () => selectUser(user);
        usersListEl.appendChild(userEl);
    });
}

function filterUsers() {
    const searchTerm = document.getElementById('search-users')?.value.toLowerCase();
    if (!searchTerm) {
        updateUsersList(users);
        return;
    }
    
    const filtered = users.filter(user => 
        user.username.toLowerCase().includes(searchTerm)
    );
    
    const usersListEl = document.getElementById('users-list');
    if (!usersListEl) return;
    
    usersListEl.innerHTML = '';
    
    filtered.forEach(user => {
        if (user.id === currentUser?.id) return;
        
        const userEl = document.createElement('div');
        userEl.className = `user-item ${user.status}`;
        userEl.dataset.userId = user.id;
        
        userEl.innerHTML = `
            <div class="avatar">
                <span class="initial">${user.username.charAt(0).toUpperCase()}</span>
            </div>
            <div class="user-details">
                <span class="username">${user.username}</span>
                <span class="status ${user.status}">${user.status === 'online' ? 'Онлайн' : 'Не в сети'}</span>
            </div>
        `;
        
        userEl.onclick = () => selectUser(user);
        usersListEl.appendChild(userEl);
    });
}

function selectUser(user) {
    currentChatUser = user;
    
    // Обновляем UI
    document.getElementById('chat-username').textContent = user.username;
    document.getElementById('chat-username-initial').textContent = user.username.charAt(0).toUpperCase();
    document.getElementById('chat-status').textContent = user.status === 'online' ? 'Онлайн' : 'Не в сети';
    document.getElementById('chat-status').className = `status ${user.status}`;
    
    // Активируем кнопки
    const audioCallBtn = document.getElementById('audio-call-btn');
    const videoCallBtn = document.getElementById('video-call-btn');
    
    if (audioCallBtn) audioCallBtn.disabled = user.status !== 'online';
    if (videoCallBtn) videoCallBtn.disabled = user.status !== 'online';
    
    document.getElementById('message-text').disabled = false;
    document.getElementById('send-btn').disabled = false;
    
    // Подсвечиваем выбранного пользователя
    document.querySelectorAll('.user-item').forEach(el => {
        el.classList.remove('active');
        if (el.dataset.userId == user.id) {
            el.classList.add('active');
        }
    });
    
    // Загружаем историю сообщений
    loadMessageHistory(user.id);
}

function loadMessageHistory(userId) {
    const container = document.getElementById('messages-container');
    if (!container) return;
    
    container.innerHTML = '';
    
    // Загружаем сохраненные сообщения
    const history = messages[userId] || [];
    history.forEach(msg => {
        addMessageToChat(msg, msg.sender_id === currentUser?.id ? 'sent' : 'received');
    });
}

function sendMessage() {
    const input = document.getElementById('message-text');
    if (!input || !input.value.trim() || !currentChatUser) return;
    
    const message = {
        type: 'message',
        receiver_id: currentChatUser.id,
        content: input.value.trim(),
        timestamp: new Date().toISOString()
    };
    
    // Сохраняем в историю
    if (!messages[currentChatUser.id]) {
        messages[currentChatUser.id] = [];
    }
    messages[currentChatUser.id].push({
        ...message,
        sender_id: currentUser.id
    });
    
    // Отправляем через WebSocket
    if (window.electronAPI) {
        window.electronAPI.sendWebSocketMessage(message);
    }
    
    // Отображаем в чате
    addMessageToChat({
        ...message,
        sender_id: currentUser.id
    }, 'sent');
    
    input.value = '';
}

function addMessageToChat(message, type) {
    const container = document.getElementById('messages-container');
    if (!container) return;
    
    const messageEl = document.createElement('div');
    messageEl.className = `message ${type}`;
    
    const time = new Date(message.timestamp).toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit'
    });
    
    messageEl.innerHTML = `
        <div class="message-content">${escapeHtml(message.content)}</div>
        <div class="message-time">${time}</div>
    `;
    
    container.appendChild(messageEl);
    container.scrollTop = container.scrollHeight;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showTypingIndicator(isTyping) {
    const statusEl = document.getElementById('chat-status');
    if (!statusEl || !currentChatUser) return;
    
    if (isTyping) {
        statusEl.textContent = 'Печатает...';
    } else {
        statusEl.textContent = currentChatUser.status === 'online' ? 'Онлайн' : 'Не в сети';
    }
}

function createNewGroup() {
    const groupName = prompt('Введите название группы:');
    if (!groupName) return;
    
    if (window.electronAPI) {
        window.electronAPI.sendWebSocketMessage({
            type: 'create_group',
            name: groupName
        });
    }
}

// ==================== ЗВОНКИ ====================
function initiateCall(type) {
    if (!currentChatUser) {
        showError('Выберите пользователя для звонка');
        return;
    }
    
    if (currentChatUser.status !== 'online') {
        showError('Пользователь не в сети');
        return;
    }
    
    callId = 'call_' + Date.now();
    isCaller = true;
    
    // Отправляем приглашение
    if (window.electronAPI) {
        window.electronAPI.sendWebSocketMessage({
            type: 'call_request',
            call_id: callId,
            target_user_id: currentChatUser.id,
            call_type: type,
            initiator_name: currentUser.username
        });
        
        window.electronAPI.showNotification('Вызов', `Звонок ${currentChatUser.username}`);
    }
    
    // Открываем окно звонка
    if (window.electronAPI) {
        window.electronAPI.openCallWindow({
            call_id: callId,
            call_type: type,
            initiator_id: currentUser.id,
            target_id: currentChatUser.id,
            initiator_name: currentUser.username
        });
    }
    
    // Запускаем WebRTC
    startWebRTCConnection();
}

function handleIncomingCall(data) {
    callId = data.call_id;
    isCaller = false;
    
    if (window.electronAPI) {
        window.electronAPI.openCallWindow({
            call_id: data.call_id,
            call_type: data.call_type,
            initiator_id: data.initiator_id,
            initiator_name: data.initiator_name || 'Пользователь'
        });
        
        window.electronAPI.showNotification('Входящий вызов', 
            `${data.initiator_name || 'Пользователь'} звонит вам`);
    }
}

function handleCallResponse(response) {
    console.log('Call response:', response);
    
    if (response.action === 'accept') {
        if (response.sdp) {
            startWebRTCConnection(response.sdp);
        }
    } else if (response.action === 'decline') {
        showError('Вызов отклонен');
        cleanupCall();
    }
}

function handleCallEnded() {
    showError('Вызов завершен');
    cleanupCall();
}

async function startWebRTCConnection(remoteSdp = null) {
    try {
        cleanupWebRTC();
        
        const constraints = {
            video: false, // Для теста отключаем видео
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        };
        
        try {
            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            setupAudioProcessing(localStream);
        } catch (err) {
            console.error('Media error:', err);
            showError('Не удалось получить доступ к микрофону');
            return;
        }
        
        peerConnection = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' }
            ]
        });
        
        peerConnection.onicecandidate = (event) => {
            if (event.candidate && callId && window.electronAPI) {
                window.electronAPI.sendWebSocketMessage({
                    type: 'ice_candidate',
                    call_id: callId,
                    candidate: event.candidate,
                    target_user_id: isCaller ? currentChatUser.id : currentUser.id
                });
            }
        };
        
        peerConnection.ontrack = (event) => {
            remoteStream = event.streams[0];
            if (window.electronAPI) {
                window.electronAPI.showNotification('Вызов подключен', 'Собеседник присоединился');
            }
        };
        
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
        
        if (isCaller) {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            
            if (window.electronAPI) {
                window.electronAPI.sendWebSocketMessage({
                    type: 'call_response',
                    call_id: callId,
                    action: 'accept',
                    sdp: offer
                });
            }
        } else if (remoteSdp) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(remoteSdp));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            
            if (window.electronAPI) {
                window.electronAPI.sendWebSocketMessage({
                    type: 'call_response',
                    call_id: callId,
                    action: 'accept',
                    sdp: answer
                });
            }
        }
        
    } catch (error) {
        console.error('WebRTC error:', error);
        showError('Ошибка вызова');
        cleanupCall();
    }
}

function handleIceCandidate(message) {
    if (!peerConnection) return;
    
    try {
        peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
    } catch (e) {
        console.error('Error adding ICE candidate:', e);
    }
}

function setupAudioProcessing(stream) {
    if (!audioContext || audioContext.state === 'closed') return;
    
    try {
        const source = audioContext.createMediaStreamSource(stream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
    } catch (e) {
        console.warn('Audio processing failed');
    }
}

function cleanupWebRTC() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    if (remoteStream) {
        remoteStream.getTracks().forEach(track => track.stop());
        remoteStream = null;
    }
    
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    
    if (analyser) {
        try { analyser.disconnect(); } catch (e) {}
        analyser = null;
    }
}

function cleanupCall() {
    cleanupWebRTC();
    callId = null;
    isCaller = false;
}

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================
function showError(message) {
    console.log('Show message:', message);
    const errorEl = document.getElementById('error-message');
    if (errorEl) {
        errorEl.textContent = message;
        errorEl.style.display = 'block';
        setTimeout(() => {
            errorEl.style.display = 'none';
        }, 3000);
    } else {
        alert(message);
    }
}

// Очистка при закрытии
window.addEventListener('beforeunload', () => {
    cleanupWebRTC();
});