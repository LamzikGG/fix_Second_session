const { contextBridge, ipcRenderer } = require('electron');

console.log('Preload script loaded');

contextBridge.exposeInMainWorld('electronAPI', {
    // Управление окном
    minimizeWindow: () => {
        console.log('IPC: minimize-window');
        ipcRenderer.send('minimize-window');
    },
    
    maximizeWindow: () => {
        console.log('IPC: maximize-window');
        ipcRenderer.send('maximize-window');
    },
    
    closeWindow: () => {
        console.log('IPC: close-window');
        ipcRenderer.send('close-window');
    },
    
    // Хранилище
    saveToStorage: (key, value) => {
        try {
            localStorage.setItem(key, value);
            return true;
        } catch (e) {
            console.error('Storage error:', e);
            return false;
        }
    },
    
    getFromStorage: (key) => {
        try {
            return localStorage.getItem(key);
        } catch (e) {
            console.error('Storage error:', e);
            return null;
        }
    },
    
    // WebSocket
    connectWebSocket: (userId) => {
        console.log('IPC: connect-websocket', userId);
        ipcRenderer.send('connect-websocket', userId);
    },
    
    sendWebSocketMessage: (message) => {
        console.log('IPC: websocket-message', message);
        ipcRenderer.send('websocket-message', message);
    },
    
    // События WebSocket
    onWebSocketConnected: (callback) => {
        ipcRenderer.on('websocket-connected', () => {
            console.log('Event: websocket-connected');
            callback();
        });
    },
    
    onWebSocketMessage: (callback) => {
        ipcRenderer.on('websocket-message', (event, message) => {
            console.log('Event: websocket-message', message);
            callback(message);
        });
    },
    
    onWebSocketDisconnected: (callback) => {
        ipcRenderer.on('websocket-disconnected', () => {
            console.log('Event: websocket-disconnected');
            callback();
        });
    },
    
    // Уведомления
    showNotification: (title, body) => {
        ipcRenderer.send('show-notification', title, body);
    },
    
    // Вызовы
    openCallWindow: (callData) => {
        ipcRenderer.send('open-call-window', callData);
    },
    
    onCallResponse: (callback) => {
        ipcRenderer.on('call-response', (event, response) => {
            console.log('Event: call-response', response);
            callback(response);
        });
    }
});