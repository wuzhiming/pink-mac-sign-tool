const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const { processBinaries, createZip, unzip } = require('./sign-logic');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'output');

// Ensure directories exist
fs.ensureDirSync(UPLOADS_DIR);
fs.ensureDirSync(OUTPUT_DIR);

app.use(express.static('public'));
app.use('/download', express.static(OUTPUT_DIR));

// Multer configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const sessionId = req.body.sessionId || uuidv4();
        const uploadPath = path.join(UPLOADS_DIR, sessionId);
        fs.ensureDirSync(uploadPath);
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});

const upload = multer({ storage });

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    socket.on('start-processing', async (data) => {
        const { sessionId, fileName, options } = data;
        const sessionPath = path.join(UPLOADS_DIR, sessionId);
        const filePath = path.join(sessionPath, fileName);
        const outputZipName = `${fileName}_processed_${Date.now()}.zip`;
        const outputZipPath = path.join(OUTPUT_DIR, outputZipName);

        const logger = (message) => {
            socket.emit('log', { sessionId, message });
        };

        try {
            logger(`Starting process for ${fileName}...`);
            
            let workingDir = sessionPath;
            
            // If it's a zip file, extract it
            if (path.extname(fileName).toLowerCase() === '.zip') {
                logger('Extracting ZIP file...');
                const extractDir = path.join(sessionPath, 'extracted');
                await fs.ensureDir(extractDir);
                unzip(filePath, extractDir);
                workingDir = extractDir;
            }

            // Run signing and notarization
            await processBinaries(workingDir, options, logger);

            // Package the result
            logger('Packaging final results...');
            await createZip(workingDir, outputZipPath);

            logger('Process completed successfully!');
            socket.emit('completed', { 
                sessionId, 
                downloadUrl: `/download/${outputZipName}` 
            });

        } catch (error) {
            logger(`[CRITICAL ERROR] ${error.message}`);
            socket.emit('error', { sessionId, message: error.message });
        } finally {
            // Clean up uploads after some time or immediately
            // For now, we keep them for debugging if needed, or delete immediately:
            // await fs.remove(sessionPath);
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    res.json({ 
        sessionId: path.basename(path.dirname(req.file.path)), 
        fileName: req.file.filename 
    });
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
