import "./style.css";

import * as THREE from "three";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const API_BASE = "http://localhost:3001";

const itemListEl = document.getElementById("item-list");
const currentNameEl = document.getElementById("current-name");
const shadowGridEl = document.getElementById("shadow-grid");

let items = [];
let currentIndex = -1;

function createViewer(containerId, pointColor) {
  const container = document.getElementById(containerId);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf5f5f5);

  const camera = new THREE.PerspectiveCamera(
    45,
    container.clientWidth / container.clientHeight,
    0.001,
    1000
  );

  camera.position.set(0, 0.8, 2.5);

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
  });

  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(container.clientWidth, container.clientHeight);
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

    camera.position.set(
      center.x,
      center.y + distance * 0.35,
      center.z + distance
    );

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
        console.error("[PLY LOAD ERROR]", err);
      }
    );
  }

  function resize() {
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
    renderer.render(scene, camera);
  }

  controls.addEventListener("change", render);

  window.addEventListener("resize", resize);

  render();

  return {
    loadPly,
    clear,
    resize,
  };
}

const gtViewer = createViewer("gt-viewer", 0x111111);
const predViewer = createViewer("pred-viewer", 0x0055ff);

async function fetchItems() {
  const res = await fetch(`${API_BASE}/api/items`);

  if (!res.ok) {
    throw new Error(`获取目录失败: ${res.status}`);
  }

  const data = await res.json();
  return data.items || [];
}

function renderItemList() {
  itemListEl.innerHTML = "";

  if (items.length === 0) {
    itemListEl.innerHTML = `<div class="empty">没有找到 PLY 目录</div>`;
    return;
  }

  items.forEach((item, index) => {
    const button = document.createElement("button");
    button.className = "item-button";
    button.textContent = item.name;
    button.title = item.name;

    if (index === currentIndex) {
      button.classList.add("active");
    }

    button.addEventListener("click", () => {
      selectItem(index);
    });

    itemListEl.appendChild(button);
  });
}

function renderShadowFrames(item) {
  shadowGridEl.innerHTML = "";

  if (!item.shadowFrames || item.shadowFrames.length === 0) {
    shadowGridEl.innerHTML = `
      <div class="empty">
        没有找到阴影图。<br />
        请检查：data/train_runs/dataset/类别ID/模型ID/frame_000/rgb_with_shadow.png
      </div>
    `;
    return;
  }

  item.shadowFrames.forEach((frame) => {
    const card = document.createElement("div");
    card.className = "shadow-card";

    const img = document.createElement("img");
    img.src = `${API_BASE}${frame.url}`;
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

function selectItem(index) {
  const item = items[index];

  if (!item) {
    return;
  }

  currentIndex = index;

  currentNameEl.textContent = `当前：${item.name}`;

  gtViewer.loadPly(item.gtUrl ? `${API_BASE}${item.gtUrl}` : null);
  predViewer.loadPly(item.predUrl ? `${API_BASE}${item.predUrl}` : null);

  renderShadowFrames(item);

  renderItemList();

  requestAnimationFrame(() => {
    gtViewer.resize();
    predViewer.resize();
  });
}

async function init() {
  try {
    currentNameEl.textContent = "当前：加载中...";

    items = await fetchItems();

    renderItemList();

    if (items.length > 0) {
      selectItem(0);
    } else {
      currentNameEl.textContent = "当前：未找到样本";
    }
  } catch (err) {
    console.error(err);
    currentNameEl.textContent = "当前：加载失败";
    itemListEl.innerHTML = `<div class="empty">加载失败：${err.message}</div>`;
  }
}

init();