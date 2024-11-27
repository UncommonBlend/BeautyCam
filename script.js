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
let offscreenCanvas;

function debugLog(message) {
    const debugMessages = document.getElementById('debugMessages');
    const timestamp = new Date().toLocaleTimeString();
    debugMessages.innerHTML = `${timestamp}: ${message}<br>` + debugMessages.innerHTML;
    console.log(message);
}

const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
const isOldIOS = isMobile && /iPhone|iPad|iPod/.test(navigator.userAgent) && 
                 /OS [1-9]|1[0-4]_/.test(navigator.userAgent);

async function loadModel() {
    try {
        debugLog('Loading object detection model...');
        model = await cocoSsd.load();
        debugLog('Model loaded successfully');
        startDetection();
    } catch (error) {
        debugLog('Failed to load model: ' + error.message);
        showError('Failed to load object detection model: ' + error.message);
    }
}

function setupBeautyFilter() {
    const glCanvas = document.createElement('canvas');
    glCanvas.width = video.videoWidth;
    glCanvas.height = video.videoHeight;
    gl = glCanvas.getContext('webgl');

    if (!gl) {
        debugLog('WebGL not supported');
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

    debugLog('Beauty filter setup complete');
    return glCanvas;
}

function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        debugLog('Shader compilation error: ' + gl.getShaderInfoLog(shader));
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
        debugLog('Program linking error: ' + gl.getProgramInfoLog(program));
        gl.deleteProgram(program);
        return null;
    }
    return program;
}


async function setupCamera() {
    try {
        debugLog('Setting up camera...');
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error('Camera API not available');
        }

        if (currentStream) {
            currentStream.getTracks().forEach(track => track.stop());
        }

        const constraints = {
            video: {
                facingMode: facingMode
            },
            audio: true
        };

        debugLog(`Requesting camera access with facing mode: ${facingMode}`);
        currentStream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = currentStream;

        return new Promise((resolve) => {
            video.onloadedmetadata = () => {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                video.play();
                
                if (!offscreenCanvas) {
                    offscreenCanvas = document.createElement('canvas');
                    offscreenCanvas.width = canvas.width;
                    offscreenCanvas.height = canvas.height;
                }
                
                if (typeof MediaRecorder !== 'undefined') {
                    debugLog('MediaRecorder is supported, setting up recording...');
                    setupMediaRecorder();
                } else {
                    debugLog('MediaRecorder is not supported on this device');
                    const recordingControls = document.querySelector('.recording-controls');
                    if (recordingControls) {
                        recordingControls.style.display = 'none';
                    }
                }
                resolve();
                debugLog('Camera setup complete');
            };
        });
    } catch (error) {
        debugLog('Camera Setup Error: ' + error.message);
        showError('Camera access failed: ' + error.message);
    }
}

function setupMediaRecorder() {
    try {
        debugLog('Setting up MediaRecorder...');
        const canvasStream = canvas.captureStream(30);
        debugLog('Canvas stream created at 30 FPS');
        
        const audioTrack = currentStream.getAudioTracks()[0];
        if (audioTrack) {
            debugLog('Audio track found and added to stream');
            canvasStream.addTrack(audioTrack);
        }

        const mimeTypes = [
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp8,opus',
            'video/webm',
            'video/mp4'
        ];

        let selectedMimeType = null;
        for (const mimeType of mimeTypes) {
            if (MediaRecorder.isTypeSupported(mimeType)) {
                selectedMimeType = mimeType;
                debugLog(`Selected MIME type: ${mimeType}`);
                break;
            }
        }

        if (!selectedMimeType) {
            throw new Error('No supported mime type found');
        }

        mediaRecorder = new MediaRecorder(canvasStream, {
            mimeType: selectedMimeType,
            videoBitsPerSecond: 2500000
        });

        mediaRecorder.ondataavailable = (event) => {
            debugLog(`Data available: ${event.data.size} bytes`);
            if (event.data && event.data.size > 0) {
                recordedChunks.push(event.data);
            }
        };

        mediaRecorder.onstop = () => {
            debugLog(`Recording stopped, ${recordedChunks.length} chunks collected`);
            if (recordedChunks.length === 0) {
                debugLog('Error: No data was recorded');
                showError('No data was recorded');
                return;
            }

            const fileExtension = selectedMimeType.includes('mp4') ? 'mp4' : 'webm';
            const blob = new Blob(recordedChunks, { type: selectedMimeType });
            debugLog(`Created blob of size: ${blob.size} bytes`);

            if (blob.size === 0) {
                debugLog('Error: Recording resulted in empty file');
                showError('Recording failed: Empty file');
                return;
            }

            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `recording-${new Date().toISOString()}.${fileExtension}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            recordedChunks = [];
            debugLog('Recording saved and downloaded');
        };

        debugLog('MediaRecorder setup complete');
    } catch (error) {
        debugLog('MediaRecorder setup failed: ' + error.message);
        recordButton.style.display = 'none';
        showError('Recording setup failed: ' + error.message);
    }
}

async function detectObjects() {
    try {
        const predictions = await model.detect(video);
        
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
        debugLog('Detection error: ' + error.message);
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

// Event Listeners
if (isMobile) {
    switchCameraButton.style.display = 'flex';
    switchCameraButton.addEventListener('click', async () => {
        try {
            debugLog('Switching camera...');
            if (currentStream) {
                currentStream.getTracks().forEach(track => track.stop());
            }
            facingMode = facingMode === 'user' ? 'environment' : 'user';
            debugLog(`New facing mode: ${facingMode}`);
            await setupCamera();
        } catch (error) {
            debugLog('Failed to switch camera: ' + error.message);
            showError('Failed to switch camera. Please try again.');
        }
    });
}

recordButton.addEventListener('click', () => {
    if (!isRecording) {
        recordedChunks = [];
        try {
            debugLog('Starting recording...');
            mediaRecorder.start(1000);
            isRecording = true;
            document.getElementById('recordingOverlay').classList.add('active');
            recordButton.innerHTML = '<span style="font-size: 32px;">■</span>';
            recordButton.classList.add('recording');
            recordingStartTime = Date.now();
            recordingTimer = setInterval(updateRecordingTimer, 1000);
            debugLog('Recording started successfully');
        } catch (error) {
            debugLog('Failed to start recording: ' + error.message);
            showError('Failed to start recording: ' + error.message);
        }
    } else {
        try {
            debugLog('Stopping recording...');
            mediaRecorder.stop();
            isRecording = false;
            document.getElementById('recordingOverlay').classList.remove('active');
            recordButton.innerHTML = '';
            recordButton.classList.remove('recording');
            clearInterval(recordingTimer);
            recordingTimerDisplay.textContent = '';
            debugLog('Recording stopped successfully');
        } catch (error) {
            debugLog('Failed to stop recording: ' + error.message);
            showError('Failed to stop recording: ' + error.message);
        }
    }
});

document.getElementById('beautyToggle').addEventListener('change', (e) => {
    beautyEnabled = e.target.checked;
    document.getElementById('beautyStrength').disabled = !beautyEnabled;
    debugLog(`Beauty filter ${beautyEnabled ? 'enabled' : 'disabled'}`);
});

document.getElementById('beautyStrength').addEventListener('input', (e) => {
    beautyStrength = e.target.value / 100;
    document.getElementById('strengthValue').textContent = `${e.target.value}%`;
    debugLog(`Beauty strength set to ${e.target.value}%`);
});

document.getElementById('logo').onerror = function() {
    this.style.display = 'none';
    debugLog('Failed to load logo image');
};

function checkRecordingSupport() {
    const isSupported = typeof MediaRecorder !== 'undefined';
    const recordingControls = document.querySelector('.recording-controls');
    
    if (!isSupported) {
        debugLog('MediaRecorder is not supported on this device');
        recordingControls.style.display = 'none';
        showError('Recording is not supported on this device. iOS 14.3 or higher is required for recording.');
    }
}

async function init() {
    try {
        debugLog('Initializing application...');
        await setupCamera();
        await loadModel();
        setupBeautyFilter();
        checkRecordingSupport();
        debugLog('Initialization complete');
    } catch (error) {
        debugLog('Initialization error: ' + error.message);
        showError('Initialization error: ' + error.message);
    }
}

init();
