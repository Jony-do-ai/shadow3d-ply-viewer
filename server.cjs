const express = require("express");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");

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

const APP_CONFIG_PATH = process.env.APP_CONFIG || path.join(__dirname, "config", "app_config.json");

function loadJson(filePath, fallbackValue) {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn("[WARN] config not found:", filePath);
      return fallbackValue;
    }

    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    console.warn("[WARN] failed to load json config:", filePath, err.message || err);
    return fallbackValue;
  }
}

const APP_CONFIG = loadJson(APP_CONFIG_PATH, {});

function resolveConfiguredPath(value, fallbackRelativePath) {
  const raw = value || fallbackRelativePath;

  if (!raw) {
    return "";
  }

  if (path.isAbsolute(raw)) {
    return path.normalize(raw);
  }

  return path.resolve(__dirname, raw);
}

function normalizeRemoteBase(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function joinRemoteUrl(...parts) {
  return parts
    .filter((part) => part !== null && part !== undefined && String(part).trim() !== "")
    .map((part, index) => {
      const value = String(part).replace(/\\/g, "/");
      return index === 0 ? value.replace(/\/+$/, "") : value.replace(/^\/+|\/+$/g, "");
    })
    .join("/");
}

function normalizeManifestSamples(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (Array.isArray(value.samples)) {
    return value.samples;
  }

  return [];
}

async function loadRemoteManifest() {
  if (!REMOTE_ENABLED) {
    return null;
  }

  if (!remoteManifestPromise) {
    remoteManifestPromise = (async () => {
      if (REMOTE_CONFIG.manifest && typeof REMOTE_CONFIG.manifest === "object") {
        return REMOTE_CONFIG.manifest;
      }

      if (REMOTE_MANIFEST_FILE && fs.existsSync(REMOTE_MANIFEST_FILE)) {
        return loadJson(REMOTE_MANIFEST_FILE, {});
      }

      if (!REMOTE_MANIFEST_URL) {
        console.warn("[WARN] Cloudflare mode is enabled but manifestUrl is empty.");
        return {};
      }

      const res = await fetch(REMOTE_MANIFEST_URL);

      if (!res.ok) {
        console.warn(`[WARN] Remote manifest failed: ${res.status} ${REMOTE_MANIFEST_URL}`);
        console.warn(`[WARN] Upload manifest.json to R2 or create local fallback: ${REMOTE_MANIFEST_FILE}`);
        return {};
      }

      return await res.json();
    })().catch((err) => {
      remoteManifestPromise = null;
      throw err;
    });
  }

  return await remoteManifestPromise;
}

function getManifestExperiment(manifest, experimentName) {
  const experiments = manifest?.experiments;

  if (Array.isArray(experiments)) {
    return experiments.find((exp) => exp?.name === experimentName) || null;
  }

  if (experiments && typeof experiments === "object") {
    return experiments[experimentName] || null;
  }

  return manifest?.[experimentName] || null;
}

const FILE_CONFIG = {
  trainPointCloudsDirName: "point_clouds",
  testPredNames: ["pred.ply", "pre.ply"],
  testGtName: "gt.ply",
  trainPredPattern: "^epoch_\\d+_pred\\.ply$",
  trainGtName: "gt.ply",
  shadowImageName: "rgb_with_shadow.png",
  shadowFrameCount: 10,
  ...(APP_CONFIG.files || {}),
};

const REMOTE_CONFIG = {
  enabled: false,
  assetBaseUrl: "",
  manifestUrl: "",
  ...(APP_CONFIG.cloudflare || {}),
};

const PORT = Number(process.env.PORT || APP_CONFIG.server?.port || 3001);
const PLY_ROOT = process.env.PLY_ROOT || resolveConfiguredPath(APP_CONFIG.paths?.inferRoot, "");
const DATASET_ROOT = process.env.DATASET_ROOT || resolveConfiguredPath(APP_CONFIG.paths?.testDatasetRoot, "");
const TRAIN_RUNS_ROOT = process.env.TRAIN_RUNS_ROOT || resolveConfiguredPath(APP_CONFIG.paths?.trainRunsRoot, "");
const CATEGORY_CONFIG =
  process.env.CATEGORY_CONFIG || resolveConfiguredPath(APP_CONFIG.paths?.categoryConfig, "config/shape_categories.json");

const TEST_PRED_NAMES = (Array.isArray(FILE_CONFIG.testPredNames) ? FILE_CONFIG.testPredNames : ["pred.ply"])
  .map((name) => String(name).toLowerCase());
const TEST_GT_NAME = String(FILE_CONFIG.testGtName || "gt.ply");
const TRAIN_GT_NAME = String(FILE_CONFIG.trainGtName || "gt.ply");
const TRAIN_PRED_RE = new RegExp(FILE_CONFIG.trainPredPattern || "^epoch_\\d+_pred\\.ply$", "i");
const SHADOW_IMAGE_NAME = String(FILE_CONFIG.shadowImageName || "rgb_with_shadow.png");
const SHADOW_FRAME_COUNT = Number(FILE_CONFIG.shadowFrameCount || 10);
const CSV_DATA_ROOT = path.join(__dirname, "public", "data", "train");
const REMOTE_ENABLED = Boolean(REMOTE_CONFIG.enabled);
const REMOTE_ASSET_BASE_URL = normalizeRemoteBase(
  process.env.ASSET_BASE_URL || REMOTE_CONFIG.assetBaseUrl
);
const REMOTE_MANIFEST_URL =
  process.env.REMOTE_MANIFEST_URL ??
  (Object.prototype.hasOwnProperty.call(REMOTE_CONFIG, "manifestUrl")
    ? REMOTE_CONFIG.manifestUrl
    : REMOTE_ASSET_BASE_URL
      ? `${REMOTE_ASSET_BASE_URL}/manifest.json`
      : "");
const REMOTE_MANIFEST_FILE =
  process.env.REMOTE_MANIFEST_FILE ||
  resolveConfiguredPath(REMOTE_CONFIG.manifestFile, "config/remote_manifest.json");

let remoteManifestPromise = null;

console.log("[INFO] APP_CONFIG =", APP_CONFIG_PATH);
console.log("[INFO] PLY_ROOT =", PLY_ROOT);
console.log("[INFO] DATASET_ROOT =", DATASET_ROOT);
console.log("[INFO] TRAIN_RUNS_ROOT =", TRAIN_RUNS_ROOT);
console.log("[INFO] CATEGORY_CONFIG =", CATEGORY_CONFIG);
console.log("[INFO] REMOTE_ENABLED =", REMOTE_ENABLED);
console.log("[INFO] REMOTE_ASSET_BASE_URL =", REMOTE_ASSET_BASE_URL);
console.log("[INFO] REMOTE_MANIFEST_URL =", REMOTE_MANIFEST_URL);
console.log("[INFO] REMOTE_MANIFEST_FILE =", REMOTE_MANIFEST_FILE);

const CATEGORY_MAP = loadJson(CATEGORY_CONFIG, {});

function parseConfiguredExperiments(experiments) {
  return (Array.isArray(experiments) ? experiments : [])
    .map((exp) => {
      if (typeof exp === "string") {
        return { name: exp, label: exp };
      }

      return {
        name: String(exp?.name || "").trim(),
        label: String(exp?.label || exp?.name || "").trim(),
      };
    })
    .filter((exp) => exp.name);
}

function getConfiguredExperiments(mode) {
  if (mode === "train" && Array.isArray(APP_CONFIG.trainExperiments)) {
    return parseConfiguredExperiments(APP_CONFIG.trainExperiments);
  }

  if (mode === "test" && Array.isArray(APP_CONFIG.testExperiments)) {
    return parseConfiguredExperiments(APP_CONFIG.testExperiments);
  }

  return parseConfiguredExperiments(APP_CONFIG.experiments || []);
}

const TRAIN_EXPERIMENTS = getConfiguredExperiments("train");
const TEST_EXPERIMENTS = getConfiguredExperiments("test");
const EXPERIMENTS = Array.from(
  new Map([...TRAIN_EXPERIMENTS, ...TEST_EXPERIMENTS, ...getConfiguredExperiments()].map((exp) => [exp.name, exp])).values()
);

function getExperimentsByMode(mode) {
  return mode === "test" ? TEST_EXPERIMENTS : TRAIN_EXPERIMENTS;
}

function getExperimentMeta(name, mode) {
  const modeExperiments = mode ? getExperimentsByMode(mode) : EXPERIMENTS;
  return modeExperiments.find((exp) => exp.name === name) || null;
}

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

function listDirSafe(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.warn("[WARN] cannot read dir:", dir, err.message || err);
    return [];
  }
}

function normalizeRelPath(absRoot, absPath) {
  return path.relative(absRoot, absPath).replace(/\\/g, "/");
}

function parseSampleName(sampleName) {
  // 典型格式：02801938_133d74f10a0401317773da01b1ba21ef
  const match = /^([0-9]{8})[_-](.+)$/.exec(sampleName);

  if (!match) {
    return null;
  }

  const categoryId = match[1];
  const modelId = match[2];

  if (!categoryId || !modelId) {
    return null;
  }

  return { categoryId, modelId };
}

function getCategoryMeta(categoryId) {
  const config = CATEGORY_MAP[categoryId];

  if (!config) {
    return {
      categoryId: categoryId || "unknown",
      categoryNameEn: "Unknown",
      categoryNameZh: categoryId ? `未知类别-${categoryId}` : "未知类别",
      categoryCount: null,
      categoryLabel: categoryId ? `未知类别（${categoryId}）` : "未知类别",
    };
  }

  return {
    categoryId,
    categoryNameEn: config.en || "Unknown",
    categoryNameZh: config.zh || config.en || categoryId,
    categoryCount: Number.isFinite(config.count) ? config.count : null,
    categoryLabel: `${config.zh || config.en || categoryId}（${categoryId}）`,
  };
}

function enrichSampleName(sampleName) {
  const parsed = parseSampleName(sampleName);

  if (!parsed) {
    return {
      sampleName,
      categoryId: "unknown",
      modelId: sampleName,
      ...getCategoryMeta(null),
    };
  }

  return {
    sampleName,
    ...parsed,
    ...getCategoryMeta(parsed.categoryId),
  };
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

  for (let i = 0; i < SHADOW_FRAME_COUNT; i++) {
    const frameName = `frame_${String(i).padStart(3, "0")}`;
    const imagePath = path.join(sampleDir, frameName, SHADOW_IMAGE_NAME);

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

function getLowerFileNameMap(entries) {
  const map = new Map();

  for (const entry of entries) {
    if (entry.isFile()) {
      map.set(entry.name.toLowerCase(), entry.name);
    }
  }

  return map;
}

function findTestPredFile(fileMap) {
  for (const predName of TEST_PRED_NAMES) {
    if (fileMap.has(predName)) {
      return fileMap.get(predName);
    }
  }

  return null;
}

function findTestSamplesForExperiment(experiment) {
  const results = [];
  const experimentRoot = path.join(PLY_ROOT, experiment.name);

  function walk(currentDir) {
    const entries = listDirSafe(currentDir);
    const fileMap = getLowerFileNameMap(entries);
    const gtFile = fileMap.get(TEST_GT_NAME.toLowerCase()) || null;
    const predFile = findTestPredFile(fileMap);

    if (gtFile || predFile) {
      const relDir = normalizeRelPath(PLY_ROOT, currentDir);
      const sampleName = path.basename(currentDir);
      const sampleInfo = enrichSampleName(sampleName);

      results.push({
        mode: "test",
        nodeType: "sample",
        id: `test:${relDir}`,
        label: sampleInfo.modelId,
        relDir,
        experimentName: experiment.name,
        experimentLabel: experiment.label,
        hasGt: Boolean(gtFile),
        hasPred: Boolean(predFile),
        gtUrl: gtFile
          ? `/api/ply?mode=test&relDir=${encodeURIComponent(relDir)}&file=${encodeURIComponent(gtFile)}`
          : null,
        predUrl: predFile
          ? `/api/ply?mode=test&relDir=${encodeURIComponent(relDir)}&file=${encodeURIComponent(predFile)}`
          : null,
        shadowFrames: getShadowFrames(sampleName),
        ...sampleInfo,
      });
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(currentDir, entry.name));
      }
    }
  }

  if (!fs.existsSync(experimentRoot)) {
    return [];
  }

  walk(experimentRoot);
  return results.sort(compareSamples);
}

function getEpochNumber(fileName) {
  const match = /^epoch_(\d+)_pred\.ply$/i.exec(fileName);
  return match ? Number(match[1]) : null;
}

function findTrainSamplesForExperiment(experiment) {
  const results = [];
  const pointCloudsDir = path.join(
    TRAIN_RUNS_ROOT,
    experiment.name,
    FILE_CONFIG.trainPointCloudsDirName
  );

  for (const entry of listDirSafe(pointCloudsDir)) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sampleDir = path.join(pointCloudsDir, entry.name);
    const relDir = normalizeRelPath(TRAIN_RUNS_ROOT, sampleDir);
    const fileNames = listDirSafe(sampleDir)
      .filter((e) => e.isFile())
      .map((e) => e.name);

    const predFiles = fileNames
      .filter((name) => TRAIN_PRED_RE.test(name))
      .sort((a, b) => getEpochNumber(a) - getEpochNumber(b));

    const gtFile = fileNames.find((name) => name.toLowerCase() === TRAIN_GT_NAME.toLowerCase()) || null;

    if (predFiles.length === 0 && !gtFile) {
      continue;
    }

    const sampleInfo = enrichSampleName(entry.name);
    const plyFiles = [
      ...predFiles.map((file) => ({
        kind: "pred",
        file,
        label: file,
        epoch: getEpochNumber(file),
        url: `/api/ply?mode=train&relDir=${encodeURIComponent(relDir)}&file=${encodeURIComponent(file)}`,
      })),
      ...(gtFile
        ? [
            {
              kind: "gt",
              file: gtFile,
              label: gtFile,
              epoch: null,
              url: `/api/ply?mode=train&relDir=${encodeURIComponent(relDir)}&file=${encodeURIComponent(gtFile)}`,
            },
          ]
        : []),
    ];

    results.push({
      mode: "train",
      nodeType: "sample",
      id: `train:${relDir}`,
      label: sampleInfo.modelId,
      relDir,
      experimentName: experiment.name,
      experimentLabel: experiment.label,
      plyFiles,
      ...sampleInfo,
    });
  }

  return results.sort(compareSamples);
}

function getRemoteTrainSampleEntries(manifest, experiment) {
  const expManifest = getManifestExperiment(manifest, experiment.name);
  const candidates = [
    expManifest?.trainSamples,
    expManifest?.train,
    expManifest?.samples,
    manifest?.trainSamples?.[experiment.name],
    manifest?.train_runs?.[experiment.name]?.point_clouds,
  ];

  for (const candidate of candidates) {
    const samples = normalizeManifestSamples(candidate);

    if (samples.length > 0) {
      return samples;
    }

    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return Object.entries(candidate).map(([sampleName, files]) => ({
        sampleName,
        modelId: sampleName,
        files,
      }));
    }
  }

  return [];
}

function getRemoteFileNames(sample) {
  const rawFiles = sample.files || sample.plyFiles || sample.pointClouds || sample.point_clouds || [];

  if (Array.isArray(rawFiles)) {
    return rawFiles
      .map((file) => (typeof file === "string" ? file : file?.file || file?.name))
      .filter(Boolean);
  }

  if (rawFiles && typeof rawFiles === "object") {
    return Object.values(rawFiles)
      .flat()
      .map((file) => (typeof file === "string" ? file : file?.file || file?.name))
      .filter(Boolean);
  }

  return [];
}

function findRemoteTrainSamplesForExperiment(manifest, experiment) {
  const results = [];

  for (const sample of getRemoteTrainSampleEntries(manifest, experiment)) {
    const sampleName = String(sample.sampleName || sample.name || sample.modelId || "").trim();

    if (!sampleName) {
      continue;
    }

    const fileNames = getRemoteFileNames(sample);
    const predFiles = [
      ...fileNames.filter((name) => TRAIN_PRED_RE.test(name)),
      ...(sample.predFiles || sample.pred_files || []),
    ]
      .filter(Boolean)
      .map(String)
      .sort((a, b) => getEpochNumber(a) - getEpochNumber(b));

    const gtFile =
      sample.gtFile ||
      sample.gt_file ||
      fileNames.find((name) => name.toLowerCase() === TRAIN_GT_NAME.toLowerCase()) ||
      null;

    if (predFiles.length === 0 && !gtFile) {
      continue;
    }

    const relDir = joinRemoteUrl(experiment.name, FILE_CONFIG.trainPointCloudsDirName, sampleName);
    const sampleInfo = enrichSampleName(sampleName);
    const makeUrl = (file) =>
      `/api/ply?mode=train&relDir=${encodeURIComponent(relDir)}&file=${encodeURIComponent(file)}`;

    const plyFiles = [
      ...predFiles.map((file) => ({
        kind: "pred",
        file,
        label: file,
        epoch: getEpochNumber(file),
        url: makeUrl(file),
      })),
      ...(gtFile
        ? [
            {
              kind: "gt",
              file: gtFile,
              label: gtFile,
              epoch: null,
              url: makeUrl(gtFile),
            },
          ]
        : []),
    ];

    results.push({
      mode: "train",
      nodeType: "sample",
      id: `train:${relDir}`,
      label: sampleInfo.modelId,
      relDir,
      experimentName: experiment.name,
      experimentLabel: experiment.label,
      plyFiles,
      ...sampleInfo,
    });
  }

  return results.sort(compareSamples);
}

function getRemoteTestSampleEntries(manifest, experiment) {
  const expManifest = getManifestExperiment(manifest, experiment.name);
  const candidates = [
    expManifest?.testSamples,
    expManifest?.test,
    manifest?.testSamples?.[experiment.name],
    manifest?.test_runs?.[experiment.name],
    manifest?.infer?.[experiment.name],
  ];

  for (const candidate of candidates) {
    const samples = normalizeManifestSamples(candidate);

    if (samples.length > 0) {
      return samples;
    }

    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return Object.entries(candidate).map(([sampleName, files]) => ({
        sampleName,
        modelId: sampleName,
        files,
      }));
    }
  }

  return [];
}

function findRemoteTestSamplesForExperiment(manifest, experiment) {
  const results = [];

  for (const sample of getRemoteTestSampleEntries(manifest, experiment)) {
    const sampleName = String(sample.sampleName || sample.name || sample.modelId || "").trim();

    if (!sampleName) {
      continue;
    }

    const relDir = sample.relDir || joinRemoteUrl(experiment.name, sampleName);
    const sampleInfo = enrichSampleName(sampleName);
    const fileNames = getRemoteFileNames(sample);
    const gtFile =
      sample.gtFile ||
      sample.gt_file ||
      fileNames.find((name) => name.toLowerCase() === TEST_GT_NAME.toLowerCase()) ||
      null;
    const predFile =
      sample.predFile ||
      sample.pred_file ||
      findTestPredFile(new Map(fileNames.map((name) => [name.toLowerCase(), name]))) ||
      null;
    const makeUrl = (file) =>
      `/api/ply?mode=test&relDir=${encodeURIComponent(relDir)}&file=${encodeURIComponent(file)}`;

    results.push({
      mode: "test",
      nodeType: "sample",
      id: `test:${relDir}`,
      label: sampleInfo.modelId,
      relDir,
      experimentName: experiment.name,
      experimentLabel: experiment.label,
      hasGt: Boolean(gtFile),
      hasPred: Boolean(predFile),
      gtUrl: gtFile ? makeUrl(gtFile) : null,
      predUrl: predFile ? makeUrl(predFile) : null,
      shadowFrames: sample.shadowFrames || [],
      ...sampleInfo,
    });
  }

  return results.sort(compareSamples);
}

function compareSamples(a, b) {
  return (
    String(a.categoryNameZh).localeCompare(String(b.categoryNameZh), "zh-CN") ||
    String(a.modelId).localeCompare(String(b.modelId), "zh-CN")
  );
}

function makeGroupNode(nodeType, id, label, extra = {}) {
  return {
    nodeType,
    id,
    label,
    children: [],
    ...extra,
  };
}

function buildCategoryTree(samples) {
  const catMap = new Map();

  for (const sample of samples) {
    const catKey = sample.categoryId || "unknown";

    if (!catMap.has(catKey)) {
      catMap.set(
        catKey,
        makeGroupNode("category", `cat:${catKey}`, sample.categoryLabel, {
          categoryId: sample.categoryId,
          categoryNameEn: sample.categoryNameEn,
          categoryNameZh: sample.categoryNameZh,
          categoryCount: sample.categoryCount,
        })
      );
    }

    const catNode = catMap.get(catKey);
    catNode.children.push({
      nodeType: "sample",
      id: sample.id,
      label: sample.modelId,
      item: sample,
    });
  }

  const tree = Array.from(catMap.values());

  for (const catNode of tree) {
    catNode.children.sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
    catNode.count = catNode.children.length;
  }

  tree.sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));

  return tree;
}

function getSamplesByMode(mode, experiment) {
  return mode === "train"
    ? findTrainSamplesForExperiment(experiment)
    : findTestSamplesForExperiment(experiment);
}

async function getSamplesByModeAsync(mode, experiment) {
  if (!REMOTE_ENABLED) {
    return getSamplesByMode(mode, experiment);
  }

  const manifest = await loadRemoteManifest();

  return mode === "train"
    ? findRemoteTrainSamplesForExperiment(manifest, experiment)
    : findRemoteTestSamplesForExperiment(manifest, experiment);
}

async function getExperimentSummary() {
  const manifest = REMOTE_ENABLED ? await loadRemoteManifest() : null;

  const summarize = (mode, experiment) => {
    const trainSamples = mode === "train"
      ? REMOTE_ENABLED
        ? findRemoteTrainSamplesForExperiment(manifest, experiment)
        : findTrainSamplesForExperiment(experiment)
      : [];
    const testSamples = mode === "test"
      ? REMOTE_ENABLED
        ? findRemoteTestSamplesForExperiment(manifest, experiment)
        : findTestSamplesForExperiment(experiment)
      : [];

    return {
      name: experiment.name,
      label: experiment.label || experiment.name,
      trainCount: trainSamples.length,
      testCount: testSamples.length,
    };
  };

  const trainExperiments = TRAIN_EXPERIMENTS.map((experiment) => summarize("train", experiment));
  const testExperiments = TEST_EXPERIMENTS.map((experiment) => summarize("test", experiment));

  return {
    experiments: Array.from(
      new Map([...trainExperiments, ...testExperiments].map((exp) => [exp.name, exp])).values()
    ),
    trainExperiments,
    testExperiments,
  };
}

async function getDataByMode(mode, experimentName) {
  const experiment = getExperimentMeta(experimentName, mode);

  if (!experiment) {
    return {
      mode,
      experimentName,
      experimentLabel: experimentName,
      root: REMOTE_ENABLED ? REMOTE_ASSET_BASE_URL : mode === "train" ? TRAIN_RUNS_ROOT : PLY_ROOT,
      samples: [],
      tree: [],
    };
  }

  const samples = await getSamplesByModeAsync(mode, experiment);

  return {
    mode,
    experimentName: experiment.name,
    experimentLabel: experiment.label || experiment.name,
    root: REMOTE_ENABLED ? REMOTE_ASSET_BASE_URL : mode === "train" ? TRAIN_RUNS_ROOT : PLY_ROOT,
    samples,
    tree: buildCategoryTree(samples),
  };
}

function getPlyRootByMode(mode) {
  return mode === "train" ? TRAIN_RUNS_ROOT : PLY_ROOT;
}

function getRemotePlyUrl(mode, relDir, file) {
  return mode === "train"
    ? joinRemoteUrl(REMOTE_ASSET_BASE_URL, "train_runs", relDir, file)
    : joinRemoteUrl(REMOTE_ASSET_BASE_URL, "test_runs", relDir, file);
}

function isValidPlyFile(mode, file) {
  if (!file || path.basename(file) !== file) {
    return false;
  }

  const lower = file.toLowerCase();

  if (mode === "train") {
    return lower === TRAIN_GT_NAME.toLowerCase() || TRAIN_PRED_RE.test(file);
  }

  return lower === TEST_GT_NAME.toLowerCase() || TEST_PRED_NAMES.includes(lower);
}

function parseCsvValue(value) {
  const trimmed = String(value ?? "").trim();

  if (!trimmed) {
    return null;
  }

  const num = Number(trimmed);
  return Number.isFinite(num) ? num : trimmed;
}

function splitCsvLine(line) {
  return String(line)
    .split(",")
    .map((part) => part.trim());
}

function getCsvFiles() {
  return listDirSafe(CSV_DATA_ROOT)
    .filter((entry) => entry.isFile() && /\.csv$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function parseCsvFile(fileName) {
  const filePath = safeResolve(CSV_DATA_ROOT, fileName);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  const text = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "").trim();

  if (!text) {
    return {
      name: fileName,
      rowCount: 0,
      numericColumns: [],
      rows: [],
    };
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return {
      name: fileName,
      rowCount: 0,
      numericColumns: [],
      rows: [],
    };
  }

  const headers = splitCsvLine(lines[0]);
  const rows = [];
  const numericFlags = new Map(headers.map((header) => [header, true]));

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
    const values = splitCsvLine(lines[lineIndex]);
    const row = {};

    headers.forEach((header, index) => {
      const parsed = parseCsvValue(values[index]);
      row[header] = parsed;

      if (parsed !== null && !Number.isFinite(parsed)) {
        numericFlags.set(header, false);
      }
    });

    rows.push(row);
  }

  const numericColumns = headers.filter((header) => numericFlags.get(header));

  return {
    name: fileName,
    rowCount: rows.length,
    numericColumns,
    rows,
  };
}

function getCsvData() {
  const files = getCsvFiles()
    .map((fileName) => parseCsvFile(fileName))
    .filter(Boolean);

  const columns = Array.from(
    new Set(files.flatMap((file) => file.numericColumns || []))
  ).sort((a, b) => a.localeCompare(b, "en"));

  return {
    root: CSV_DATA_ROOT,
    fileCount: files.length,
    columns,
    files,
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    appConfig: APP_CONFIG_PATH,
    plyRoot: PLY_ROOT,
    datasetRoot: DATASET_ROOT,
    trainRunsRoot: TRAIN_RUNS_ROOT,
    categoryConfig: CATEGORY_CONFIG,
    remoteEnabled: REMOTE_ENABLED,
    remoteAssetBaseUrl: REMOTE_ASSET_BASE_URL,
    remoteManifestUrl: REMOTE_MANIFEST_URL,
    experiments: EXPERIMENTS,
    trainExperiments: TRAIN_EXPERIMENTS,
    testExperiments: TEST_EXPERIMENTS,
    fileConfig: FILE_CONFIG,
  });
});

app.get("/api/experiments", async (req, res) => {
  try {
    res.json(await getExperimentSummary());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/items", async (req, res) => {
  try {
    const mode = req.query.mode === "test" ? "test" : "train";
    const experiment = typeof req.query.experiment === "string" ? req.query.experiment : "";
    res.json(await getDataByMode(mode, experiment));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/csv-data", (req, res) => {
  try {
    res.json(getCsvData());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/ply", async (req, res) => {
  try {
    const mode = req.query.mode === "train" ? "train" : "test";
    const relDir = req.query.relDir;
    const file = req.query.file;

    if (!relDir || !file) {
      return res.status(400).json({ error: "Missing relDir or file" });
    }

    if (!isValidPlyFile(mode, file)) {
      return res.status(400).json({ error: "Invalid ply file" });
    }

    if (REMOTE_ENABLED) {
      const remoteUrl = getRemotePlyUrl(mode, relDir, file);
      const remoteRes = await fetch(remoteUrl);

      if (!remoteRes.ok) {
        return res.status(remoteRes.status).json({
          error: "Remote PLY not found",
          remoteUrl,
        });
      }

      res.setHeader("Content-Type", remoteRes.headers.get("content-type") || "application/octet-stream");
      res.setHeader("Cache-Control", "public, max-age=3600");

      const contentLength = remoteRes.headers.get("content-length");

      if (contentLength) {
        res.setHeader("Content-Length", contentLength);
      }

      return Readable.fromWeb(remoteRes.body).pipe(res);
    }

    const root = getPlyRootByMode(mode);
    const filePath = safeResolve(root, path.join(relDir, file));

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
      SHADOW_IMAGE_NAME
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

const server = app.listen(PORT, () => {
  console.log(`[INFO] API server running at http://localhost:${PORT}`);
});

server.on("close", () => {
  console.log("[INFO] API server closed");
});

server.on("error", (err) => {
  console.error("[ERROR] API server error:", err);
});
