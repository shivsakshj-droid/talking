const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    allowUpgrades: true,
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(express.static(path.join(__dirname)));
app.use(express.json());

// Store users and their data
const users = new Map(); // userId -> { socketId, name, avatar, status, contacts }
const rooms = new Map();
const callRequests = new Map(); // callId -> { from, to, roomId, timestamp }

// User profiles storage (in memory for demo - use database in production)
const userProfiles = new Map();

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API: Register user profile
app.post('/api/register', (req, res) => {
    const { userId, name, avatar } = req.body;
    if (!userId || !name) {
        return res.status(400).json({ error: 'User ID and name required' });
    }
    
    userProfiles.set(userId, {
        userId,
        name,
        avatar: avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=667eea&color=fff`,
        contacts: [],
        createdAt: new Date()
    });
    
    res.json({ success: true, profile: userProfiles.get(userId) });
});

// API: Get user profile
app.get('/api/user/:userId', (req, res) => {
    const profile = userProfiles.get(req.params.userId);
    if (profile) {
        res.json(profile);
    } else {
        res.status(404).json({ error: 'User not found' });
    }
});

// API: Add contact
app.post('/api/contacts/add', (req, res) => {
    const { userId, contactId, contactName } = req.body;
    const user = userProfiles.get(userId);
    const contact = userProfiles.get(contactId);
    
    if (!user || !contact) {
        return res.status(404).json({ error: 'User or contact not found' });
    }
    
    if (!user.contacts.some(c => c.userId === contactId)) {
        user.contacts.push({
            userId: contactId,
            name: contactName || contact.name,
            avatar: contact.avatar
        });
        res.json({ success: true, contacts: user.contacts });
    } else {
        res.json({ success: false, message: 'Contact already exists' });
    }
});

// API: Get contacts
app.get('/api/contacts/:userId', (req, res) => {
    const user = userProfiles.get(req.params.userId);
    if (user) {
        res.json({ contacts: user.contacts });
    } else {
        res.status(404).json({ error: 'User not found' });
    }
});

io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);
    
    // Register user with their profile
    socket.on('register-user', ({ userId, name, avatar }) => {
        socket.userId = userId;
        socket.userName = name;
        
        users.set(userId, {
            socketId: socket.id,
            name: name,
            avatar: avatar,
            status: 'online',
            lastSeen: new Date()
        });
        
        // Store profile if not exists
        if (!userProfiles.has(userId)) {
            userProfiles.set(userId, {
                userId,
                name,
                avatar: avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=667eea&color=fff`,
                contacts: [],
                createdAt: new Date()
            });
        }
        
        socket.join(`user:${userId}`);
        console.log(`✅ User registered: ${name} (${userId})`);
        
        // Broadcast user online status
        socket.broadcast.emit('user-status-changed', {
            userId,
            name,
            status: 'online'
        });
        
        socket.emit('registration-success', {
            userId,
            name,
            profile: userProfiles.get(userId)
        });
    });
    
    // Initiate call
    socket.on('initiate-call', ({ fromUserId, toUserId, fromName, roomId }) => {
        const targetUser = users.get(toUserId);
        
        if (targetUser && targetUser.status === 'online') {
            const callId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            
            callRequests.set(callId, {
                from: fromUserId,
                to: toUserId,
                roomId,
                timestamp: Date.now(),
                status: 'ringing'
            });
            
            // Send call notification to target
            io.to(`user:${toUserId}`).emit('incoming-call', {
                callId,
                from: fromUserId,
                fromName: fromName,
                roomId,
                timestamp: Date.now()
            });
            
            socket.emit('call-initiated', { callId, status: 'ringing' });
            console.log(`📞 Call from ${fromName} to ${toUserId}`);
        } else {
            socket.emit('call-failed', { 
                reason: 'User offline',
                toUserId
            });
        }
    });
    
    // Accept call
    socket.on('accept-call', ({ callId, roomId, fromUserId, toUserId }) => {
        const call = callRequests.get(callId);
        if (call) {
            call.status = 'connected';
            callRequests.delete(callId);
            
            // Notify caller that call was accepted
            io.to(`user:${fromUserId}`).emit('call-accepted', {
                callId,
                roomId,
                toUserId,
                toName: users.get(toUserId)?.name
            });
            
            // Notify callee that they joined
            socket.emit('call-connected', {
                callId,
                roomId,
                fromUserId,
                fromName: users.get(fromUserId)?.name
            });
            
            console.log(`✅ Call accepted: ${fromUserId} <-> ${toUserId}`);
        }
    });
    
    // Reject call
    socket.on('reject-call', ({ callId, fromUserId, toUserId }) => {
        const call = callRequests.get(callId);
        if (call) {
            callRequests.delete(callId);
            io.to(`user:${fromUserId}`).emit('call-rejected', {
                callId,
                toUserId,
                reason: 'rejected'
            });
            console.log(`❌ Call rejected: ${fromUserId} -> ${toUserId}`);
        }
    });
    
    // End call
    socket.on('end-call', ({ roomId, fromUserId, toUserId }) => {
        io.to(`user:${toUserId}`).emit('call-ended', {
            roomId,
            fromUserId
        });
        socket.emit('call-ended', { roomId });
        console.log(`🔴 Call ended: ${fromUserId} <-> ${toUserId}`);
    });
    
    // WebRTC Signaling
    socket.on('join-room', ({ room, userId }) => {
        if (!room) return;
        
        socket.join(room);
        
        if (!rooms.has(room)) {
            rooms.set(room, new Set());
        }
        rooms.get(room).add(socket.id);
        
        const existingUsers = Array.from(rooms.get(room))
            .filter(id => id !== socket.id)
            .map(id => {
                const user = Array.from(users.entries()).find(([_, u]) => u.socketId === id);
                return user ? { userId: user[0], name: user[1].name } : null;
            })
            .filter(u => u);
        
        socket.emit('existing-users', { users: existingUsers });
        socket.to(room).emit('user-joined', { userId });
    });
    
    socket.on('offer', ({ offer, to }) => {
        const targetUser = Array.from(users.entries()).find(([_, u]) => u.userId === to);
        if (targetUser) {
            io.to(targetUser[1].socketId).emit('offer', { offer, from: socket.userId });
        }
    });
    
    socket.on('answer', ({ answer, to }) => {
        const targetUser = Array.from(users.entries()).find(([_, u]) => u.userId === to);
        if (targetUser) {
            io.to(targetUser[1].socketId).emit('answer', { answer, from: socket.userId });
        }
    });
    
    socket.on('ice-candidate', ({ candidate, to }) => {
        const targetUser = Array.from(users.entries()).find(([_, u]) => u.userId === to);
        if (targetUser) {
            io.to(targetUser[1].socketId).emit('ice-candidate', { candidate, from: socket.userId });
        }
    });
    
    socket.on('leave-room', ({ room }) => {
        if (room && rooms.has(room)) {
            rooms.get(room).delete(socket.id);
            socket.leave(room);
            socket.to(room).emit('user-left', { userId: socket.userId });
        }
    });
    
    socket.on('disconnect', () => {
        if (socket.userId) {
            users.delete(socket.userId);
            socket.broadcast.emit('user-status-changed', {
                userId: socket.userId,
                status: 'offline'
            });
            console.log(`❌ User disconnected: ${socket.userId}`);
        }
        
        for (const [roomId, participants] of rooms.entries()) {
            if (participants.has(socket.id)) {
                participants.delete(socket.id);
                socket.to(roomId).emit('user-left', { userId: socket.userId });
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
    ════════════════════════════════════════
    📱 PROFESSIONAL WALKIE-TALKIE SERVER
    ════════════════════════════════════════
    📡 Server running on port: ${PORT}
    👥 Multi-user support with contacts
    📞 Call notification system active
    ════════════════════════════════════════
    `);
});
