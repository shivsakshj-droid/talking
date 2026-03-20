// server.js - Production Ready for Render
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Socket.io configuration for production
const io = socketIo(server, {
    cors: {
        origin: "*", // Render will handle CORS
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true
});

// Serve static files
app.use(express.static(path.join(__dirname)));

// Health check endpoint for Render
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Store rooms and participants
const rooms = new Map();

io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    socket.on('join-room', ({ room }) => {
        if (!room) return;

        // Leave previous rooms
        const previousRooms = Array.from(socket.rooms).filter(r => r !== socket.id);
        previousRooms.forEach(prevRoom => {
            socket.leave(prevRoom);
            if (rooms.has(prevRoom)) {
                rooms.get(prevRoom).delete(socket.id);
                if (rooms.get(prevRoom).size === 0) {
                    rooms.delete(prevRoom);
                }
                socket.to(prevRoom).emit('user-left', { userId: socket.id });
            }
        });

        // Join new room
        socket.join(room);
        
        if (!rooms.has(room)) {
            rooms.set(room, new Set());
        }
        rooms.get(room).add(socket.id);

        console.log(`📡 ${socket.id} joined room: ${room}`);
        console.log(`👥 Room ${room} now has ${rooms.get(room).size} participants`);

        // Send existing participants to the new user
        const existingUsers = Array.from(rooms.get(room)).filter(id => id !== socket.id);
        socket.emit('existing-users', { users: existingUsers });

        // Notify others about new user
        socket.to(room).emit('user-joined', { userId: socket.id });
    });

    // Handle WebRTC signaling
    socket.on('offer', ({ offer, to }) => {
        console.log(`📤 Offer from ${socket.id} to ${to}`);
        socket.to(to).emit('offer', { offer, from: socket.id });
    });

    socket.on('answer', ({ answer, to }) => {
        console.log(`📥 Answer from ${socket.id} to ${to}`);
        socket.to(to).emit('answer', { answer, from: socket.id });
    });

    socket.on('ice-candidate', ({ candidate, to }) => {
        console.log(`❄️ ICE from ${socket.id} to ${to}`);
        socket.to(to).emit('ice-candidate', { candidate, from: socket.id });
    });

    socket.on('leave-room', ({ room }) => {
        if (room && rooms.has(room)) {
            rooms.get(room).delete(socket.id);
            socket.leave(room);
            socket.to(room).emit('user-left', { userId: socket.id });
            console.log(`👋 ${socket.id} left room: ${room}`);

            if (rooms.get(room).size === 0) {
                rooms.delete(room);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`❌ Client disconnected: ${socket.id}`);
        
        for (const [roomId, participants] of rooms.entries()) {
            if (participants.has(socket.id)) {
                participants.delete(socket.id);
                socket.to(roomId).emit('user-left', { userId: socket.id });
                if (participants.size === 0) {
                    rooms.delete(roomId);
                }
            }
        }
    });
});

// Get port from environment variable (Render sets this automatically)
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`
    ════════════════════════════════════════
    🎙️  WALKIE-TALKIE SERVER - DEPLOYED
    ════════════════════════════════════════
    📡 Server running on port: ${PORT}
    🌍 Environment: ${process.env.NODE_ENV || 'development'}
    ════════════════════════════════════════
    `);
});