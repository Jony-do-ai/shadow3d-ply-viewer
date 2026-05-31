import "./style.css";

import * as THREE from "three";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:3001";
const CSV_FILE_COLORS = [
  "#2563eb",
  "#dc2626",
  "#16a34a",
  "#d97706",
  "#7c3aed",
  "#0891b2",
  "#db2777",
  "#4f46e5",
];
const CSV_SERIES_DASHES = ["0", "7 5", "3 4", "12 5 3 5", "2 3"];
const CSV_VALUE_TRANSFORMS = {
  loss_apml: (value) => value * 0.001,
};
const CSV_GROUPS = [
  {
    key: "loss",
    label: "loss",
    columns: [
      "loss_cd",
      "loss_apml",
      "loss_p2g",
      "loss_g2p",
      "loss_center",
      "loss_bbox",
    ],
  },
  {
    key: "threshold",
    label: "阈值",
    columns: [
      "precision_0_01",
      "recall_0_01",
      "fscore_0_01",
      "precision_0_02",
      "recall_0_02",
      "fscore_0_02",
      "precision_0_05",
      "recall_0_05",
      "fscore_0_05",
    ],
  },
];

const experimentSelectEl = document.getElementById("experiment-select");
const experimentHintEl = document.getElementById("experiment-hint");
const sidebarTitleEl = document.getElementById("sidebar-title");
const itemListEl = document.getElementById("item-list");
const currentNameEl = document.getElementById("current-name");
const shadowGridEl = document.getElementById("shadow-grid");
const trainViewerGridEl = document.getElementById("train-viewer-grid");
const csvGroupSelectEl = document.getElementById("csv-group-select");
const csvChartTitleEl = document.getElementById("csv-chart-title");
const csvLegendEl = document.getElementById("csv-legend");
const csvPlotEl = document.getElementById("csv-plot");
const tabButtons = Array.from(document.querySelectorAll(".tab-button"));
const pages = {
  train: document.getElementById("train-page"),
  test: document.getElementById("test-page"),
  csv: document.getElementById("csv-page"),
};

const state = {
  mode: "train",
  experiment: "",
  experiments: [],
  experimentsByMode: {
    train: [],
    test: [],
  },
  experimentByMode: {
    train: "",
    test: "",
  },
  dataCache: new Map(),
  selectedId: new Map(),
  csv: {
    loaded: false,
    files: [],
    groupKey: "loss",
    enabledFiles: new Set(),
    selectedMetricsByGroup: new Map(),
  },
};

let trainViewers = [];
let requestSerial = 0;

function toAssetUrl(url) {
  if (!url) {
    return null;
  }

  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  return `${API_BASE}${url}`;
}

function dataKey(mode = state.mode, experiment = state.experiment) {
  return `${mode}::${experiment || ""}`;
}

function getSelectedId(mode = state.mode, experiment = state.experiment) {
  return state.selectedId.get(dataKey(mode, experiment)) || null;
}

function setSelectedId(id, mode = state.mode, experiment = state.experiment) {
  state.selectedId.set(dataKey(mode, experiment), id);
}

function resolveContainer(containerOrId) {
  if (typeof containerOrId === "string") {
    return document.getElementById(containerOrId);
  }

  return containerOrId;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function createViewer(containerOrId, pointColor) {
  const container = resolveContainer(containerOrId);

  if (!container) {
    throw new Error("Viewer container not found");
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf5f5f5);

  const camera = new THREE.PerspectiveCamera(
    45,
    Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1),
    0.001,
    1000
  );

  camera.position.set(0, 0.8, 2.5);

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
  });

  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1));
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
  scene.add(ambientLight);

  const gridHelper = new THREE.GridHelper(2, 20);
  scene.add(gridHelper);

  const axesHelper = new THREE.AxesHelper(0.6);
  scene.add(axesHelper);

  let pointObject = null;
  let disposed = false;

  function clear() {
    if (pointObject) {
      scene.remove(pointObject);

      if (pointObject.geometry) {
        pointObject.geometry.dispose();
      }

      if (pointObject.material) {
        pointObject.material.dispose();
      }

      pointObject = null;
    }

    render();
  }

  function fitCameraToObject(object) {
    const box = new THREE.Box3().setFromObject(object);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();

    box.getSize(size);
    box.getCenter(center);

    const maxDim = Math.max(size.x, size.y, size.z);

    if (!Number.isFinite(maxDim) || maxDim <= 0) {
      camera.position.set(0, 0.8, 2.5);
      controls.target.set(0, 0, 0);
      controls.update();
      render();
      return;
    }

    const distance = maxDim * 2.5;

    camera.position.set(center.x, center.y + distance * 0.35, center.z + distance);
    camera.near = Math.max(distance / 100, 0.001);
    camera.far = distance * 100;
    camera.updateProjectionMatrix();

    controls.target.copy(center);
    controls.update();
    render();
  }

  function loadPly(url) {
    clear();

    if (!url) {
      return;
    }

    const loader = new PLYLoader();

    loader.load(
      url,
      (geometry) => {
        if (disposed) {
          geometry.dispose();
          return;
        }

        geometry.computeBoundingBox();
        geometry.computeVertexNormals();

        const material = new THREE.PointsMaterial({
          size: 0.01,
          color: pointColor,
          sizeAttenuation: true,
        });

        pointObject = new THREE.Points(geometry, material);
        scene.add(pointObject);
        fitCameraToObject(pointObject);
      },
      undefined,
      (err) => {
        if (!disposed) {
          console.error("[PLY LOAD ERROR]", err);
        }
      }
    );
  }

  function resize() {
    if (disposed) {
      return;
    }

    const width = container.clientWidth;
    const height = container.clientHeight;

    if (width <= 0 || height <= 0) {
      return;
    }

    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    render();
  }

  function render() {
    if (!disposed) {
      renderer.render(scene, camera);
    }
  }

  function dispose() {
    controls.removeEventListener("change", render);
    window.removeEventListener("resize", resize);
    clear();
    disposed = true;
    controls.dispose();
    renderer.dispose();

    if (renderer.domElement && renderer.domElement.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
  }

  controls.addEventListener("change", render);
  window.addEventListener("resize", resize);
  render();

  return {
    loadPly,
    clear,
    resize,
    dispose,
  };
}

const gtViewer = createViewer("gt-viewer", 0x111111);
const predViewer = createViewer("pred-viewer", 0x0055ff);

async function fetchExperiments() {
  const res = await fetch(`${API_BASE}/api/experiments`);

  if (!res.ok) {
    throw new Error(`获取实验列表失败：${res.status}`);
  }

  const data = await res.json();
  const trainExperiments = data.trainExperiments || data.experiments || [];
  const testExperiments = data.testExperiments || data.experiments || [];

  return {
    experiments: data.experiments || [...trainExperiments, ...testExperiments],
    trainExperiments,
    testExperiments,
  };
}

async function fetchItems(mode, experiment) {
  const params = new URLSearchParams({
    mode,
    experiment: experiment || "",
  });

  const res = await fetch(`${API_BASE}/api/items?${params.toString()}`);

  if (!res.ok) {
    throw new Error(`获取${mode === "train" ? "训练集" : "测试集"}数据失败：${res.status}`);
  }

  return await res.json();
}

async function fetchCsvData() {
  const res = await fetch(`${API_BASE}/api/csv-data`);

  if (!res.ok) {
    throw new Error(`读取 CSV 数据失败：${res.status}`);
  }

  return await res.json();
}

function getCurrentData() {
  return state.dataCache.get(dataKey()) || null;
}

function flattenSamplesFromTree(tree) {
  const samples = [];

  function walk(nodes) {
    for (const node of nodes || []) {
      if (node.nodeType === "sample" && node.item) {
        samples.push(node.item);
      }

      if (node.children) {
        walk(node.children);
      }
    }
  }

  walk(tree);
  return samples;
}

function getModeExperiments(mode = state.mode) {
  if (mode === "test") {
    return state.experimentsByMode.test || [];
  }

  if (mode === "train") {
    return state.experimentsByMode.train || [];
  }

  return state.experiments || [];
}

function getExperimentMeta(name = state.experiment) {
  return getModeExperiments().find((exp) => exp.name === name) || {
    name,
    label: name || "未选择实验",
    trainCount: 0,
    testCount: 0,
  };
}

function getExperimentLabel(name = state.experiment) {
  return getExperimentMeta(name).label || name || "未选择实验";
}

function formatCurrentName(item) {
  if (!item) {
    return "当前：未选择";
  }

  const prefix = item.mode === "train" ? "训练集" : "测试集";
  const experimentLabel = item.experimentLabel || getExperimentLabel(item.experimentName);
  return `当前：${experimentLabel} / ${prefix} / ${item.categoryNameZh}（${item.categoryId}） / ${item.modelId}`;
}

function renderExperimentSelect() {
  experimentSelectEl.innerHTML = "";
  const experiments = getModeExperiments();

  if (experiments.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "未找到实验";
    experimentSelectEl.appendChild(option);
    experimentSelectEl.disabled = true;
    experimentHintEl.textContent = "请检查 config/app_config.json 中的 experiments 和 paths 配置。";
    return;
  }

  experimentSelectEl.disabled = false;

  for (const exp of experiments) {
    const option = document.createElement("option");
    option.value = exp.name;
    option.textContent = exp.label || exp.name;
    option.title = `目录：${exp.name}；训练：${exp.trainCount || 0}；测试：${exp.testCount || 0}`;
    experimentSelectEl.appendChild(option);
  }

  const rememberedExperiment = state.experimentByMode[state.mode];

  if (rememberedExperiment && experiments.some((exp) => exp.name === rememberedExperiment)) {
    state.experiment = rememberedExperiment;
  }

  if (!state.experiment || !experiments.some((exp) => exp.name === state.experiment)) {
    state.experiment = experiments[0].name;
  }

  state.experimentByMode[state.mode] = state.experiment;
  experimentSelectEl.value = state.experiment;
  updateExperimentHint();
}

function updateExperimentHint() {
  if (state.mode === "csv") {
    experimentHintEl.textContent = "CSV 页面会读取 public/data/train 下的文件，不依赖当前实验选择。";
    return;
  }

  if (!state.experiment) {
    experimentHintEl.textContent = "请先选择一个实验。";
    return;
  }

  const exp = getExperimentMeta(state.experiment);
  experimentHintEl.textContent = `当前实验：${exp.label || exp.name}（${exp.name}）。先选实验，再切换训练集或测试集。`;
}

function createCountBadge(count) {
  const badge = document.createElement("span");
  badge.className = "tree-count";
  badge.textContent = String(count ?? 0);
  return badge;
}

function renderTreeNode(node, level = 0) {
  if (node.nodeType === "sample") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tree-leaf";
    button.style.setProperty("--level", String(level));
    button.textContent = node.label;
    button.title = node.item?.sampleName || node.label;

    if (node.item?.id === getSelectedId()) {
      button.classList.add("active");
    }

    button.addEventListener("click", () => {
      selectItem(node.item.id);
    });

    return button;
  }

  const details = document.createElement("details");
  details.className = `tree-node tree-node-${node.nodeType}`;
  details.open = true;
  details.style.setProperty("--level", String(level));

  const summary = document.createElement("summary");
  summary.title = node.categoryNameEn
    ? `${node.categoryNameEn} / ${node.categoryNameZh} / ${node.categoryId}`
    : node.label;

  const label = document.createElement("span");
  label.className = "tree-label";
  label.textContent = node.label;

  summary.appendChild(label);
  summary.appendChild(createCountBadge(node.count));
  details.appendChild(summary);

  const children = document.createElement("div");
  children.className = "tree-children";

  for (const child of node.children || []) {
    children.appendChild(renderTreeNode(child, level + 1));
  }

  details.appendChild(children);
  return details;
}

function renderItemTree() {
  const data = getCurrentData();
  itemListEl.innerHTML = "";

  if (!state.experiment) {
    itemListEl.innerHTML = `<div class="empty">请先选择一个实验。</div>`;
    return;
  }

  if (!data || !data.tree || data.tree.length === 0) {
    itemListEl.innerHTML = `<div class="empty">${escapeHtml(getExperimentLabel())} 下未找到${state.mode === "train" ? "训练集" : "测试集"}样本。</div>`;
    return;
  }

  for (const node of data.tree) {
    itemListEl.appendChild(renderTreeNode(node));
  }
}

function getSelectedItemById(id) {
  const data = getCurrentData();
  const samples = flattenSamplesFromTree(data?.tree || []);
  return samples.find((item) => item.id === id) || null;
}

function disposeTrainViewers() {
  for (const viewer of trainViewers) {
    viewer.dispose();
  }

  trainViewers = [];
  trainViewerGridEl.innerHTML = "";
}

function selectFirstItem() {
  const data = getCurrentData();
  const samples = flattenSamplesFromTree(data?.tree || []);

  if (samples.length > 0) {
    selectItem(samples[0].id);
    return;
  }

  currentNameEl.textContent = `当前：${getExperimentLabel()} / 未找到${state.mode === "train" ? "训练集" : "测试集"}样本`;
  gtViewer.clear();
  predViewer.clear();
  disposeTrainViewers();
  shadowGridEl.innerHTML = "";
}

function renderShadowFrames(item) {
  shadowGridEl.innerHTML = "";

  if (!item.shadowFrames || item.shadowFrames.length === 0) {
    shadowGridEl.innerHTML = `
      <div class="empty">
        未找到阴影帧。<br />
        请检查 testDatasetRoot、shadowImageName 以及数据目录结构。
      </div>
    `;
    return;
  }

  item.shadowFrames.forEach((frame) => {
    const card = document.createElement("div");
    card.className = "shadow-card";

    const img = document.createElement("img");
    img.src = toAssetUrl(frame.url);
    img.alt = frame.frameName;
    img.loading = "lazy";

    const label = document.createElement("div");
    label.className = "shadow-label";
    label.textContent = frame.frameName;

    card.appendChild(img);
    card.appendChild(label);
    shadowGridEl.appendChild(card);
  });
}

function renderTestItem(item) {
  currentNameEl.textContent = formatCurrentName(item);
  gtViewer.loadPly(toAssetUrl(item.gtUrl));
  predViewer.loadPly(toAssetUrl(item.predUrl));
  renderShadowFrames(item);

  requestAnimationFrame(() => {
    gtViewer.resize();
    predViewer.resize();
  });
}

function createTrainPlyCard(file, index) {
  const card = document.createElement("section");
  card.className = `panel train-ply-card ${file.kind === "gt" ? "train-ply-card-gt" : "train-ply-card-pred"}`;

  const title = document.createElement("div");
  title.className = "panel-title train-ply-title";
  title.textContent = file.kind === "gt"
    ? `${String(index + 1).padStart(2, "0")}. GT：${file.label}`
    : `${String(index + 1).padStart(2, "0")}. Pred：${file.label}`;

  const viewerEl = document.createElement("div");
  viewerEl.className = "viewer train-card-viewer";

  card.appendChild(title);
  card.appendChild(viewerEl);
  trainViewerGridEl.appendChild(card);

  const color = file.kind === "gt" ? 0x111111 : 0x0055ff;
  const viewer = createViewer(viewerEl, color);
  viewer.loadPly(toAssetUrl(file.url));
  trainViewers.push(viewer);

  return viewer;
}

function renderTrainItem(item) {
  currentNameEl.textContent = formatCurrentName(item);
  disposeTrainViewers();

  if (!item.plyFiles || item.plyFiles.length === 0) {
    trainViewerGridEl.innerHTML = `<div class="empty">未找到训练过程 PLY 文件。</div>`;
    return;
  }

  const predFiles = item.plyFiles.filter((file) => file.kind === "pred");
  const gtFiles = item.plyFiles.filter((file) => file.kind === "gt");
  const orderedFiles = [...predFiles, ...gtFiles];

  for (let i = 0; i < orderedFiles.length; i++) {
    createTrainPlyCard(orderedFiles[i], i);
  }

  requestAnimationFrame(() => {
    for (const viewer of trainViewers) {
      viewer.resize();
    }
  });
}

function selectItem(id) {
  const item = getSelectedItemById(id);

  if (!item) {
    return;
  }

  setSelectedId(id);
  renderItemTree();

  if (state.mode === "train") {
    renderTrainItem(item);
  } else {
    renderTestItem(item);
  }
}

function ensureCsvDefaults(data) {
  state.csv.files = data.files || [];

  if (!state.csv.files.length) {
    state.csv.enabledFiles = new Set();
    state.csv.selectedMetricsByGroup = new Map();
    state.csv.groupKey = "loss";
    return;
  }

  if (!state.csv.enabledFiles.size) {
    state.csv.enabledFiles = new Set(state.csv.files.map((file) => file.name));
  }

  for (const group of CSV_GROUPS) {
    if (!state.csv.selectedMetricsByGroup.has(group.key)) {
      state.csv.selectedMetricsByGroup.set(group.key, new Set(group.columns));
    }
  }
}

function populateCsvGroupOptions() {
  csvGroupSelectEl.innerHTML = "";

  for (const group of CSV_GROUPS) {
    const option = document.createElement("option");
    option.value = group.key;
    option.textContent = group.label;
    csvGroupSelectEl.appendChild(option);
  }

  csvGroupSelectEl.value = state.csv.groupKey;
}

function toggleCsvFile(fileName, checked) {
  if (checked) {
    state.csv.enabledFiles.add(fileName);
  } else {
    state.csv.enabledFiles.delete(fileName);
  }

  renderCsvPage();
}

function getActiveCsvGroup() {
  return CSV_GROUPS.find((group) => group.key === state.csv.groupKey) || CSV_GROUPS[0];
}

function getActiveCsvMetrics() {
  return state.csv.selectedMetricsByGroup.get(state.csv.groupKey) || new Set();
}

function toggleCsvMetric(metric, checked) {
  if (!state.csv.selectedMetricsByGroup.has(state.csv.groupKey)) {
    state.csv.selectedMetricsByGroup.set(state.csv.groupKey, new Set());
  }

  const selected = state.csv.selectedMetricsByGroup.get(state.csv.groupKey);

  if (checked) {
    selected.add(metric);
  } else {
    selected.delete(metric);
  }

  renderCsvPage();
}

function renderCsvSidebar() {
  itemListEl.innerHTML = "";

  if (!state.csv.files.length) {
    itemListEl.innerHTML = `<div class="empty">public/data/train 下未找到 CSV 文件。</div>`;
    return;
  }

  state.csv.files.forEach((file, fileIndex) => {
    const details = document.createElement("details");
    details.className = "csv-file-node";
    details.open = true;

    const summary = document.createElement("summary");
    summary.className = "csv-file-summary";

    const left = document.createElement("div");
    left.className = "csv-file-heading";

    const fileCheckbox = document.createElement("input");
    fileCheckbox.type = "checkbox";
    fileCheckbox.checked = state.csv.enabledFiles.has(file.name);
    fileCheckbox.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    fileCheckbox.addEventListener("change", () => {
      toggleCsvFile(file.name, fileCheckbox.checked);
    });

    const colorSwatch = document.createElement("span");
    colorSwatch.className = "csv-file-color";
    colorSwatch.style.backgroundColor = CSV_FILE_COLORS[fileIndex % CSV_FILE_COLORS.length];

    const label = document.createElement("span");
    label.className = "csv-file-name";
    label.textContent = file.name;

    left.appendChild(fileCheckbox);
    left.appendChild(colorSwatch);
    left.appendChild(label);

    const meta = document.createElement("span");
    meta.className = "csv-file-meta";
    meta.textContent = `${file.rowCount} 行`;

    summary.appendChild(left);
    summary.appendChild(meta);
    details.appendChild(summary);

    itemListEl.appendChild(details);
  });

  const metricPanel = document.createElement("section");
  metricPanel.className = "csv-metric-panel";

  const metricTitle = document.createElement("div");
  metricTitle.className = "csv-metric-panel-title";
  metricTitle.textContent = `${getActiveCsvGroup().label} 参数`;
  metricPanel.appendChild(metricTitle);

  const metrics = document.createElement("div");
  metrics.className = "csv-metric-list";

  for (const metric of getActiveCsvGroup().columns) {
    const row = document.createElement("label");
    row.className = "csv-metric-item";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = getActiveCsvMetrics().has(metric);
    input.addEventListener("change", () => {
      toggleCsvMetric(metric, input.checked);
    });

    const name = document.createElement("span");
    name.textContent = metric;

    row.appendChild(input);
    row.appendChild(name);
    metrics.appendChild(row);
  }

  metricPanel.appendChild(metrics);
  itemListEl.appendChild(metricPanel);
}

function buildCsvSeries() {
  const activeGroup = getActiveCsvGroup();
  const activeMetrics = getActiveCsvMetrics();
  const series = [];

  state.csv.files.forEach((file, fileIndex) => {
    if (!state.csv.enabledFiles.has(file.name)) {
      return;
    }

    if (!activeMetrics.size) {
      return;
    }

    activeGroup.columns
      .filter((metric) => activeMetrics.has(metric))
      .forEach((metric, metricIndex) => {
        if (!file.numericColumns.includes("epoch") || !file.numericColumns.includes(metric)) {
          return;
        }

      const points = file.rows
        .map((row) => {
          const x = row.epoch;
          const rawY = row[metric];
          const transform = CSV_VALUE_TRANSFORMS[metric];
          const y = typeof transform === "function" ? transform(rawY) : rawY;

          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return null;
          }

          return { x, y };
        })
        .filter(Boolean);

      if (!points.length) {
        return;
      }

      series.push({
        fileName: file.name,
        metric,
        color: CSV_FILE_COLORS[fileIndex % CSV_FILE_COLORS.length],
        dash: CSV_SERIES_DASHES[metricIndex % CSV_SERIES_DASHES.length],
        points,
      });
      });
  });

  return series;
}

function formatNumberLabel(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  const abs = Math.abs(value);

  if ((abs > 0 && abs < 0.001) || abs >= 1000) {
    return value.toExponential(2);
  }

  if (abs >= 100) {
    return value.toFixed(1);
  }

  if (abs >= 1) {
    return value.toFixed(3).replace(/\.?0+$/, "");
  }

  return value.toFixed(5).replace(/\.?0+$/, "");
}

function renderCsvLegend(series) {
  csvLegendEl.innerHTML = "";

  if (!series.length) {
    const empty = document.createElement("div");
    empty.className = "csv-legend-empty";
    empty.textContent = "请至少选择一个文件和一个数值列。";
    csvLegendEl.appendChild(empty);
    return;
  }

  series.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "csv-legend-item";

    const swatch = document.createElement("span");
    swatch.className = "csv-legend-swatch";
    swatch.style.color = entry.color;
    swatch.style.borderStyle = entry.dash === "0" ? "solid" : "dashed";

    const text = document.createElement("span");
    text.textContent = `${entry.fileName} / ${entry.metric}`;

    item.appendChild(swatch);
    item.appendChild(text);
    csvLegendEl.appendChild(item);
  });
}

function renderCsvChart() {
  const series = buildCsvSeries();
  renderCsvLegend(series);

  if (!series.length) {
    csvChartTitleEl.textContent = "CSV 图表";
    csvPlotEl.innerHTML = `<div class="empty">当前没有可显示的数据曲线。</div>`;
    currentNameEl.textContent = "当前：请在左侧选择 CSV 文件和参数";
    return;
  }

  csvChartTitleEl.textContent = `CSV 图表（参数组：${getActiveCsvGroup().label}，X 轴：epoch）`;
  currentNameEl.textContent = `当前：已选择 ${series.length} 条曲线，来自 ${new Set(series.map((item) => item.fileName)).size} 个文件`;

  const allPoints = series.flatMap((item) => item.points);
  const xValues = allPoints.map((point) => point.x);
  const yValues = allPoints.map((point) => point.y);
  let minX = Math.min(...xValues);
  let maxX = Math.max(...xValues);
  let minY = Math.min(...yValues);
  let maxY = Math.max(...yValues);

  if (minX === maxX) {
    minX -= 1;
    maxX += 1;
  }

  if (minY === maxY) {
    const offset = minY === 0 ? 1 : Math.abs(minY) * 0.1;
    minY -= offset;
    maxY += offset;
  }

  const width = 960;
  const height = 520;
  const margin = { top: 24, right: 28, bottom: 52, left: 72 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;

  const scaleX = (value) => margin.left + ((value - minX) / (maxX - minX)) * plotWidth;
  const scaleY = (value) => margin.top + (1 - (value - minY) / (maxY - minY)) * plotHeight;

  const yTicks = 5;
  const xTicks = 6;
  const tickLines = [];
  const tickLabels = [];

  for (let i = 0; i <= yTicks; i++) {
    const value = minY + ((maxY - minY) * i) / yTicks;
    const y = scaleY(value);
    tickLines.push(`<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" class="csv-grid-line" />`);
    tickLabels.push(`<text x="${margin.left - 10}" y="${y + 4}" text-anchor="end" class="csv-axis-label">${escapeHtml(formatNumberLabel(value))}</text>`);
  }

  for (let i = 0; i <= xTicks; i++) {
    const value = minX + ((maxX - minX) * i) / xTicks;
    const x = scaleX(value);
    tickLines.push(`<line x1="${x}" y1="${margin.top}" x2="${x}" y2="${height - margin.bottom}" class="csv-grid-line csv-grid-line-vertical" />`);
    tickLabels.push(`<text x="${x}" y="${height - margin.bottom + 22}" text-anchor="middle" class="csv-axis-label">${escapeHtml(formatNumberLabel(value))}</text>`);
  }

  const paths = series.map((entry) => {
    const d = entry.points
      .map((point, index) => `${index === 0 ? "M" : "L"} ${scaleX(point.x).toFixed(2)} ${scaleY(point.y).toFixed(2)}`)
      .join(" ");

    return `<path d="${d}" fill="none" stroke="${entry.color}" stroke-width="2.5" stroke-dasharray="${entry.dash}" class="csv-series-path">
      <title>${escapeHtml(`${entry.fileName} / ${entry.metric}`)}</title>
    </path>`;
  });

  csvPlotEl.innerHTML = `
    <svg class="csv-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="CSV line chart">
      <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"></rect>
      ${tickLines.join("")}
      <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" class="csv-axis-line" />
      <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" class="csv-axis-line" />
      ${tickLabels.join("")}
      <text x="${width / 2}" y="${height - 12}" text-anchor="middle" class="csv-axis-title">epoch</text>
      <text x="18" y="${height / 2}" text-anchor="middle" transform="rotate(-90 18 ${height / 2})" class="csv-axis-title">数值</text>
      ${paths.join("")}
    </svg>
  `;
}

function renderCsvPage() {
  renderCsvSidebar();
  renderCsvChart();
}

async function loadCsvPage() {
  setPageVisibility("csv");
  updateExperimentHint();

  if (!state.csv.loaded) {
    currentNameEl.textContent = "当前：正在读取 CSV 文件...";
    itemListEl.innerHTML = `<div class="empty">正在读取 CSV 文件...</div>`;

    const data = await fetchCsvData();
    state.csv.loaded = true;
    ensureCsvDefaults(data);
    populateCsvGroupOptions();
  }

  renderCsvPage();
}

function setPageVisibility(mode) {
  for (const button of tabButtons) {
    button.classList.toggle("active", button.dataset.mode === mode);
  }

  for (const [pageMode, pageEl] of Object.entries(pages)) {
    pageEl.classList.toggle("active", pageMode === mode);
  }

  if (mode === "csv") {
    sidebarTitleEl.textContent = "CSV 文件";
    return;
  }

  sidebarTitleEl.textContent = `${getExperimentLabel()} / ${mode === "train" ? "训练集目录" : "测试集目录"}`;
}

async function loadSamplePage() {
  const serial = ++requestSerial;
  setPageVisibility(state.mode);
  updateExperimentHint();

  if (!state.experiment) {
    currentNameEl.textContent = "当前：未选择实验";
    itemListEl.innerHTML = `<div class="empty">请先选择一个实验。</div>`;
    return;
  }

  try {
    currentNameEl.textContent = `当前：${getExperimentLabel()} / 正在加载...`;
    itemListEl.innerHTML = `<div class="empty">正在读取目录树...</div>`;

    const key = dataKey();

    if (!state.dataCache.has(key)) {
      state.dataCache.set(key, await fetchItems(state.mode, state.experiment));
    }

    if (serial !== requestSerial) {
      return;
    }

    renderItemTree();

    const selectedId = getSelectedId();

    if (selectedId && getSelectedItemById(selectedId)) {
      selectItem(selectedId);
    } else {
      selectFirstItem();
    }
  } catch (err) {
    console.error(err);
    currentNameEl.textContent = "当前：加载失败";
    itemListEl.innerHTML = `<div class="empty">加载失败：${escapeHtml(err.message)}</div>`;
  }
}

async function loadCurrentPage() {
  if (state.mode === "csv") {
    try {
      await loadCsvPage();
    } catch (err) {
      console.error(err);
      currentNameEl.textContent = "当前：CSV 加载失败";
      itemListEl.innerHTML = `<div class="empty">加载失败：${escapeHtml(err.message)}</div>`;
      csvPlotEl.innerHTML = "";
      csvLegendEl.innerHTML = "";
    }

    return;
  }

  await loadSamplePage();
}

function switchMode(mode) {
  state.mode = mode;

  if (mode !== "train") {
    disposeTrainViewers();
  }

  renderExperimentSelect();
  loadCurrentPage();
}

for (const button of tabButtons) {
  button.addEventListener("click", () => {
    switchMode(button.dataset.mode);
  });
}

experimentSelectEl.addEventListener("change", () => {
  state.experiment = experimentSelectEl.value;
  state.experimentByMode[state.mode] = state.experiment;

  if (state.mode !== "csv") {
    loadCurrentPage();
  } else {
    updateExperimentHint();
    setPageVisibility("csv");
  }
});

csvGroupSelectEl.addEventListener("change", () => {
  state.csv.groupKey = csvGroupSelectEl.value;
  renderCsvPage();
});

async function init() {
  try {
    currentNameEl.textContent = "当前：正在读取实验...";
    itemListEl.innerHTML = `<div class="empty">正在读取实验...</div>`;

    const experimentData = await fetchExperiments();
    state.experiments = experimentData.experiments || [];
    state.experimentsByMode.train = experimentData.trainExperiments || [];
    state.experimentsByMode.test = experimentData.testExperiments || [];
    renderExperimentSelect();
    await loadCurrentPage();
  } catch (err) {
    console.error(err);
    currentNameEl.textContent = "当前：加载失败";
    itemListEl.innerHTML = `<div class="empty">加载失败：${escapeHtml(err.message)}</div>`;
  }
}

init();
