const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const { spawn, exec } = require("child_process");
const fs = require("fs");
const axios = require("axios");

// PERFORMANCE OPTIMIZATION: Conditional hardware acceleration
// This dramatically improves UI smoothness while maintaining fallback safety
if (!process.env.DISABLE_GPU) {
  // Enable GPU acceleration for most users
  app.commandLine.appendSwitch("enable-gpu-rasterization");
  app.commandLine.appendSwitch("enable-zero-copy");
} else {
  // Original fallback for problematic systems
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
}

// Safety fallback for GPU crashes - LOG ONLY, don't disable after ready
app.on("gpu-process-crashed", () => {
  console.log("GPU process crashed - note for next restart");
  // Can't call disableHardwareAcceleration after app ready
  // User should restart with DISABLE_GPU=1 if issues persist
});

let mainWindow;
let pythonProcess;
const BACKEND_PORT = 5000;
const BACKEND_HOST = "127.0.0.1";
const BACKEND_URL = `http://${BACKEND_HOST}:${BACKEND_PORT}`;

function cleanupPythonProcess() {
    if (pythonProcess) {
        console.log("Cleaning up Python process...");
        try {
            pythonProcess.kill('SIGTERM');
            setTimeout(() => {
                if (pythonProcess && !pythonProcess.killed) {
                    console.log("Force killing Python process...");
                    pythonProcess.kill('SIGKILL');
                }
            }, 3000); // Reduced timeout for faster cleanup
        } catch (error) {
            console.error("Error during Python process cleanup:", error);
        }
        pythonProcess = null;
    }
    
    // Also try to kill our app's Python processes using the kill script
    try {
        const { exec } = require('child_process');
        const pythonPath = path.join(__dirname, "..", "python");
        const killScript = path.join(pythonPath, "kill_python_processes.py");
        
        exec(`python "${killScript}"`, { cwd: pythonPath }, (error, stdout, stderr) => {
            if (error) {
                console.log("Kill script error (expected if no processes to kill):", error.message);
            } else {
                console.log("Kill script output:", stdout);
            }
        });
    } catch (error) {
        console.error("Error running kill script:", error);
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1200,
        minHeight: 800,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, "preload.js"),
            // PERFORMANCE OPTIMIZATIONS:
            experimentalFeatures: true,
            enableRemoteModule: false,
            // Prevent background throttling for smooth animations
            backgroundThrottling: false,
            // Enable hardware acceleration features
            hardwareAcceleration: true,
        },
        titleBarStyle: "default",
        icon: path.join(__dirname, "assets", "icon.png"),
        show: false,
    });

    mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

    // Optional DevTools: controlled by env flag
    if (!app.isPackaged && process.env.ELECTRON_DEVTOOLS === '1') {
        mainWindow.webContents.openDevTools({ mode: "detach" });
    }

    mainWindow.once("ready-to-show", () => {
        mainWindow.show();
        mainWindow.maximize();  // Ensure window is maximized
        // no noisy log
    });

    mainWindow.on('close', async (event) => {
        try {
            console.log("[CLOSE] Starting CLEAN WORKFLOW cleanup on app close...");
            
            // Set a timeout to force close if cleanup takes too long
            const cleanupTimeout = setTimeout(() => {
                console.log("[CLOSE] Cleanup timeout reached, forcing close...");
                cleanupPythonProcess();
                mainWindow.destroy();
            }, 15000); // Increased timeout for thorough cleanup
            
            // PRESERVE SESSIONS CLEANUP SEQUENCE - Only clean locks and temp files
            console.log("[CLOSE] Step 1: Stop active processes...");
            await Promise.allSettled([
                // Stop all active processes but don't force disconnect
                axios.post(`${BACKEND_URL}/api/stop-process`, { process_id: 'ALL' }, { timeout: 3000 })
            ]);
            
            console.log("[CLOSE] Step 2: Clean temporary files and locks only...");
            await Promise.allSettled([
                // Clear ONLY temporary sessions and lock files - preserve main sessions
                axios.post(`${BACKEND_URL}/api/clear-session`, {}, { timeout: 3000 })
            ]);
            
            console.log("[CLOSE] Step 3: Process cleanup...");
            await Promise.allSettled([
                // Kill our app's Python processes
                axios.post(`${BACKEND_URL}/api/kill-our-processes`, {}, { timeout: 3000 })
            ]);
            
            // Small delay to ensure cleanup is processed
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            clearTimeout(cleanupTimeout);
            console.log("[CLOSE] CLEAN WORKFLOW cleanup completed successfully");
        } catch (error) {
            console.error("[CLOSE] Error during cleanup:", error);
        } finally {
            cleanupPythonProcess();
        }
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: "deny" };
    });

    // no noisy log on did-finish-load
    mainWindow.webContents.on("did-finish-load", () => {});
}

function startPythonBackend() {
    return new Promise((resolve, reject) => {
        const pythonPath = path.join(__dirname, "..", "python");
        const scriptPath = path.join(pythonPath, "backend.py");
        const pythonCmd = process.platform === "win32" ? "python" : "python3";
        
        // Start Python backend quietly
        
        pythonProcess = spawn(pythonCmd, [scriptPath], {
            cwd: pythonPath,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
                ...process.env,
                BACKEND_LOG_LEVEL: process.env.BACKEND_LOG_LEVEL || 'WARNING',
                BACKEND_LOG_TO_STDOUT: '0',
            },
        });
        
        // Always log backend output for debugging
        pythonProcess.stdout.on('data', (data) => {
            console.log(`Backend: ${data}`);
        });
        
        pythonProcess.stderr.on('data', (data) => {
            console.error(`Backend Error: ${data}`);
        });

        // Resolve when process has spawned successfully
        pythonProcess.on('spawn', () => resolve());

        // Rely on health check instead of stdout parsing

        pythonProcess.on("close", (code) => {
            pythonProcess = null;
        });

        pythonProcess.on("error", (error) => {
            console.error("Failed to start Python process:", error);
            reject(error);
        });

        // No assumption based on stdout; readiness handled in waitForBackend
    });
}

async function waitForBackend() {
    const maxAttempts = 60;
    let attempts = 0;
    
    // quiet health checks
    
    while (attempts < maxAttempts) {
        try {
            const response = await axios.get(`${BACKEND_URL}/api/health`, {
                timeout: 5000,
                headers: { 'Content-Type': 'application/json' }
            });
            
            if (response.data && response.data.status === "healthy") {
                return true;
            }
            
            throw new Error("Backend not healthy");
        } catch (error) {
            attempts++;
            
            if (attempts < maxAttempts) {
                // Exponential backoff
                const delay = Math.min(1000 * Math.pow(2, attempts), 10000);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    
    throw new Error(`Backend failed to start after ${maxAttempts} attempts`);
}

// IPC HANDLERS
ipcMain.handle("select-files", async (event, options) => {
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ["openFile", "multiSelections"],
            filters: options.filters || [{ name: "All Files", extensions: ["*"] }],
        });
        
        // Check if dialog was cancelled
        if (result.canceled) {
            return [];
        }
        
        // Validate file paths and handle Windows-specific issues
        const validPaths = result.filePaths.filter(filePath => {
            try {
                // Check if file exists and is accessible
                if (!fs.existsSync(filePath)) {
                    console.warn(`File does not exist: ${filePath}`);
                    return false;
                }
                
                // Check file path length (Windows limit is ~260 characters)
                if (filePath.length > 250) {
                    console.warn(`File path too long: ${filePath}`);
                    return false;
                }
                
                // Check for invalid characters in filename
                const fileName = path.basename(filePath);
                const invalidChars = /[<>:"|?*]/;
                if (invalidChars.test(fileName)) {
                    console.warn(`File name contains invalid characters: ${fileName}`);
                    return false;
                }
                
                return true;
            } catch (error) {
                console.warn(`Error validating file path ${filePath}:`, error.message);
                return false;
            }
        });
        
        return validPaths;
    } catch (error) {
        console.error("Error in select-files handler:", error);
        return [];
    }
});

ipcMain.handle("select-directory", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ["openDirectory"],
    });
    return result.filePaths[0];
});

ipcMain.handle('api-request', async (event, { method, endpoint, data }) => {
    try {
        // Only log API requests in debug mode
        const debugMode = process.env.ELECTRON_DEBUG === '1';
        if (debugMode) {
            console.log(`[API REQUEST] ${method} ${BACKEND_URL}${endpoint}`);
            if (data) console.log(`[API REQUEST] Data:`, JSON.stringify(data, null, 2));
        }
        
        const config = {
            method,
            url: `${BACKEND_URL}${endpoint}`,
            timeout: 60000,
            headers: {
                'Content-Type': 'application/json'
            }
        };
        
        if (data) {
            config.data = data;
        }
        
        const response = await axios(config);
        
        if (debugMode) console.log(`[API SUCCESS] Status: ${response.status}`);
        return { success: true, data: response.data };
    } catch (error) {
        console.error(`[API ERROR] ${error.message}`);
        if (error.response) {
            // keep error details minimal
            return {
                success: false,
                error: error.response.data?.error || error.message,
                status: error.response.status,
                details: error.response.data
            };
        }
        return {
            success: false,
            error: error.message,
            code: error.code
        };
    }
});

ipcMain.handle("open-external", async (event, url) => {
    shell.openExternal(url);
});

ipcMain.handle('read-stats', async () => {
    try {
        const statsPath = path.join(process.cwd(), 'logs', 'stats.json');
        const raw = fs.readFileSync(statsPath, 'utf8');
        const data = JSON.parse(raw);
        return { success: true, data, path: statsPath };
    } catch (e) {
        return { success: false, error: e?.message || String(e) };
    }
});



// APP LIFECYCLE
app.whenReady().then(async () => {
    try {
        await startPythonBackend();
        await waitForBackend();
        createWindow();
        
        app.on("activate", () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });
        
    } catch (error) {
        // Minimal error log for startup failure
        console.error("Failed to start application:", error?.message || error);
        cleanupPythonProcess();
        app.quit();
    }
});

app.on("window-all-closed", () => {
    // PRESERVE SESSIONS: Only clean temp files and processes
    (async () => {
        try { 
            await axios.post(`${BACKEND_URL}/api/clear-session`).catch(() => {}); 
            await axios.post(`${BACKEND_URL}/api/kill-our-processes`).catch(() => {});
        } catch {}
    })().finally(() => cleanupPythonProcess());
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("before-quit", () => {
    // Gentle backend shutdown - preserve sessions
    try { exec(`curl -s -X POST -H \"Content-Type: application/json\" -d '{"process_id":"ALL"}' ${BACKEND_URL}/api/stop-process`); } catch {}
    try { exec(`curl -s -X POST ${BACKEND_URL}/api/clear-session`); } catch {}
    cleanupPythonProcess();
});

process.on("uncaughtException", (error) => {
    console.error("Uncaught Exception:", error?.message || error);
    cleanupPythonProcess();
    // Force exit after cleanup to prevent hanging
    setTimeout(() => {
        process.exit(1);
    }, 5000);
});

process.on("unhandledRejection", (reason) => {
    console.error("Unhandled Rejection:", (reason && reason.message) || reason);
    // Don't exit on unhandled rejections, just log them
});

process.on('SIGINT', () => {
    cleanupPythonProcess();
    process.exit(0);
});

process.on('SIGTERM', () => {
    cleanupPythonProcess();
    process.exit(0);
});