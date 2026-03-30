const socket = io();

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const fileInfo = document.getElementById('file-info');
const fileNameDisplay = document.getElementById('file-name');
const removeFileBtn = document.getElementById('remove-file');
const signCheckbox = document.getElementById('sign-checkbox');
const notarizeCheckbox = document.getElementById('notarize-checkbox');
const addExecCheckbox = document.getElementById('add-exec-checkbox');
const startBtn = document.getElementById('start-btn');
const progressSection = document.getElementById('progress-section');
const progressBar = document.getElementById('progress-bar');
const logConsole = document.getElementById('log-console');
const downloadContainer = document.getElementById('download-container');
const downloadLink = document.getElementById('download-link');

let selectedFile = null;
let currentSessionId = null;

// Handle checkbox logic: Notarize implies Sign
notarizeCheckbox.addEventListener('change', () => {
    if (notarizeCheckbox.checked) {
        signCheckbox.checked = true;
    }
});

signCheckbox.addEventListener('change', () => {
    if (!signCheckbox.checked) {
        notarizeCheckbox.checked = false;
    }
});

// Drop zone interactions
dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) {
        handleFileSelect(e.dataTransfer.files[0]);
    }
});

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        handleFileSelect(e.target.files[0]);
    }
});

function handleFileSelect(file) {
    selectedFile = file;
    fileNameDisplay.textContent = file.name;
    fileInfo.classList.remove('hidden');
    dropZone.classList.add('hidden');
    startBtn.disabled = false;
}

removeFileBtn.addEventListener('click', () => {
    selectedFile = null;
    fileInput.value = '';
    fileInfo.classList.add('hidden');
    dropZone.classList.remove('hidden');
    startBtn.disabled = true;
    resetProgress();
});

function resetProgress() {
    progressSection.classList.add('hidden');
    progressBar.style.width = '0%';
    logConsole.innerHTML = '<div class="log-line system">等待处理开始...</div>';
    downloadContainer.classList.add('hidden');
}

function addLog(message, type = 'normal') {
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logConsole.appendChild(line);
    logConsole.scrollTop = logConsole.scrollHeight;
}

// Start processing
startBtn.addEventListener('click', async () => {
    if (!selectedFile) return;

    startBtn.disabled = true;
    progressSection.classList.remove('hidden');
    addLog('正在上传文件...', 'system');
    
    const formData = new FormData();
    formData.append('file', selectedFile);

    try {
        const response = await fetch('/upload', {
            method: 'POST',
            body: formData
        });

        const result = await response.json();
        if (result.error) throw new Error(result.error);

        currentSessionId = result.sessionId;
        addLog('文件上传成功，正在准备处理...', 'system');
        
        socket.emit('start-processing', {
            sessionId: result.sessionId,
            fileName: result.fileName,
            options: {
                sign: signCheckbox.checked,
                notarize: notarizeCheckbox.checked,
                addExecPermission: addExecCheckbox.checked
            }
        });

    } catch (error) {
        addLog(`上传失败: ${error.message}`, 'error');
        startBtn.disabled = false;
    }
});

// Socket.io events
socket.on('log', (data) => {
    if (data.sessionId === currentSessionId) {
        addLog(data.message);
        
        // Simple progress simulation based on keywords
        if (data.message.includes('Scanning')) progressBar.style.width = '10%';
        if (data.message.includes('Sign')) progressBar.style.width = '30%';
        if (data.message.includes('Submitting')) progressBar.style.width = '60%';
        if (data.message.includes('Waiting')) progressBar.style.width = '80%';
    }
});

socket.on('completed', (data) => {
    if (data.sessionId === currentSessionId) {
        progressBar.style.width = '100%';
        addLog('任务全部完成！', 'system');
        downloadLink.href = data.downloadUrl;
        downloadContainer.classList.remove('hidden');
        startBtn.disabled = false;
    }
});

socket.on('error', (data) => {
    if (data.sessionId === currentSessionId) {
        addLog(`处理出错: ${data.message}`, 'error');
        startBtn.disabled = false;
    }
});
