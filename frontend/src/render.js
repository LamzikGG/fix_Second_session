// ==================== СОСТОЯНИЕ ====================
let currentUser = null;
let currentChatUser = null;
let currentGroupId = null;
let peerConnection = null;
let localStream = null;
let remoteStream = null;
let callId = null;
let isCaller = false;
let pendingOffer = null; // у того, кому звонят: offer от caller до нажатия «Принять»
let callPeerId = null; // id собеседника для ICE/завершения звонка
let audioContext = null;
let analyser = null;
let users = [];
let friends = [];
let friendRequests = [];
let groups = [];
let messages = {};
let authToken = null;
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
    
    // Аудио звонок
    const audioCallBtn = document.getElementById('audio-call-btn');
    if (audioCallBtn) {
        audioCallBtn.onclick = () => initiateCall('audio');
    }
    
    // Завершить звонок
    const callBarHangup = document.getElementById('call-bar-hangup');
    if (callBarHangup) {
        callBarHangup.onclick = () => {
            if (callId && window.electronAPI) {
                window.electronAPI.sendWebSocketMessage({
                    type: 'call_end',
                    call_id: callId
                });
            }
            cleanupCall();
            hideCallBar();
        };
    }
    
    // Кнопка новой группы (в groups-section)
    const createGroupBtn = document.getElementById('create-group-btn');
    if (createGroupBtn) {
        createGroupBtn.onclick = showGroupModal;
    }
    
    // Модалка группы
    const modalClose = document.getElementById('modal-close');
    const modalCancel = document.getElementById('modal-cancel');
    const modalCreate = document.getElementById('modal-create');
    const groupNameInput = document.getElementById('group-name');
    
    if (modalClose) modalClose.onclick = hideGroupModal;
    if (modalCancel) modalCancel.onclick = hideGroupModal;
    if (modalCreate) modalCreate.onclick = createNewGroup;
    
    if (groupNameInput) {
        groupNameInput.onkeypress = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                createNewGroup();
            }
        };
    }
    
    // Поиск пользователей
    const searchInput = document.getElementById('search-users');
    if (searchInput) {
        let searchTimeout;
        searchInput.oninput = () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                searchUsers(searchInput.value);
            }, 500);
        };
    }
    
    // Управление группой модалка
    const manageModalClose = document.getElementById('manage-modal-close');
    const leaveGroupBtn = document.getElementById('leave-group-btn');
    const addMemberBtn = document.getElementById('add-member-btn');
    
    if (manageModalClose) {
        manageModalClose.onclick = () => {
            document.getElementById('group-manage-modal').classList.remove('active');
        };
    }
    
    if (leaveGroupBtn) {
        leaveGroupBtn.onclick = async () => {
            if (!currentGroupId) return;
            if (!confirm('Выйти из группы?')) return;
            
            try {
                const resp = await authorizedFetch(
                    `${API_BASE_URL}/groups/${currentGroupId}/leave`,
                    { method: 'POST' }
                );
                
                if (resp.ok) {
                    document.getElementById('group-manage-modal').classList.remove('active');
                    await fetchGroups();
                    currentGroupId = null;
                    currentChatUser = null;
                    showError('Вы вышли из группы');
                    
                    document.getElementById('messages-container').innerHTML = `
                        <div class="empty-chat">
                            <p>Выберите чат для начала общения</p>
                        </div>
                    `;
                }
            } catch (e) {
                showError('Ошибка при выходе из группы');
            }
        };
    }
    
    if (addMemberBtn) {
        addMemberBtn.onclick = async () => {
            const input = document.getElementById('new-member-login');
            const login = input?.value.trim();
            if (!login || !currentGroupId) return;
            
            try {
                const resp = await authorizedFetch(
                    `${API_BASE_URL}/groups/${currentGroupId}/members`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ user_login: login })
                    }
                );
                
                if (resp.ok) {
                    input.value = '';
                    await showGroupManageModal(currentGroupId);
                    await fetchGroups();
                    showError('Участник добавлен');
                }
            } catch (e) {
                showError('Ошибка при добавлении участника');
            }
        };
    }
    
    // Кнопка управления группой
    const groupManageBtn = document.getElementById('group-manage-btn');
    if (groupManageBtn) {
        groupManageBtn.onclick = () => {
            if (currentGroupId) {
                showGroupManageModal(currentGroupId);
            }
        };
    }
    
    // WebSocket события
    if (window.electronAPI) {
        window.electronAPI.onWebSocketConnected(() => {
            console.log('WebSocket connected');
            loadChatInterface();
            fetchFriends();
            fetchGroups();
            fetchFriendRequests();
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
        
        const json = await response.json();
        
        if (!response.ok) {
            throw new Error(`Ошибка ${response.status}: ${JSON.stringify(json)}`);
        }
        
        const data = json.data || {};
        const accessToken = data.access_token;
        const userId = data.user_id;
        
        if (!accessToken || !userId) {
            throw new Error('Отсутствуют данные авторизации');
        }
        
        authToken = accessToken;
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

// ==================== ПОИСК И ДОБАВЛЕНИЕ ДРУЗЕЙ ====================
async function searchUsers(query) {
    // Удаляем старые результаты
    const existingResults = document.querySelector('.search-results');
    if (existingResults) {
        existingResults.remove();
    }
    
    if (!query || query.length < 2) {
        return;
    }
    
    // Показываем индикатор загрузки
    const searchBox = document.querySelector('.search-box');
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'search-results loading';
    loadingDiv.innerHTML = '<div class="loading-text">Поиск...</div>';
    searchBox.appendChild(loadingDiv);
    
    try {
        const resp = await authorizedFetch(`${API_BASE_URL}/users/search?q=${encodeURIComponent(query)}`);
        loadingDiv.remove();
        
        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
        }
        
        const json = await resp.json();
        const searchResults = json.data || [];
        
        if (searchResults.length === 0) {
            const noResults = document.createElement('div');
            noResults.className = 'search-results';
            noResults.innerHTML = '<div class="no-results">Пользователи не найдены</div>';
            searchBox.appendChild(noResults);
            return;
        }
        
        displaySearchResults(searchResults);
    } catch (e) {
        loadingDiv.remove();
        console.error('Search error:', e);
        const errorDiv = document.createElement('div');
        errorDiv.className = 'search-results';
        errorDiv.innerHTML = '<div class="error-text">Ошибка поиска</div>';
        searchBox.appendChild(errorDiv);
    }
}

function displaySearchResults(searchResults) {
    const searchBox = document.querySelector('.search-box');
    if (!searchBox) return;
    
    const resultsDiv = document.createElement('div');
    resultsDiv.className = 'search-results';
    
    searchResults.forEach(user => {
        if (user.id === currentUser?.id) return;
        
        const userEl = document.createElement('div');
        userEl.className = 'search-result-item';
        userEl.innerHTML = `
            <div class="avatar small">
                <span class="initial">${user.username.charAt(0).toUpperCase()}</span>
            </div>
            <div class="user-details">
                <span class="username">${escapeHtml(user.username)}</span>
                <span class="status ${user.status || 'offline'}">
                    ${user.status === 'online' ? 'Онлайн' : 'Не в сети'}
                </span>
            </div>
            <button class="btn-add-friend" data-user-id="${user.id}">
                <svg width="16" height="16" viewBox="0 0 20 20">
                    <line x1="10" y1="4" x2="10" y2="16" stroke="white" stroke-width="2"/>
                    <line x1="4" y1="10" x2="16" y2="10" stroke="white" stroke-width="2"/>
                </svg>
            </button>
        `;
        resultsDiv.appendChild(userEl);
    });
    
    searchBox.appendChild(resultsDiv);
    
    // Обработчики кнопок добавления
    document.querySelectorAll('.btn-add-friend').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const userId = btn.dataset.userId;
            addFriend(userId);
        };
    });
    
    // Закрытие при клике вне
    document.addEventListener('click', function closeSearch(e) {
        if (!searchBox.contains(e.target)) {
            resultsDiv.remove();
            document.removeEventListener('click', closeSearch);
        }
    });
}

async function addFriend(friendId) {
    try {
        const resp = await authorizedFetch(`${API_BASE_URL}/friends/add`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ friend_id: parseInt(friendId) })
        });
        
        if (resp.ok) {
            showError('Запрос на добавление в друзья отправлен');
            
            // Уведомляем через WebSocket
            if (window.electronAPI) {
                window.electronAPI.sendWebSocketMessage({
                    type: 'friend_request',
                    target_user_id: parseInt(friendId)
                });
            }
            
            // Скрываем результаты поиска
            const results = document.querySelector('.search-results');
            if (results) results.remove();
            
            // Обновляем список друзей
            await fetchFriends();
        } else {
            const error = await resp.json();
            showError(error.detail || 'Ошибка при добавлении друга');
        }
    } catch (e) {
        console.error('Add friend error:', e);
        showError('Ошибка при добавлении друга');
    }
}

async function fetchFriends() {
    try {
        const resp = await authorizedFetch(`${API_BASE_URL}/friends`);
        const json = await resp.json();
        friends = json.data || [];
        
        // Преобразуем друзей в пользователей для отображения
        const usersList = friends.map(friend => ({
            id: friend.id,
            username: friend.username,
            status: friend.status || 'offline',
            last_seen: friend.last_seen
        }));
        
        updateUsersList(usersList);
    } catch (e) {
        console.error('Fetch friends error:', e);
        // Показываем пустое состояние
        const usersListEl = document.getElementById('users-list');
        if (usersListEl) {
            usersListEl.innerHTML = `
                <div class="empty-chat" style="padding: 20px;">
                    <p>Нет друзей</p>
                    <small>Используйте поиск для добавления</small>
                </div>
            `;
        }
    }
}

async function fetchFriendRequests() {
    try {
        const resp = await authorizedFetch(`${API_BASE_URL}/friends/requests`);
        const json = await resp.json();
        friendRequests = json.data || [];
        updateFriendRequestsList(friendRequests);
    } catch (e) {
        console.error('Fetch friend requests error:', e);
    }
}

function updateFriendRequestsList(requests) {
    const listEl = document.getElementById('friend-requests-list');
    if (!listEl) return;
    
    listEl.innerHTML = '';
    
    if (!requests.length) {
        listEl.innerHTML = `
            <div class="empty-chat" style="padding: 10px;">
                <p style="font-size: 12px;">Нет заявок</p>
            </div>
        `;
        return;
    }
    
    requests.forEach(req => {
        const item = document.createElement('div');
        item.className = 'friend-request-item';
        item.innerHTML = `
            <div class="avatar small">
                <span class="initial">${req.username.charAt(0).toUpperCase()}</span>
            </div>
            <div class="user-details">
                <span class="username">${escapeHtml(req.username)}</span>
            </div>
            <button class="btn-primary btn-small" data-request-id="${req.friendship_id}">
                Принять
            </button>
        `;
        listEl.appendChild(item);
    });
    
    listEl.querySelectorAll('.btn-small').forEach(btn => {
        btn.onclick = () => {
            const id = btn.dataset.requestId;
            if (id) {
                acceptFriendRequest(parseInt(id, 10));
            }
        };
    });
}

async function acceptFriendRequest(friendshipId) {
    try {
        const resp = await authorizedFetch(
            `${API_BASE_URL}/friends/accept/${friendshipId}`,
            { method: 'POST' }
        );
        
        if (resp.ok) {
            showError('Пользователь добавлен в друзья');
            await fetchFriends();
            await fetchFriendRequests();
        } else {
            const err = await resp.json();
            showError(err.detail || 'Не удалось принять заявку');
        }
    } catch (e) {
        console.error('Accept friend error:', e);
        showError('Ошибка при принятии заявки');
    }
}

// ==================== ГРУППЫ ====================
async function fetchGroups() {
    try {
        const resp = await authorizedFetch(`${API_BASE_URL}/groups`);
        const json = await resp.json();
        groups = json.data || [];
        updateGroupsList(groups);
    } catch (e) {
        console.error('Fetch groups error:', e);
    }
}

function updateGroupsList(groupsList) {
    const groupsListEl = document.getElementById('groups-list');
    if (!groupsListEl) return;
    
    groupsListEl.innerHTML = '';
    
    groupsList.forEach(group => {
        const groupEl = document.createElement('div');
        groupEl.className = 'group-item';
        groupEl.dataset.groupId = group.id;
        groupEl.innerHTML = `
            <div class="avatar">
                <span class="initial">${group.name.charAt(0).toUpperCase()}</span>
            </div>
            <div class="user-details">
                <span class="username">${escapeHtml(group.name)}</span>
                <span class="status">${group.members_count} участников</span>
            </div>
        `;
        groupEl.onclick = () => selectGroup(group);
        groupsListEl.appendChild(groupEl);
    });
}

async function createNewGroup() {
    const input = document.getElementById('group-name');
    const groupName = input?.value.trim();
    const membersInput = document.getElementById('group-members');
    const rawMembers = membersInput?.value || '';
    
    // Парсим логины участников из строки "user1, user2, user3"
    const members = rawMembers
        .split(',')
        .map(m => m.trim())
        .filter(m => m.length > 0);
    
    if (!groupName) {
        showError('Введите название группы');
        return;
    }
    
    try {
        const resp = await authorizedFetch(`${API_BASE_URL}/groups/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: groupName, members })
        });
        
        if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(`Ошибка ${resp.status}: ${txt}`);
        }
        
        hideGroupModal();
        await fetchGroups();
        
        if (window.electronAPI) {
            window.electronAPI.showNotification('Группа создана', groupName);
        }
        
        showError('Группа создана');
    } catch (e) {
        console.error('Create group error:', e);
        showError(e.message);
    }
}

function showGroupModal() {
    const modal = document.getElementById('group-modal');
    const input = document.getElementById('group-name');
    
    if (modal && input) {
        input.value = '';
        modal.classList.add('active');
        input.focus();
    }
}

function hideGroupModal() {
    const modal = document.getElementById('group-modal');
    if (modal) {
        modal.classList.remove('active');
    }
}

async function selectGroup(group) {
    currentGroupId = group.id;
    currentChatUser = {
        id: group.id,
        username: group.name,
        is_group: true,
        status: 'online',
        members_count: group.members_count
    };
    
    // Обновляем UI заголовка
    document.getElementById('chat-username').textContent = group.name;
    document.getElementById('chat-username-initial').textContent = group.name.charAt(0).toUpperCase();
    document.getElementById('chat-status').textContent = `${group.members_count} участников`;
    document.getElementById('chat-status').className = 'status online';
    
    // Показываем кнопку управления группой
    const groupManageBtn = document.getElementById('group-manage-btn');
    if (groupManageBtn) {
        groupManageBtn.style.display = 'flex';
        groupManageBtn.onclick = () => showGroupManageModal(group.id);
    }
    
    // Блокируем звонок для групп
    const acBtn = document.getElementById('audio-call-btn');
    if (acBtn) acBtn.disabled = true;
    
    // Активируем ввод сообщений
    document.getElementById('message-text').disabled = false;
    document.getElementById('send-btn').disabled = false;
    
    // Подсветка активной группы
    document.querySelectorAll('.group-item').forEach(el => {
        el.classList.toggle('active', parseInt(el.dataset.groupId) === group.id);
    });
    document.querySelectorAll('.user-item').forEach(el => {
        el.classList.remove('active');
    });
    
    // Загружаем историю сообщений
    await loadMessageHistory(group.id, true);
}

async function showGroupManageModal(groupId) {
    const modal = document.getElementById('group-manage-modal');
    const membersList = document.getElementById('group-members-list');
    const addMemberSection = document.getElementById('add-member-section');
    const deleteBtn = document.getElementById('delete-group-btn');
    
    if (!modal || !membersList) return;
    
    // Загружаем информацию о группе
    try {
        const [groupResp, membersResp] = await Promise.all([
            authorizedFetch(`${API_BASE_URL}/groups/${groupId}`),
            authorizedFetch(`${API_BASE_URL}/groups/${groupId}/members`)
        ]);
        
        const groupJson = await groupResp.json();
        const membersJson = await membersResp.json();
        
        const group = groupJson.data;
        const members = membersJson.data || [];
        
        membersList.innerHTML = '';
        
        const isOwner = group.creator_id === currentUser.id;
        
        members.forEach(member => {
            const memberEl = document.createElement('div');
            memberEl.className = 'group-member-item';
            const isYou = member.id === currentUser.id;
            const isAdmin = member.is_admin;
            
            memberEl.innerHTML = `
                <div class="avatar small">
                    <span class="initial">${member.username.charAt(0).toUpperCase()}</span>
                </div>
                <div class="member-info">
                    <span class="username">
                        ${escapeHtml(member.username)}
                        ${isYou ? '<span class="you-badge">Вы</span>' : ''}
                        ${isAdmin ? '<span class="admin-badge">Админ</span>' : ''}
                    </span>
                </div>
                ${!isYou && (isOwner || group.is_admin) ? `
                    <button class="btn-remove-member" data-member-id="${member.id}">
                        ×
                    </button>
                ` : ''}
            `;
            membersList.appendChild(memberEl);
        });
        
        // Показываем секцию добавления только для владельца/админа
        if (addMemberSection) {
            addMemberSection.style.display = (isOwner || group.is_admin) ? 'block' : 'none';
        }
        
        // Кнопка удаления только для владельца
        if (deleteBtn) {
            deleteBtn.style.display = isOwner ? 'block' : 'none';
            deleteBtn.onclick = () => deleteGroup(groupId);
        }
        
        // Обработчики удаления участников
        document.querySelectorAll('.btn-remove-member').forEach(btn => {
            btn.onclick = () => removeGroupMember(groupId, btn.dataset.memberId);
        });
        
        modal.classList.add('active');
    } catch (e) {
        console.error('Load group error:', e);
        showError('Не удалось загрузить информацию о группе');
    }
}

async function deleteGroup(groupId) {
    if (!confirm('Вы уверены, что хотите удалить группу?')) return;
    
    try {
        const resp = await authorizedFetch(`${API_BASE_URL}/groups/${groupId}`, {
            method: 'DELETE'
        });
        
        if (resp.ok) {
            document.getElementById('group-manage-modal').classList.remove('active');
            await fetchGroups();
            showError('Группа удалена');
            
            // Очищаем текущий чат
            currentGroupId = null;
            currentChatUser = null;
            document.getElementById('messages-container').innerHTML = `
                <div class="empty-chat">
                    <p>Выберите чат для начала общения</p>
                </div>
            `;
        }
    } catch (e) {
        showError('Ошибка при удалении группы');
    }
}

async function removeGroupMember(groupId, memberId) {
    if (!confirm('Удалить участника из группы?')) return;
    
    try {
        const resp = await authorizedFetch(`${API_BASE_URL}/groups/${groupId}/members/${memberId}`, {
            method: 'DELETE'
        });
        
        if (resp.ok) {
            await showGroupManageModal(groupId);
            await fetchGroups();
            showError('Участник удалён');
        }
    } catch (e) {
        showError('Ошибка при удалении участника');
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
        case 'message': {
            const mapped = {
                ...message,
                timestamp: message.created_at || message.timestamp || new Date().toISOString()
            };
            
            const peerId = mapped.sender_id === currentUser?.id 
                ? mapped.receiver_id 
                : mapped.sender_id;
            
            if (!messages[peerId]) messages[peerId] = [];
            messages[peerId].push(mapped);
            
            if (mapped.sender_id === currentChatUser?.id || mapped.group_id === currentGroupId) {
                addMessageToChat(mapped, 'received');
            } else {
                const sender = users.find(u => u.id === mapped.sender_id);
                if (sender && window.electronAPI) {
                    window.electronAPI.showNotification(
                        'Новое сообщение',
                        `${sender.username}: ${mapped.content.substring(0, 50)}`
                    );
                }
            }
            break;
        }
        
        case 'typing':
            if (message.sender_id === currentChatUser?.id) {
                showTypingIndicator(message.is_typing);
            }
            break;
            
        case 'call_initiated':
            callId = message.call_id;
            callPeerId = message.receiver_id || callPeerId;
            showCallBar('Вызов ' + (currentChatUser ? currentChatUser.username : '') + '...');
            startWebRTCConnection(null);
            break;
            
        case 'call_offer':
            pendingOffer = { call_id: message.call_id, sdp: message.sdp };
            break;
            
        case 'incoming_call':
            handleIncomingCall(message);
            break;
            
        case 'call_accepted':
            if (message.sdp && peerConnection) {
                peerConnection.setRemoteDescription(new RTCSessionDescription(message.sdp))
                    .then(() => {
                        showCallBar('Разговор с ' + (currentChatUser ? currentChatUser.username : ''));
                    })
                    .catch(err => console.error('setRemoteDescription error:', err));
            } else {
                showCallBar('Разговор с ' + (currentChatUser ? currentChatUser.username : ''));
            }
            break;
            
        case 'call_declined':
            showError('Вызов отклонен');
            handleCallEnded();
            break;
            
        case 'call_end':
            showError('Собеседник завершил звонок');
            handleCallEnded();
            break;
            
        case 'ice_candidate':
            handleIceCandidate(message);
            break;
            
        case 'group_invite':
            if (window.electronAPI) {
                window.electronAPI.showNotification(
                    'Приглашение в группу',
                    `${message.inviter} пригласил вас в ${message.group_name}`
                );
            }
            fetchGroups();
            break;
            
        case 'friend_request':
            if (window.electronAPI) {
                window.electronAPI.showNotification(
                    'Запрос в друзья',
                    `${message.from_username} хочет добавить вас в друзья`
                );
            }
            showError(`Новый запрос в друзья от ${message.from_username}`);
            fetchFriendRequests();
            break;
            
        case 'friend_accepted':
            showError(`${message.friend_username} принял ваш запрос!`);
            fetchFriends();
            break;
    }
}

function updateUsersList(usersList) {
    users = usersList;
    const usersListEl = document.getElementById('users-list');
    
    if (!usersListEl) return;
    
    usersListEl.innerHTML = '';
    
    usersList.forEach(user => {
        if (user.id === currentUser?.id) return;
        
        const userEl = document.createElement('div');
        userEl.className = `user-item ${user.status}`;
        userEl.dataset.userId = user.id;
        userEl.innerHTML = `
            <div class="avatar">
                <span class="initial">${user.username.charAt(0).toUpperCase()}</span>
            </div>
            <div class="user-details">
                <span class="username">${escapeHtml(user.username)}</span>
                <span class="status ${user.status || 'offline'}">
                    ${user.status === 'online' ? 'Онлайн' : 'Не в сети'}
                </span>
            </div>
        `;
        userEl.onclick = () => selectUser(user);
        usersListEl.appendChild(userEl);
    });
}

function selectUser(user) {
    if (!user || !user.id) {
        showError('Неверные данные пользователя');
        return;
    }
    
    currentChatUser = user;
    currentGroupId = null;
    
    // Скрываем кнопку управления группой
    const groupManageBtn = document.getElementById('group-manage-btn');
    if (groupManageBtn) {
        groupManageBtn.style.display = 'none';
    }
    
    // Обновляем UI
    document.getElementById('chat-username').textContent = user.username;
    document.getElementById('chat-username-initial').textContent = user.username.charAt(0).toUpperCase();
    document.getElementById('chat-status').textContent = user.status === 'online' ? 'Онлайн' : 'Не в сети';
    document.getElementById('chat-status').className = `status ${user.status || 'offline'}`;
    
    // Активируем кнопку звонка
    const audioCallBtn = document.getElementById('audio-call-btn');
    if (audioCallBtn) audioCallBtn.disabled = user.status !== 'online';
    
    // Активируем ввод
    document.getElementById('message-text').disabled = false;
    document.getElementById('send-btn').disabled = false;
    document.getElementById('message-text').focus();
    
    // Подсветка
    document.querySelectorAll('.user-item').forEach(el => {
        el.classList.toggle('active', el.dataset.userId == user.id);
    });
    document.querySelectorAll('.group-item').forEach(el => {
        el.classList.remove('active');
    });
    
    // Загружаем историю
    loadMessageHistory(user.id, false);
}

async function loadMessageHistory(chatId, isGroup = false) {
    const container = document.getElementById('messages-container');
    if (!container) return;
    
    container.innerHTML = '<div class="loading-messages">Загрузка...</div>';
    
    try {
        const endpoint = isGroup 
            ? `${API_BASE_URL}/groups/${chatId}/messages`
            : `${API_BASE_URL}/messages/${chatId}`;
            
        const resp = await authorizedFetch(endpoint);
        const json = await resp.json();
        const list = json.data || [];
        
        messages[chatId] = list.map(m => ({ 
            ...m, 
            timestamp: m.created_at || m.timestamp 
        }));
    } catch (e) {
        console.warn('Не удалось загрузить историю сообщений');
        messages[chatId] = [];
    }
    
    container.innerHTML = '';
    
    const history = messages[chatId] || [];
    
    if (history.length === 0) {
        container.innerHTML = `
            <div class="empty-chat">
                <svg viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="2">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
                <p>Нет сообщений</p>
                <small>Отправьте первое сообщение</small>
            </div>
        `;
        return;
    }
    
    history.forEach(msg => {
        addMessageToChat(msg, msg.sender_id === currentUser?.id ? 'sent' : 'received');
    });
    
    container.scrollTop = container.scrollHeight;
}

function sendMessage() {
    const input = document.getElementById('message-text');
    if (!input || !input.value.trim() || !currentChatUser) return;
    
    const message = {
        type: 'message',
        receiver_id: currentChatUser.id,
        content: input.value.trim(),
        is_group: currentChatUser.is_group || false,
        group_id: currentGroupId || null,
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

// ==================== ЗВОНКИ ====================
function showCallBar(text) {
    const bar = document.getElementById('call-bar');
    const textEl = document.getElementById('call-bar-text');
    if (bar && textEl) {
        textEl.textContent = text;
        bar.style.display = 'flex';
    }
}

function hideCallBar() {
    const bar = document.getElementById('call-bar');
    if (bar) bar.style.display = 'none';
    const ra = document.getElementById('remote-audio');
    if (ra) {
        ra.srcObject = null;
    }
}

function initiateCall(type) {
    if (!currentChatUser) {
        showError('Выберите пользователя для звонка');
        return;
    }
    
    if (currentChatUser.is_group) {
        showError('Групповые звонки пока не поддерживаются');
        return;
    }
    
    if (currentChatUser.status !== 'online') {
        showError('Пользователь не в сети');
        return;
    }
    
    isCaller = true;
    callPeerId = currentChatUser.id;
    
    if (window.electronAPI) {
        window.electronAPI.sendWebSocketMessage({
            type: 'call_initiate',
            receiver_id: currentChatUser.id,
            call_type: 'audio'
        });
        showCallBar('Вызов ' + currentChatUser.username + '...');
        window.electronAPI.showNotification('Вызов', 'Звонок ' + currentChatUser.username);
    }
}

function handleIncomingCall(data) {
    callId = data.call_id;
    isCaller = false;
    callPeerId = data.initiator_id;
    // Окно входящего звонка показываем только тому, кому звонят (callee)
    if (window.electronAPI) {
        window.electronAPI.openCallWindow({
            call_id: data.call_id,
            call_type: 'audio',
            initiator_id: data.initiator_id,
            initiator_name: data.initiator_name || 'Пользователь'
        });
        window.electronAPI.showNotification(
            'Входящий вызов',
            (data.initiator_name || 'Пользователь') + ' звонит вам'
        );
    }
}

function handleCallResponse(response) {
    if (response.action === 'decline') {
        showError('Вызов отклонен');
        pendingOffer = null;
        cleanupCall();
        hideCallBar();
        return;
    }
    if (response.action === 'accept') {
        if (response.sdp) {
            // Ответ (answer) от callee — устанавливаем у caller
            if (peerConnection) {
                peerConnection.setRemoteDescription(new RTCSessionDescription(response.sdp))
                    .then(() => {
                        showCallBar('Разговор с ' + (currentChatUser ? currentChatUser.username : ''));
                    })
                    .catch(err => console.error('setRemoteDescription error:', err));
            }
        } else if (pendingOffer) {
            // Callee нажал «Принять» в call.html — запускаем WebRTC с сохранённым offer
            callId = pendingOffer.call_id;
            isCaller = false;
            startWebRTCConnection(pendingOffer.sdp);
            pendingOffer = null;
        }
    }
}

function handleCallEnded() {
    showError('Вызов завершен');
    cleanupCall();
    hideCallBar();
}

async function startWebRTCConnection(remoteSdp = null) {
    try {
        cleanupWebRTC();
        
        const constraints = {
            video: false,
            audio: {
                echoCancellation: { ideal: true },
                noiseSuppression: { ideal: true },
                autoGainControl: { ideal: true },
                sampleRate: { ideal: 48000 },
                sampleSize: { ideal: 16 },
                channelCount: { ideal: 2 }
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
                    target_user_id: callPeerId
                });
            }
        };
        
        peerConnection.ontrack = (event) => {
            remoteStream = event.streams[0];
            const remoteAudio = document.getElementById('remote-audio');
            if (remoteAudio) {
                remoteAudio.srcObject = remoteStream;
                remoteAudio.play().catch(function() {});
            }
            showCallBar('Разговор с ' + (currentChatUser ? currentChatUser.username : ''));
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
                    type: 'call_offer',
                    call_id: callId,
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
            showCallBar('Разговор с ' + (currentChatUser ? currentChatUser.username : ''));
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
    const remoteAudio = document.getElementById('remote-audio');
    if (remoteAudio) remoteAudio.srcObject = null;
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
    pendingOffer = null;
    callPeerId = null;
    cleanupWebRTC();
    callId = null;
    isCaller = false;
    hideCallBar();
}

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================
async function authorizedFetch(url, options = {}) {
    const headers = {
        ...options.headers,
        'Authorization': `Bearer ${authToken}`
    };
    
    const response = await fetch(url, {
        ...options,
        headers
    });
    
    if (response.status === 401) {
        showError('Сессия истекла. Пожалуйста, войдите снова.');
        setTimeout(() => {
            window.location.reload();
        }, 2000);
    }
    
    return response;
}

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