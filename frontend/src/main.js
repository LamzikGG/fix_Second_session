const { app, BrowserWindow, ipcMain, screen, Notification } = require('electron');
const path = require('path');

let mainWindow;
let callWindow;
let memoryCheckInterval;
const MAX_MEMORY_MB = 400;

function createWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        minWidth: 800,
        minHeight: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: true,
            partition: 'persist:chatapp',
            backgroundThrottling: false
        },
        backgroundColor: '#1a1a1a',
        frame: false,
        titleBarStyle: 'hidden',
        trafficLightPosition: { x: 10, y: 10 },
        show: false
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));
    
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });
    
    if (process.env.NODE_ENV === 'development') {
        mainWindow.webContents.openDevTools();
    }

    setupIpcHandlers();
    startMemoryMonitoring();
    
    mainWindow.on('closed', () => {
        stopMemoryMonitoring();
        mainWindow = null;
        if (callWindow) {
            callWindow.destroy();
            callWindow = null;
        }
    });
}

function setupIpcHandlers() {
    // Управление окном
    ipcMain.on('minimize-window', () => {
        if (mainWindow) mainWindow.minimize();
    });

    ipcMain.on('maximize-window', () => {
        if (mainWindow) {
            if (mainWindow.isMaximized()) {
                mainWindow.unmaximize();
            } else {
                mainWindow.maximize();
            }
        }
    });

    ipcMain.on('close-window', () => {
        if (mainWindow) mainWindow.close();
    });

    // WebSocket управление
    let ws = null;
    
    ipcMain.on('connect-websocket', (event, userId) => {
        console.log('Connecting WebSocket for user:', userId);
        
        // Имитация подключения (замените на реальный WebSocket)
        setTimeout(() => {
            event.reply('websocket-connected');
            
            // Отправляем список пользователей
            event.reply('websocket-message', {
                type: 'users_list',
                users: [
                    { id: 2, username: 'Анна', status: 'online' },
                    { id: 3, username: 'Иван', status: 'offline' },
                    { id: 4, username: 'Мария', status: 'online' },
                    { id: 5, username: 'Петр', status: 'online' }
                ]
            });
        }, 1000);
    });

    ipcMain.on('websocket-message', (event, message) => {
        console.log('Sending WebSocket message:', message);
        
        // Имитация ответа на сообщение
        if (message.type === 'message') {
            setTimeout(() => {
                event.reply('websocket-message', {
                    type: 'message',
                    sender_id: message.receiver_id,
                    content: 'Это автоматический ответ',
                    timestamp: new Date().toISOString()
                });
            }, 500);
        }
    });

    // Уведомления
    ipcMain.on('show-notification', (event, title, body) => {
        if (Notification.isSupported()) {
            new Notification({ title, body }).show();
        }
    });

    // Окно вызова
    ipcMain.on('open-call-window', (event, callData) => {
        if (callWindow) {
            callWindow.focus();
            return;
        }
        
        callWindow = new BrowserWindow({
            width: 400,
            height: 500,
            parent: mainWindow,
            modal: true,
            frame: false,
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                nodeIntegration: false,
                contextIsolation: true
            }
        });
        
        callWindow.loadFile(path.join(__dirname, 'call.html'));
        
        callWindow.webContents.on('did-finish-load', () => {
            callWindow.webContents.send('call-data', callData);
        });
        
        callWindow.on('closed', () => {
            callWindow = null;
        });
    });

    ipcMain.on('call-response', (event, response) => {
        console.log('Call response:', response);
        if (mainWindow) {
            mainWindow.webContents.send('call-response', response);
        }
    });
}

function startMemoryMonitoring() {
    stopMemoryMonitoring();
    
    memoryCheckInterval = setInterval(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        
        const memoryInfo = process.memoryUsage();
        const heapMB = memoryInfo.heapUsed / 1024 / 1024;
        
        if (heapMB > MAX_MEMORY_MB) {
            console.log(`Memory usage: ${heapMB.toFixed(2)}MB`);
            
            if (typeof global.gc === 'function') {
                global.gc();
            }
        }
    }, 30000);
}

function stopMemoryMonitoring() {
    if (memoryCheckInterval) {
        clearInterval(memoryCheckInterval);
        memoryCheckInterval = null;
    }
}

app.whenReady().then(() => {
    createWindow();
    
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});