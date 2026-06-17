const express = require("express");
const multer  = require("multer");
const cors    = require("cors");
const { spawn } = require("child_process");
const path    = require("path");

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

const isWindows = process.platform === "win32";
const PYTHON = isWindows
  ? path.join(__dirname, ".venv", "Scripts", "python.exe")
  : path.join(__dirname, ".venv", "bin", "python");
const INFER = path.join(__dirname, "infer_xgb.py");

app.use(cors());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", model: "xgboost" });
});

app.post("/predict", upload.single("audio"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "파일 없음" });

  const py = spawn(PYTHON, [INFER]);

  let stdout = "";
  let stderr = "";

  py.stdout.on("data", (d) => (stdout += d));
  py.stderr.on("data", (d) => (stderr += d));

  py.on("error", (err) => {
    console.error("[Python 프로세스 오류]\n", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "프로세스 실행 실패", detail: err.message });
    }
  });

  py.stdin.on("error", (err) => {
    console.error("[Python stdin 오류]\n", err);
  });

  py.on("close", (code) => {
    if (code === 0) {
      try {
        res.json(JSON.parse(stdout));
      } catch {
        if (!res.headersSent) {
          res.status(500).json({ error: "응답 파싱 실패", detail: stdout });
        }
      }
    } else {
      console.error("[Python 오류]\n", stderr);
      if (!res.headersSent) {
        res.status(500).json({ error: "추론 실패", detail: stderr });
      }
    }
  });

  py.stdin.write(req.file.buffer);
  py.stdin.end();
});

const PORT = 5000;
app.listen(PORT, "127.0.0.1", () => {
  console.log(`[AI] Node.js AI 서버 실행 중 → http://127.0.0.1:${PORT}`);
});
