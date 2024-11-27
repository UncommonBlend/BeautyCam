const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const detectedObjectsList = document.getElementById('detectedObjects');
const switchCameraButton = document.getElementById('switchCamera');
const recordingTimerDisplay = document.getElementById('recordingTimer');
const recordButton = document.getElementById('recordButton');

let model = null;
let detectionInterval = null;
let uniqueDetections = new Map();
let currentStream = null;
let facingMode = 'user';
let mediaRecorder;
let recordedChunks = [];
let isRecording = false;
let recordingStartTime;
let recordingTimer;
let gl;
let beautyProgram;
let beautyEnabled = false;
let beautyStrength = 0.5;

const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

async function loadModel() {
    try {
        model = await cocoSsd.load();
        startDetection();
    } catch (error) {
        showError('Failed to load object detection model: ' + error.message);
    }
}

function setupBeautyFilter() {
    const glCanvas = document.createElement('canvas');
    glCanvas.width = video.videoWidth;
    glCanvas.height = video.videoHeight;
    gl = glCanvas.getContext('webgl');

    if (!gl) {
        console.error('WebGL not supported');
        return;
    }

    const vertexShader = createShader(gl, gl.VERTEX_SHADER, 
        document.getElementById('vertexShader').text);
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, 
        document.getElementById('fragmentShader').text);
    beautyProgram = createProgram(gl, vertexShader, fragmentShader);

    const positions = new Float32Array([
        -1, -1, 1, -1, -1, 1,
        -1, 1, 1, -1, 1, 1
    ]);

    const texCoords = new Float32Array([
        0, 1, 1, 1, 0, 0,
        0, 0, 1, 1, 1, 0
    ]);

    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    const positionLocation = gl.getAttribLocation(beautyProgram, 'a_position');
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    const texCoordBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);
    const texCoordLocation = gl.getAttribLocation(beautyProgram, 'a_texCoord');
    gl.enableVertexAttribArray(texCoordLocation);
    gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0);

    return glCanvas;
}

function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

function createProgram(gl, vertexShader, fragmentShader) {
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error(gl.getProgramInfoLog(program));
        gl.deleteProgram(program);
        return null;
    }
    return program;
}

async function setupCamera() {
    try {
        if (currentStream) {
            currentStream.getTracks().forEach(track => track.stop());
        }

        const constraints = {
            video: {
                facingMode: facingMode,
                width: { ideal: 640 },
                height: { ideal: 480 }
            },
            audio: true
        };

        currentStream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = currentStream;

        return new Promise((resolve) => {
            video.onloadedmetadata = () => {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                video.play();
                setupMediaRecorder();
                resolve();
            };
        });
    } catch (error) {
        showError('Failed to access camera: ' + error.message);
    }
}

function setupMediaRecorder() {
    try {
        mediaRecorder = new MediaRecorder(currentStream, {
            mimeType: 'video/webm;codecs=vp9,opus'
        });

        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                recordedChunks.push(event.data);
            }
        };

        mediaRecorder.onstop = () => {
            const blob = new Blob(recordedChunks, {
                type: 'video/webm'
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `recording-${new Date().toISOString()}.webm`;
            a.click();
            URL.revokeObjectURL(url);
            recordedChunks = [];
        };
    } catch (error) {
        showError('Failed to setup media recorder: ' + error.message);
    }
}

function updateRecordingTimer() {
    if (!recordingStartTime) return;
    
    const elapsed = Date.now() - recordingStartTime;
    const seconds = Math.floor(elapsed / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    const timeString = `REC ${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
    
    recordingTimerDisplay.textContent = timeString;
    document.getElementById('recordingOverlay').textContent = timeString;
}

function showError(message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.textContent = message;
    document.body.insertBefore(errorDiv, document.body.firstChild);
    setTimeout(() => errorDiv.remove(), 5000);
}

async function detectObjects() {
    try {
        const predictions = await model.detect(video);
        
        const offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = canvas.width;
        offscreenCanvas.height = canvas.height;
        const offscreenCtx = offscreenCanvas.getContext('2d');
        
        if (beautyEnabled && gl && beautyProgram) {
            gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
            
            const texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

            gl.useProgram(beautyProgram);
            gl.uniform1f(gl.getUniformLocation(beautyProgram, 'u_strength'), beautyStrength);
            gl.uniform2f(gl.getUniformLocation(beautyProgram, 'u_textureSize'), video.videoWidth, video.videoHeight);

            gl.drawArrays(gl.TRIANGLES, 0, 6);
            offscreenCtx.drawImage(gl.canvas, 0, 0, canvas.width, canvas.height);
        } else {
            offscreenCtx.drawImage(video, 0, 0, canvas.width, canvas.height);
        }

        const logo = document.getElementById('logo');
        if (logo.complete && logo.naturalHeight !== 0) {
            const logoWidth = canvas.width * (parseFloat(getComputedStyle(document.documentElement)
                .getPropertyValue('--logo-width')) / 100);
            const logoHeight = (logo.naturalHeight / logo.naturalWidth) * logoWidth;
            offscreenCtx.drawImage(logo, 
                canvas.width - logoWidth - 20,
                canvas.height - logoHeight - 20,
                logoWidth, 
                logoHeight
            );
        }

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(offscreenCanvas, 0, 0);

        predictions.forEach(prediction => {
            const [x, y, width, height] = prediction.bbox;
            const label = `${prediction.class} (${Math.round(prediction.score * 100)}%)`;

            ctx.strokeStyle = '#00ff00';
            ctx.lineWidth = 2;
            ctx.strokeRect(x, y, width, height);

            ctx.fillStyle = '#00ff00';
            const textWidth = ctx.measureText(label).width;
            ctx.fillRect(x, y - 25, textWidth + 10, 25);

            ctx.fillStyle = '#000000';
            ctx.font = '16px Arial';
            ctx.fillText(label, x + 5, y - 7);

            if (!uniqueDetections.has(prediction.class)) {
                uniqueDetections.set(prediction.class, new Date().toLocaleTimeString());
                updateDetectionsList();
            }
        });
    } catch (error) {
        console.error('Detection error:', error);
    }
}

function updateDetectionsList() {
    detectedObjectsList.innerHTML = '';
    uniqueDetections.forEach((time, object) => {
        const li = document.createElement('li');
        li.innerHTML = `<span>${object}</span><span>First seen: ${time}</span>`;
        detectedObjectsList.appendChild(li);
    });
}

function startDetection() {
    if (detectionInterval) {
        clearInterval(detectionInterval);
    }
    detectionInterval = setInterval(detectObjects, 500);
}

if (isMobile) {
    switchCameraButton.style.display = 'block';
    switchCameraButton.addEventListener('click', async () => {
        facingMode = facingMode === 'user' ? 'environment' : 'user';
        await setupCamera();
    });
}

recordButton.addEventListener('click', () => {
    if (!isRecording) {
        recordedChunks = [];
        mediaRecorder.start(1000);
        isRecording = true;
        document.getElementById('recordingOverlay').classList.add('active');
        recordButton.innerHTML = '<span style="font-size: 24px; line-height: 24px;">■</span>'; // Bigger stop symbol
        recordButton.classList.add('recording');
        recordingStartTime = Date.now();
        recordingTimer = setInterval(updateRecordingTimer, 1000);
    } else {
        mediaRecorder.stop();
        isRecording = false;
        document.getElementById('recordingOverlay').classList.remove('active');
        recordButton.innerHTML = '';
        recordButton.classList.remove('recording');
        clearInterval(recordingTimer);
        recordingTimerDisplay.textContent = '';
    }
});

document.getElementById('beautyToggle').addEventListener('change', (e) => {
    beautyEnabled = e.target.checked;
    document.getElementById('beautyStrength').disabled = !beautyEnabled;
});

document.getElementById('beautyStrength').addEventListener('input', (e) => {
    beautyStrength = e.target.value / 100;
    document.getElementById('strengthValue').textContent = `${e.target.value}%`;
});

document.getElementById('logo').onerror = function() {
    this.style.display = 'none';
    console.error('Failed to load logo image');
};

async function init() {
    try {
        await setupCamera();
        await loadModel();
        setupBeautyFilter();
    } catch (error) {
        showError('Initialization error: ' + error.message);
    }
}

init();