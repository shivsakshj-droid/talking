const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Socket.io with improved configuration for stable connections
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    allowUpgrades: true,
    pingTimeout: 60000,        // 60 seconds ping timeout
    pingInterval: 25000,       // Ping every 25 seconds
    upgradeTimeout: 30000,
    cookie: false,
    allowEIO3: true
});

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        connections: io.engine.clientsCount,
        rooms: rooms.size
    });
});

// Store rooms and participants
const rooms = new Map();
const userRoomMap = new Map(); // Track which room each socket is in

io.on('connection', (socket) => {
    console.log(`✅ Client connected: ${socket.id}`);
    
    // Send connection confirmation
    socket.emit('connection-confirmed', { socketId: socket.id });
    
    // Handle joining a room
    socket.on('join-room', ({ room }) => {
        if (!room) {
            socket.emit('error', { message: 'Room ID required' });
            return;
        }
        
        // Leave previous room if exists
        if (userRoomMap.has(socket.id)) {
            const oldRoom = userRoomMap.get(socket.id);
            if (rooms.has(oldRoom)) {
                rooms.get(oldRoom).delete(socket.id);
                socket.to(oldRoom).emit('user-left', { userId: socket.id });
                
                if (rooms.get(oldRoom).size === 0) {
                    rooms.delete(oldRoom);
                }
            }
            socket.leave(oldRoom);
        }
        
        // Join new room
        socket.join(room);
        userRoomMap.set(socket.id, room);
        
        if (!rooms.has(room)) {
            rooms.set(room, new Set());
        }
        rooms.get(room).add(socket.id);
        
        console.log(`📡 ${socket.id} joined room: ${room} (Total: ${rooms.get(room).size})`);
        
        // Send existing participants to the new user
        const existingUsers = Array.from(rooms.get(room)).filter(id => id !== socket.id);
        socket.emit('existing-users', { users: existingUsers });
        
        // Notify others about new user
        if (existingUsers.length > 0) {
            socket.to(room).emit('user-joined', { userId: socket.id });
        }
        
        // Send room info
        socket.emit('room-joined', { 
            room, 
            participantCount: rooms.get(room).size 
        });
    });
    
    // Handle WebRTC signaling
    socket.on('offer', ({ offer, to }) => {
        if (to && socket.to(to)) {
            console.log(`📤 Offer from ${socket.id} to ${to}`);
            socket.to(to).emit('offer', { offer, from: socket.id });
        }
    });
    
    socket.on('answer', ({ answer, to }) => {
        if (to && socket.to(to)) {
            console.log(`📥 Answer from ${socket.id} to ${to}`);
            socket.to(to).emit('answer', { answer, from: socket.id });
        }
    });
    
    socket.on('ice-candidate', ({ candidate, to }) => {
        if (to && socket.to(to)) {
            console.log(`❄️ ICE from ${socket.id} to ${to}`);
            socket.to(to).emit('ice-candidate', { candidate, from: socket.id });
        }
    });
    
    // Handle leaving room
    socket.on('leave-room', () => {
        if (userRoomMap.has(socket.id)) {
            const room = userRoomMap.get(socket.id);
            if (rooms.has(room)) {
                rooms.get(room).delete(socket.id);
                socket.to(room).emit('user-left', { userId: socket.id });
                console.log(`👋 ${socket.id} left room: ${room}`);
                
                if (rooms.get(room).size === 0) {
                    rooms.delete(room);
                    console.log(`🗑️ Room ${room} deleted (empty)`);
                }
            }
            socket.leave(room);
            userRoomMap.delete(socket.id);
            socket.emit('left-room', { success: true });
        }
    });
    
    // Handle disconnection
    socket.on('disconnect', (reason) => {
        console.log(`❌ Client disconnected: ${socket.id} - Reason: ${reason}`);
        
        if (userRoomMap.has(socket.id)) {
            const room = userRoomMap.get(socket.id);
            if (rooms.has(room)) {
                rooms.get(room).delete(socket.id);
                socket.to(room).emit('user-left', { userId: socket.id });
                console.log(`👋 ${socket.id} removed from room: ${room}`);
                
                if (rooms.get(room).size === 0) {
                    rooms.delete(room);
                    console.log(`🗑️ Room ${room} deleted (empty)`);
                }
            }
            userRoomMap.delete(socket.id);
        }
    });
    
    // Handle reconnection
    socket.on('reconnect-attempt', () => {
        console.log(`🔄 Reconnection attempt from ${socket.id}`);
    });
});

// Keep alive with ping
setInterval(() => {
    io.fetchSockets().then(sockets => {
        console.log(`💓 Heartbeat: ${sockets.length} active connections, ${rooms.size} active rooms`);
    });
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
    ════════════════════════════════════════
    🎙️  WALKIE-TALKIE SERVER - STABLE VERSION
    ════════════════════════════════════════
    📡 Server running on port: ${PORT}
    🌍 Environment: ${process.env.NODE_ENV || 'development'}
    🔗 WebSocket ready with improved stability
    ════════════════════════════════════════
    `);
});
