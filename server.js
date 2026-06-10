require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));
app.use(express.json());
app.use(cookieParser());

// ---------- MongoDB Models ----------
const UserSchema = new mongoose.Schema({
    name: String,
    phone: { type: String, unique: true },
    otp: String,
    otpExpiry: Date
});
const User = mongoose.model('User', UserSchema);

const FileSchema = new mongoose.Schema({
    fileId: { type: String, unique: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    name: String,
    content: String,
    sharedWith: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
});
const File = mongoose.model('File', FileSchema);

const ChatSchema = new mongoose.Schema({
    fileId: String,
    userId: String,
    username: String,
    message: String,
    timestamp: { type: Date, default: Date.now }
});
const Chat = mongoose.model('Chat', ChatSchema);

// ---------- MongoDB Connection ----------
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.log('⚠️ MongoDB connection error:', err));

// ---------- Root Route ----------
app.get('/', (req, res) => {
    const token = req.cookies.token;
    if (token) {
        try {
            jwt.verify(token, process.env.JWT_SECRET);
            return res.sendFile(__dirname + '/public/dashboard.html');
        } catch (err) {
            return res.sendFile(__dirname + '/public/login.html');
        }
    } else {
        res.sendFile(__dirname + '/public/login.html');
    }
});

// ---------- Auth Routes (OTP fixed to 123456) ----------
app.post('/api/send-otp', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    const otp = '123456';   // Fixed OTP for demo
    const expiry = new Date(Date.now() + 5 * 60 * 1000);
    await User.findOneAndUpdate(
        { phone },
        { otp, otpExpiry: expiry },
        { upsert: true, new: true }
    );
    console.log(`OTP for ${phone}: ${otp}`);
    res.json({ success: true, message: 'OTP sent (use 123456)' });
});

app.post('/api/verify-otp', async (req, res) => {
    const { phone, otp, name } = req.body;
    const user = await User.findOne({ phone });
    if (!user || user.otp !== otp || user.otpExpiry < new Date()) {
        return res.status(401).json({ error: 'Invalid or expired OTP' });
    }
    if (name) user.name = name;
    user.otp = null;
    user.otpExpiry = null;
    await user.save();
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET);
    res.cookie('token', token, { httpOnly: true });
    res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ success: true });
});

// ---------- Auth Middleware ----------
const auth = (req, res, next) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

// ---------- File Management (owner + shared) ----------
app.get('/api/files', auth, async (req, res) => {
    const files = await File.find({
        $or: [{ owner: req.userId }, { sharedWith: req.userId }]
    });
    res.json(files);
});

app.post('/api/files', auth, async (req, res) => {
    const { name, content } = req.body;
    const fileId = uuidv4();
    const file = new File({ fileId, owner: req.userId, name, content: content || '' });
    await file.save();
    res.json(file);
});

app.delete('/api/files/:fileId', auth, async (req, res) => {
    const file = await File.findOne({ fileId: req.params.fileId, owner: req.userId });
    if (!file) return res.status(404).json({ error: 'File not found' });
    await file.deleteOne();
    res.json({ success: true });
});

app.get('/api/files/:fileId', auth, async (req, res) => {
    const file = await File.findOne({
        fileId: req.params.fileId,
        $or: [{ owner: req.userId }, { sharedWith: req.userId }]
    });
    if (!file) return res.status(404).json({ error: 'Not found' });
    res.json(file);
});

app.put('/api/files/:fileId', auth, async (req, res) => {
    const file = await File.findOne({ fileId: req.params.fileId, owner: req.userId });
    if (!file) return res.status(403).json({ error: 'Only owner can update' });
    file.content = req.body.content;
    await file.save();
    io.to(file.fileId).emit('fileUpdate', { content: file.content });
    res.json(file);
});

// ---------- Share file with another user by phone ----------
app.post('/api/files/:fileId/invite', auth, async (req, res) => {
    const { phone } = req.body;
    const file = await File.findOne({ fileId: req.params.fileId, owner: req.userId });
    if (!file) return res.status(404).json({ error: 'File not found or you are not the owner' });
    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ error: 'User not found with this phone number' });
    if (!file.sharedWith.includes(user._id)) {
        file.sharedWith.push(user._id);
        await file.save();
    }
    res.json({ success: true });
});

// ---------- Payment Demo ----------
app.post('/api/payment', (req, res) => {
    const { plan, amount } = req.body;
    console.log(`Payment request: ${plan} - ₹${amount}`);
    res.json({ success: true, message: `Payment successful for ${plan} plan (Demo)` });
});

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
    console.log('User connected');

    socket.on('joinFile', async (fileId) => {
        socket.join(fileId);
        const file = await File.findOne({ fileId });
        if (file) socket.emit('loadContent', file.content);
    });

    socket.on('codeChange', async ({ fileId, content }) => {
        socket.to(fileId).emit('codeUpdate', content);
        await File.findOneAndUpdate({ fileId }, { content });
    });

    socket.on('sendMessage', async ({ fileId, message, username }) => {
        const newMsg = new Chat({ fileId, userId: socket.userId, username, message });
        await newMsg.save();
        io.to(fileId).emit('receiveMessage', { username, message, timestamp: newMsg.timestamp });
    });

    socket.on('getChatHistory', async (fileId) => {
        const history = await Chat.find({ fileId }).sort({ timestamp: 1 }).limit(50);
        socket.emit('chatHistory', history);
    });

    // ---------- Interactive Code Execution (C, C++, Java, Python, JS) ----------
    let currentProcess = null;

    socket.on('interactiveRun', async ({ code, language, fileId }) => {
        const timestamp = Date.now();
        let tempFile, compileCmd, cleanupFiles = [];
        const __dir = __dirname;

        const cleanup = () => {
            if (currentProcess) currentProcess.kill();
            cleanupFiles.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
            currentProcess = null;
        };

        const runWithStream = (command, args) => {
            const proc = spawn(command, args);
            currentProcess = proc;
            proc.stdout.on('data', (data) => io.to(fileId).emit('interactiveOutput', { type: 'stdout', data: data.toString() }));
            proc.stderr.on('data', (data) => io.to(fileId).emit('interactiveOutput', { type: 'stderr', data: data.toString() }));
            proc.on('close', (code) => {
                io.to(fileId).emit('interactiveOutput', { type: 'exit', data: `Process exited with code ${code}` });
                cleanup();
            });
            socket.on('interactiveInput', (input) => {
                if (proc && !proc.killed) proc.stdin.write(input + '\n');
            });
            socket.on('interactiveKill', () => {
                if (proc) proc.kill();
            });
        };

        try {
            switch (language) {
                case 'javascript':
                    tempFile = path.join(__dir, `temp_${timestamp}.js`);
                    fs.writeFileSync(tempFile, code);
                    runWithStream('node', [tempFile]);
                    cleanupFiles.push(tempFile);
                    break;
                case 'python':
                    tempFile = path.join(__dir, `temp_${timestamp}.py`);
                    fs.writeFileSync(tempFile, code);
                    runWithStream('python', [tempFile]);
                    cleanupFiles.push(tempFile);
                    break;
                case 'cpp':
                    tempFile = path.join(__dir, `temp_${timestamp}.cpp`);
                    const outCpp = path.join(__dir, `temp_${timestamp}.exe`);
                    fs.writeFileSync(tempFile, code);
                    compileCmd = `g++ "${tempFile}" -o "${outCpp}"`;
                    exec(compileCmd, { timeout: 10000 }, (err) => {
                        if (err) {
                            io.to(fileId).emit('interactiveOutput', { type: 'stderr', data: 'Compilation error' });
                            cleanup();
                            return;
                        }
                        runWithStream(outCpp, []);
                        cleanupFiles.push(tempFile, outCpp);
                    });
                    break;
                case 'c':
                    tempFile = path.join(__dir, `temp_${timestamp}.c`);
                    const outC = path.join(__dir, `temp_${timestamp}.exe`);
                    fs.writeFileSync(tempFile, code);
                    compileCmd = `gcc "${tempFile}" -o "${outC}"`;
                    exec(compileCmd, { timeout: 10000 }, (err) => {
                        if (err) {
                            io.to(fileId).emit('interactiveOutput', { type: 'stderr', data: 'Compilation error' });
                            cleanup();
                            return;
                        }
                        runWithStream(outC, []);
                        cleanupFiles.push(tempFile, outC);
                    });
                    break;
                case 'java':
                    let className = 'Main';
                    const classMatch = code.match(/public\s+class\s+(\w+)/);
                    if (classMatch) className = classMatch[1];
                    tempFile = path.join(__dir, `${className}.java`);
                    fs.writeFileSync(tempFile, code);
                    compileCmd = `javac "${tempFile}"`;
                    exec(compileCmd, { timeout: 10000 }, (err) => {
                        if (err) {
                            io.to(fileId).emit('interactiveOutput', { type: 'stderr', data: 'Compilation error' });
                            cleanup();
                            return;
                        }
                        runWithStream('java', ['-cp', __dir, className]);
                        cleanupFiles.push(tempFile, path.join(__dir, `${className}.class`));
                    });
                    break;
                default:
                    io.to(fileId).emit('interactiveOutput', { type: 'stderr', data: 'Language not supported' });
            }
        } catch (err) {
            io.to(fileId).emit('interactiveOutput', { type: 'stderr', data: err.message });
            cleanup();
        }
    });
});

// ---------- Start Server ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));