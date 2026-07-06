import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { DEFAULT_QUESTIONNAIRE } from "./src/defaultConfig";
import { QuestionnaireConfig, StudentResponse } from "./src/types";

// Setup Server State
const CONFIG_FILE = path.join(process.cwd(), "questionnaire_config.json");
let currentConfig: QuestionnaireConfig = DEFAULT_QUESTIONNAIRE;

// Load persisted configuration if it exists
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const fileData = fs.readFileSync(CONFIG_FILE, "utf-8");
    currentConfig = JSON.parse(fileData);
    console.log("Loaded persisted questionnaire configuration.");
  }
} catch (error) {
  console.error("Error loading persisted config, falling back to default:", error);
  currentConfig = DEFAULT_QUESTIONNAIRE;
}

let studentResponses: StudentResponse[] = [];

// SSE Clients Registry
interface SseClient {
  id: number;
  res: express.Response;
}
let nextClientId = 0;
let clients: SseClient[] = [];

// Helper to broadcast state to all live clients
function broadcastState() {
  const payload = JSON.stringify({
    responses: studentResponses,
    config: currentConfig,
    activeUsers: clients.length
  });

  clients.forEach((client) => {
    client.res.write(`data: ${payload}\n\n`);
  });
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Middleware
  app.use(express.json());

  // API: Get current config and state
  app.get("/api/state", (req, res) => {
    res.json({
      config: currentConfig,
      responses: studentResponses,
      activeUsers: clients.length
    });
  });

  // API: Update questionnaire configuration (and clear responses)
  app.post("/api/config", (req, res) => {
    const newConfig = req.body as QuestionnaireConfig;
    if (!newConfig || !newConfig.title || !newConfig.questions || !newConfig.outcomes) {
      res.status(400).json({ error: "Invalid questionnaire configuration structure." });
      return;
    }

    currentConfig = newConfig;
    studentResponses = []; // Clear previous answers as paths/outcomes might have changed

    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(currentConfig, null, 2), "utf-8");
      console.log("Saved updated questionnaire configuration.");
    } catch (err) {
      console.error("Failed to persist questionnaire configuration:", err);
    }

    broadcastState();
    res.json({ success: true, config: currentConfig, responses: studentResponses });
  });

  // API: Submit student response
  app.post("/api/submit", (req, res) => {
    const { studentName, path: choicePath, outcomeId } = req.body;
    if (!choicePath || !Array.isArray(choicePath) || choicePath.length !== 3 || !outcomeId) {
      res.status(400).json({ error: "Invalid response data. Require path array of length 3 and outcomeId." });
      return;
    }

    const newResponse: StudentResponse = {
      id: Math.random().toString(36).substring(2, 11),
      studentName: (studentName && typeof studentName === "string" && studentName.trim().length > 0)
        ? studentName.trim()
        : "Anonymous Student",
      path: choicePath as ('L' | 'R')[],
      outcomeId,
      timestamp: Date.now()
    };

    studentResponses.push(newResponse);
    broadcastState();

    res.json({ success: true, response: newResponse });
  });

  // API: Reset all responses (keep config)
  app.post("/api/reset", (req, res) => {
    studentResponses = [];
    broadcastState();
    res.json({ success: true, responses: studentResponses });
  });

  // API: Real-time Server-Sent Events (SSE) Stream
  app.get("/api/live", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no" // Disable buffering for Nginx
    });

    const clientId = ++nextClientId;
    const newClient: SseClient = { id: clientId, res };
    clients.push(newClient);

    console.log(`SSE client connected. Total clients: ${clients.length}`);

    // Send initial state immediately
    const initialPayload = JSON.stringify({
      responses: studentResponses,
      config: currentConfig,
      activeUsers: clients.length
    });
    res.write(`data: ${initialPayload}\n\n`);

    // Keep-alive heartbeat every 20 seconds to prevent connection dropping
    const keepAliveInterval = setInterval(() => {
      res.write(": keepalive\n\n");
    }, 20000);

    // Broadcast updated client count to other clients
    broadcastState();

    req.on("close", () => {
      clearInterval(keepAliveInterval);
      clients = clients.filter((c) => c.id !== clientId);
      console.log(`SSE client disconnected. Total clients: ${clients.length}`);
      broadcastState();
    });
  });

  // Vite Integration & Static Asset Serving
  if (process.env.NODE_ENV !== "production") {
    console.log("Vite dev mode: loading Vite middleware");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    console.log("Production mode: serving static files from dist/");
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Fullstack server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Critical error starting server:", error);
});
