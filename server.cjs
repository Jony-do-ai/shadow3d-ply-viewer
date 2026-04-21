const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

const PORT = 3001;

// 推理结果目录：里面放 gt.ply / pred.ply
const PLY_ROOT = process.env.PLY_ROOT || "D:/shadow3d-recon/outputs/infer";

// 原始数据集目录：用于找阴影图
const DATASET_ROOT = process.env.DATASET_ROOT || "D:/shadow3d-recon/data/train_runs/dataset";

console.log("[INFO] PLY_ROOT =", PLY_ROOT);
console.log("[INFO] DATASET_ROOT =", DATASET_ROOT);

function isSubPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function safeResolve(root, relativePath) {
  const absRoot = path.resolve(root);
  const absPath = path.resolve(absRoot, relativePath);

  if (absPath !== absRoot && !isSubPath(absRoot, absPath)) {
    throw new Error("Unsafe path");
  }

  return absPath;
}

function findPlyItems(rootDir) {
  const results = [];

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    const fileNames = entries
      .filter((e) => e.isFile())
      .map((e) => e.name.toLowerCase());

    const hasGt = fileNames.includes("gt.ply");
    const hasPred = fileNames.includes("pred.ply") || fileNames.includes("pre.ply");

    if (hasGt || hasPred) {
      const relDir = path.relative(rootDir, currentDir).replace(/\\/g, "/");
      const folderName = path.basename(currentDir);

      results.push({
        name: folderName,
        relDir,
        hasGt,
        hasPred,
      });
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(currentDir, entry.name));
      }
    }
  }

  if (!fs.existsSync(rootDir)) {
    return [];
  }

  walk(rootDir);

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

function parseSampleName(sampleName) {
  const firstUnderscore = sampleName.indexOf("_");

  if (firstUnderscore === -1) {
    return null;
  }

  const categoryId = sampleName.slice(0, firstUnderscore);
  const modelId = sampleName.slice(firstUnderscore + 1);

  if (!categoryId || !modelId) {
    return null;
  }

  return { categoryId, modelId };
}

function getShadowFrames(sampleName) {
  const parsed = parseSampleName(sampleName);

  if (!parsed) {
    return [];
  }

  const { categoryId, modelId } = parsed;

  const sampleDir = path.join(DATASET_ROOT, categoryId, modelId);

  if (!fs.existsSync(sampleDir)) {
    return [];
  }

  const frames = [];

  for (let i = 0; i < 10; i++) {
    const frameName = `frame_${String(i).padStart(3, "0")}`;
    const imagePath = path.join(sampleDir, frameName, "rgb_with_shadow.png");

    if (fs.existsSync(imagePath)) {
      frames.push({
        index: i,
        frameName,
        url: `/api/shadow?sample=${encodeURIComponent(sampleName)}&frame=${encodeURIComponent(frameName)}`,
      });
    }
  }

  return frames;
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    plyRoot: PLY_ROOT,
    datasetRoot: DATASET_ROOT,
  });
});

app.get("/api/items", (req, res) => {
  try {
    const items = findPlyItems(PLY_ROOT).map((item) => {
      const gtUrl = item.hasGt
        ? `/api/ply?relDir=${encodeURIComponent(item.relDir)}&file=gt.ply`
        : null;

      const predFile = fs.existsSync(path.join(PLY_ROOT, item.relDir, "pred.ply"))
        ? "pred.ply"
        : "pre.ply";

      const predUrl = item.hasPred
        ? `/api/ply?relDir=${encodeURIComponent(item.relDir)}&file=${encodeURIComponent(predFile)}`
        : null;

      return {
        ...item,
        gtUrl,
        predUrl,
        shadowFrames: getShadowFrames(item.name),
      };
    });

    res.json({ items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/ply", (req, res) => {
  try {
    const relDir = req.query.relDir;
    const file = req.query.file;

    if (!relDir || !file) {
      return res.status(400).json({ error: "Missing relDir or file" });
    }

    if (file !== "gt.ply" && file !== "pred.ply" && file !== "pre.ply") {
      return res.status(400).json({ error: "Invalid ply file" });
    }

    const filePath = safeResolve(PLY_ROOT, path.join(relDir, file));

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "PLY not found", filePath });
    }

    res.sendFile(filePath);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/shadow", (req, res) => {
  try {
    const sample = req.query.sample;
    const frame = req.query.frame;

    if (!sample || !frame) {
      return res.status(400).json({ error: "Missing sample or frame" });
    }

    const parsed = parseSampleName(sample);

    if (!parsed) {
      return res.status(400).json({ error: "Invalid sample name" });
    }

    if (!/^frame_\d{3}$/.test(frame)) {
      return res.status(400).json({ error: "Invalid frame name" });
    }

    const imagePath = path.join(
      DATASET_ROOT,
      parsed.categoryId,
      parsed.modelId,
      frame,
      "rgb_with_shadow.png"
    );

    if (!fs.existsSync(imagePath)) {
      return res.status(404).json({ error: "Shadow image not found", imagePath });
    }

    res.sendFile(imagePath);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`[INFO] API server running at http://localhost:${PORT}`);
});