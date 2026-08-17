import type { ElementHandle, Page } from 'puppeteer-core';
import { TOLLAN_SKILL_FINGERPRINTS, tollanSkillPriority } from './skill-fingerprints.js';
import { TOLLAN_CHEST_FINGERPRINTS } from './world-fingerprints.js';

export interface TollanCanvasTarget {
  xRatio: number;
  yRatio: number;
  score: number;
}

export interface TollanGameplayGuidance {
  mode: 'retreat' | 'escape' | 'collect' | 'explore';
  directionX: number;
  directionY: number;
  dangerScore: number;
  enemyCount: number;
  playerXRatio: number;
  playerYRatio: number;
  healthRatio?: number;
  pickupKind?: 'chest' | 'crystal';
  pickupDistance?: number;
  pickupSource?: 'template' | 'colour';
  pickupXRatio?: number;
  pickupYRatio?: number;
  pickupMatchError?: number;
  pickupCorrelation?: number;
  interact: boolean;
  dash: boolean;
  boundaryStrength: number;
  detectedChests: number;
  detectedCrystals: number;
}

export interface TollanCanvasAnalysis {
  screen: 'brightness' | 'main_menu' | 'subclass' | 'choice' | 'game_over' | 'gameplay' | 'unknown';
  subclassSelected?: boolean;
  resumeLikely?: boolean;
  actionTarget?: TollanCanvasTarget;
  menuTarget?: TollanCanvasTarget;
  choiceTarget?: TollanCanvasTarget;
  choiceScores?: number[];
  choiceNames?: (string | null)[];
  choiceMatchErrors?: (number | null)[];
  choiceLikely: boolean;
  subclassLayout?: TollanSubclassLayoutSignals;
  gameplay?: TollanGameplayGuidance;
  activeRightRatio: number;
  activeBottomRatio: number;
}

export interface TollanSubclassLayoutSignals {
  leftLitRatio: number;
  rightLitRatio: number;
  rightDarkRatio: number;
}

export interface TollanScreenSignals {
  gameOver: boolean;
  subclass: boolean;
  mainMenu: boolean;
  brightness: boolean;
  choice: boolean;
  gameplay: boolean;
}

export interface TollanCanvasComponent extends TollanCanvasTarget {
  widthRatio: number;
  heightRatio: number;
  density: number;
}

const EMPTY_ANALYSIS: TollanCanvasAnalysis = {
  screen: 'unknown',
  choiceLikely: false,
  activeRightRatio: 1,
  activeBottomRatio: 1,
};

const CHOICE_X_RATIOS = [0.17, 0.5, 0.82] as const;
const RESUME_TEXT_WHITE_THRESHOLD = 0.065;
const SUBCLASS_LEFT_LIT_THRESHOLD = 0.06;
const SUBCLASS_RIGHT_LIT_THRESHOLD = 0.012;
const SUBCLASS_RIGHT_DARK_THRESHOLD = 0.92;

export function tollanSubclassLayoutLikely(signals: TollanSubclassLayoutSignals): boolean {
  return (
    signals.leftLitRatio > SUBCLASS_LEFT_LIT_THRESHOLD &&
    signals.rightLitRatio < SUBCLASS_RIGHT_LIT_THRESHOLD &&
    signals.rightDarkRatio > SUBCLASS_RIGHT_DARK_THRESHOLD
  );
}

export function tollanScreenFromSignals(
  signals: TollanScreenSignals,
): TollanCanvasAnalysis['screen'] {
  if (signals.gameOver) return 'game_over';
  if (signals.subclass) return 'subclass';
  if (signals.mainMenu) return 'main_menu';
  if (signals.brightness) return 'brightness';
  if (signals.choice) return 'choice';
  if (signals.gameplay) return 'gameplay';
  return 'unknown';
}

export function preferredTollanMainMenuTarget(
  alignedMenu: readonly TollanCanvasComponent[],
): TollanCanvasComponent | undefined {
  return [...alignedMenu]
    .filter(
      (component) =>
        component.yRatio >= 0.35 && component.yRatio <= 0.5 && component.widthRatio >= 0.08,
    )
    .sort(
      (left, right) =>
        Math.abs(left.yRatio - 0.42) - Math.abs(right.yRatio - 0.42) || right.score - left.score,
    )[0];
}

export function tollanResumeOverlayLikely(
  screen: TollanCanvasAnalysis['screen'],
  whitePixelRatio: number,
): boolean {
  return (
    (screen === 'gameplay' || screen === 'choice' || screen === 'unknown') &&
    whitePixelRatio > RESUME_TEXT_WHITE_THRESHOLD
  );
}

export function preferredTollanChoice(scores: readonly number[]): TollanCanvasTarget {
  const order = [1, 0, 2];
  let selected = order[0]!;
  for (const index of order.slice(1)) {
    if ((scores[index] ?? 0) > (scores[selected] ?? 0)) selected = index;
  }
  return {
    xRatio: CHOICE_X_RATIOS[selected]!,
    yRatio: 0.54,
    score: scores[selected] ?? 0,
  };
}

const SKILL_FINGERPRINTS = TOLLAN_SKILL_FINGERPRINTS.map((fingerprint) => ({
  ...fingerprint,
  priority: tollanSkillPriority(fingerprint.name),
}));

function analysisSource(encoded: string): string {
  const skillFingerprints = JSON.stringify(SKILL_FINGERPRINTS);
  const chestFingerprints = JSON.stringify(TOLLAN_CHEST_FINGERPRINTS);
  const selectMainMenuTarget = preferredTollanMainMenuTarget.toString();
  const classifyScreen = tollanScreenFromSignals.toString();
  return `(async () => {
    const image = new Image();
    image.src = 'data:image/png;base64,${encoded}';
    await image.decode();
    const scale = Math.min(1, 480 / image.naturalWidth);
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    const litColumns = new Uint32Array(width);
    const litRows = new Uint32Array(height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = (y * width + x) * 4;
        if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 54) {
          litColumns[x]++;
          litRows[y]++;
        }
      }
    }
    let activeRight = width - 1;
    for (let x = width - 1; x >= 0; x--) {
      if (litColumns[x] > height * 0.035) {
        activeRight = x;
        break;
      }
    }
    let activeBottom = height - 1;
    for (let y = height - 1; y >= 0; y--) {
      if (litRows[y] > width * 0.035) {
        activeBottom = y;
        break;
      }
    }

    const actionMask = new Uint8Array(width * height);
    const continueMask = new Uint8Array(width * height);
    const cyanMask = new Uint8Array(width * height);
    const enemyMask = new Uint8Array(width * height);
    const crystalMask = new Uint8Array(width * height);
    const playerHealthMask = new Uint8Array(width * height);
    let dark = 0;
    let central = 0;
    let resumeWhitePixels = 0;
    let resumeRegionPixels = 0;
    let subclassLeftPixels = 0;
    let subclassLeftLitPixels = 0;
    let subclassRightPixels = 0;
    let subclassRightLitPixels = 0;
    let subclassRightDarkPixels = 0;
    const fallbackChoiceScores = [0, 0, 0];
    const minX = Math.floor(activeRight * 0.38);
    const maxX = Math.min(width - 1, Math.ceil(activeRight * 0.98));
    const minY = Math.floor(activeBottom * 0.42);
    const maxY = Math.min(height - 1, Math.ceil(activeBottom * 0.94));
    const actionMinX = Math.floor(activeRight * 0.48);
    const actionMinY = Math.floor(activeBottom * 0.7);
    const worldMinY = Math.floor(activeBottom * 0.14);
    const worldMaxY = Math.floor(activeBottom * 0.93);

    for (let y = 0; y <= activeBottom; y++) {
      for (let x = 0; x <= activeRight; x++) {
        const pixel = y * width + x;
        const index = pixel * 4;
        const r = pixels[index];
        const g = pixels[index + 1];
        const b = pixels[index + 2];
        const cyanPixel = g > 58 && b > 66 && b - r > 16 && g - r > 5 && g + b > r * 2.35;
        if (cyanPixel) cyanMask[pixel] = 1;
        if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
          central++;
          if (Math.max(r, g, b) < 52) dark++;
        }
        const activeXRatio = x / Math.max(1, activeRight);
        const activeYRatio = y / Math.max(1, activeBottom);
        const maxChannel = Math.max(r, g, b);
        if (activeYRatio >= 0.24 && activeYRatio <= 0.78) {
          if (activeXRatio >= 0.15 && activeXRatio <= 0.5) {
            subclassLeftPixels++;
            if (maxChannel > 60) subclassLeftLitPixels++;
          } else if (activeXRatio >= 0.52 && activeXRatio <= 0.84) {
            subclassRightPixels++;
            if (maxChannel > 60) subclassRightLitPixels++;
            if (maxChannel < 48) subclassRightDarkPixels++;
          }
        }
        if (
          activeXRatio >= 0.27 && activeXRatio <= 0.73 &&
          activeYRatio >= 0.4 && activeYRatio <= 0.49
        ) {
          resumeRegionPixels++;
          if (Math.min(r, g, b) > 155 && Math.max(r, g, b) - Math.min(r, g, b) < 34) {
            resumeWhitePixels++;
          }
        }
        if (activeYRatio >= 0.2 && activeYRatio <= 0.43) {
          for (let choice = 0; choice < 3; choice++) {
            const center = [0.17, 0.5, 0.82][choice];
            if (Math.abs(activeXRatio - center) > 0.075 || Math.max(r, g, b) <= 64) continue;
            if (r > g + 24 && r > b + 14) fallbackChoiceScores[choice] += 2.8;
            else if (b > r + 24 && g > r + 8) fallbackChoiceScores[choice] += 2.35;
            else if (r > g + 20 && b > g + 8) fallbackChoiceScores[choice] += 2.15;
            else if (g > r + 18 && g > b + 4) fallbackChoiceScores[choice] += 2.05;
            else if (b > r + 18) fallbackChoiceScores[choice] += 1.8;
          }
        }
        const green =
          x >= actionMinX && x <= maxX && y >= actionMinY && y <= maxY &&
          g > 62 && g - r > 22 && g - b > 12 && g > r * 1.32;
        if (green) actionMask[pixel] = 1;
        const continueButton =
          activeXRatio >= 0.3 && activeXRatio <= 0.7 &&
          activeYRatio >= 0.53 && activeYRatio <= 0.76 &&
          r > 62 && r - g > 34 && r - b > 18 && g < 78;
        if (continueButton) continueMask[pixel] = 1;

        if (y >= worldMinY && y <= worldMaxY) {
          const purpleBar =
            b > 58 && r > 34 && b - g > 24 && r - g > 12 && b > r * 1.08;
          if (purpleBar) enemyMask[pixel] = 1;
          const crystal =
            (b > 108 && g > 72 && b - r > 30 && b > g * 1.06 && g > r * 1.05) ||
            (b > 150 && g > 118 && r > 62 && b - r > 24 && g - r > 8);
          if (crystal) crystalMask[pixel] = 1;
          const playerHealth =
            r > 105 && g > 38 && b > 45 && r - g > 38 && r - b > 24 && b > g * 0.72;
          if (playerHealth) playerHealthMask[pixel] = 1;
        }
      }
    }

    const collectComponents = (mask, leftBound, rightBound, topBound, bottomBound, options) => {
      const visited = new Uint8Array(mask.length);
      const components = [];
      const queue = new Int32Array(mask.length);
      for (let y = topBound; y <= bottomBound; y++) {
        for (let x = leftBound; x <= rightBound; x++) {
          const seed = y * width + x;
          if (!mask[seed] || visited[seed]) continue;
          let head = 0;
          let tail = 0;
          queue[tail++] = seed;
          visited[seed] = 1;
          let count = 0;
          let left = x;
          let right = x;
          let top = y;
          let bottom = y;
          while (head < tail) {
            const current = queue[head++];
            const cy = Math.floor(current / width);
            const cx = current - cy * width;
            count++;
            left = Math.min(left, cx);
            right = Math.max(right, cx);
            top = Math.min(top, cy);
            bottom = Math.max(bottom, cy);
            for (let oy = -1; oy <= 1; oy++) {
              for (let ox = -1; ox <= 1; ox++) {
                if (ox === 0 && oy === 0) continue;
                const nx = cx + ox;
                const ny = cy + oy;
                if (nx < leftBound || nx > rightBound || ny < topBound || ny > bottomBound) continue;
                const next = ny * width + nx;
                if (!mask[next] || visited[next]) continue;
                visited[next] = 1;
                queue[tail++] = next;
              }
            }
          }
          const componentWidth = right - left + 1;
          const componentHeight = bottom - top + 1;
          const ratio = componentWidth / Math.max(1, componentHeight);
          if (
            count >= options.minCount &&
            componentWidth >= width * options.minWidth &&
            componentWidth <= width * options.maxWidth &&
            componentHeight >= height * options.minHeight &&
            componentHeight <= height * options.maxHeight &&
            ratio >= options.minRatio &&
            ratio <= (options.maxRatio || Number.POSITIVE_INFINITY)
          ) {
            const centerX = (left + right) / 2;
            const centerY = (top + bottom) / 2;
            const density = count / (componentWidth * componentHeight);
            components.push({
              xRatio: centerX / Math.max(1, activeRight),
              yRatio: centerY / Math.max(1, activeBottom),
              widthRatio: componentWidth / width,
              heightRatio: componentHeight / height,
              density,
              score: count * (0.7 + density),
            });
          }
        }
      }
      components.sort((left, right) => right.score - left.score);
      return components;
    };

    const actionComponents = collectComponents(
      actionMask, actionMinX, maxX, actionMinY, maxY,
      { minCount: 14, minWidth: 0.018, maxWidth: 0.28, minHeight: 0.006, maxHeight: 0.13, minRatio: 1.4 },
    );
    const continueComponents = collectComponents(
      continueMask, Math.floor(activeRight * 0.3), Math.floor(activeRight * 0.7),
      Math.floor(activeBottom * 0.53), Math.floor(activeBottom * 0.76),
      { minCount: 20, minWidth: 0.065, maxWidth: 0.34, minHeight: 0.012, maxHeight: 0.12, minRatio: 1.8 },
    );
    const cyanComponents = collectComponents(
      cyanMask, 0, activeRight, 0, activeBottom,
      { minCount: 8, minWidth: 0.012, maxWidth: 0.46, minHeight: 0.004, maxHeight: 0.18, minRatio: 1.05 },
    );
    const enemyComponents = collectComponents(
      enemyMask, 0, activeRight, worldMinY, worldMaxY,
      { minCount: 3, minWidth: 0.009, maxWidth: 0.09, minHeight: 0.001, maxHeight: 0.018, minRatio: 2.4 },
    );
    const crystalComponents = collectComponents(
      crystalMask, 0, activeRight, worldMinY, worldMaxY,
      { minCount: 3, minWidth: 0.0025, maxWidth: 0.045, minHeight: 0.003, maxHeight: 0.07, minRatio: 0.18, maxRatio: 2.7 },
    );
    const playerHealthComponents = collectComponents(
      playerHealthMask, 0, activeRight, worldMinY, worldMaxY,
      { minCount: 4, minWidth: 0.006, maxWidth: 0.13, minHeight: 0.001, maxHeight: 0.018, minRatio: 2.8 },
    );
    const leftMenu = cyanComponents
      .filter((component) =>
        component.xRatio >= 0.08 && component.xRatio <= 0.38 &&
        component.yRatio >= 0.18 && component.yRatio <= 0.84 &&
        component.widthRatio >= 0.045)
      .sort((left, right) => left.yRatio - right.yRatio);
    const alignedMenu = leftMenu.filter((component) =>
      leftMenu.filter((candidate) => Math.abs(candidate.xRatio - component.xRatio) < 0.075).length >= 3,
    );
    const mainMenuTarget = (${selectMainMenuTarget})(alignedMenu);
    const brightnessTarget = cyanComponents
      .filter((component) =>
        component.xRatio >= 0.34 && component.xRatio <= 0.66 &&
        component.yRatio >= 0.66 && component.yRatio <= 0.9 &&
        component.widthRatio >= 0.055)
      .sort((left, right) => right.score - left.score)[0];
    const gameOverTarget = continueComponents
      .filter((component) =>
        component.xRatio >= 0.34 && component.xRatio <= 0.66 &&
        component.yRatio >= 0.55 && component.yRatio <= 0.73 &&
        component.widthRatio >= 0.075)
      .sort((left, right) => right.score - left.score)[0];

    const rawFingerprints = ${skillFingerprints};
    const fingerprints = rawFingerprints.map((fingerprint) => {
      const binary = atob(fingerprint.rgb);
      const rgb = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) rgb[index] = binary.charCodeAt(index);
      return { name: fingerprint.name, priority: fingerprint.priority, rgb };
    });
    const sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = 8;
    sampleCanvas.height = 8;
    const sampleContext = sampleCanvas.getContext('2d', { willReadFrequently: true });
    const identifyChoice = (xRatio) => {
      if (!sampleContext) return null;
      let best = null;
      const sourceActiveRight = image.naturalWidth * (activeRight / width);
      const sourceActiveBottom = image.naturalHeight * (activeBottom / height);
      const centerX = sourceActiveRight * xRatio;
      const centerY = sourceActiveBottom * 0.225;
      const baseSize = sourceActiveRight * 0.036;
      for (const sizeScale of [0.86, 0.94, 1.02, 1.1]) {
        const size = baseSize * sizeScale;
        for (const offsetX of [-0.014, -0.009, -0.004, 0, 0.004, 0.009, 0.014]) {
          for (const offsetY of [-0.004, 0.002, 0.008, 0.014]) {
            sampleContext.clearRect(0, 0, 8, 8);
            sampleContext.imageSmoothingEnabled = true;
            sampleContext.imageSmoothingQuality = 'high';
            sampleContext.drawImage(
              image,
              Math.round(centerX - size / 2 + sourceActiveRight * offsetX),
              Math.round(centerY - size / 2 + sourceActiveBottom * offsetY),
              size,
              size,
              0,
              0,
              8,
              8,
            );
            const sample = sampleContext.getImageData(0, 0, 8, 8).data;
            for (const fingerprint of fingerprints) {
              let difference = 0;
              for (let pixel = 0; pixel < 64; pixel++) {
                const source = pixel * 4;
                const target = pixel * 3;
                difference += Math.abs(sample[source] - fingerprint.rgb[target]);
                difference += Math.abs(sample[source + 1] - fingerprint.rgb[target + 1]);
                difference += Math.abs(sample[source + 2] - fingerprint.rgb[target + 2]);
              }
              const error = difference / (64 * 3 * 255);
              if (!best || error < best.error) best = { name: fingerprint.name, priority: fingerprint.priority, error };
            }
          }
        }
      }
      return best && best.error <= 0.108 ? best : null;
    };
    const skillMatches = [0.18, 0.5, 0.81].map(identifyChoice);
    const recognizedChoices = skillMatches.filter(Boolean).length;
    const recognizedSkillNames = new Set(
      skillMatches.filter(Boolean).map((match) => match.name),
    );
    const choiceScores = fallbackChoiceScores.map((score, index) => {
      const match = skillMatches[index];
      return match ? match.priority + Math.max(0, 0.16 - match.error) * 100 : score;
    });
    const choiceColumns = fallbackChoiceScores.filter((score) => score > 220).length;
    const strongChoice = recognizedChoices >= 2 && recognizedSkillNames.size >= 2;
    const subclassStartTarget = actionComponents
      .filter((component) =>
        component.xRatio >= 0.68 && component.xRatio <= 0.92 &&
        component.yRatio >= 0.7 && component.yRatio <= 0.94 &&
        component.widthRatio >= 0.08)
      .sort((left, right) => right.score - left.score)[0];
    const subclassLayout = {
      leftLitRatio: subclassLeftLitPixels / Math.max(1, subclassLeftPixels),
      rightLitRatio: subclassRightLitPixels / Math.max(1, subclassRightPixels),
      rightDarkRatio: subclassRightDarkPixels / Math.max(1, subclassRightPixels),
    };
    const subclassPanelLikely =
      subclassLayout.leftLitRatio > ${SUBCLASS_LEFT_LIT_THRESHOLD} &&
      subclassLayout.rightLitRatio < ${SUBCLASS_RIGHT_LIT_THRESHOLD} &&
      subclassLayout.rightDarkRatio > ${SUBCLASS_RIGHT_DARK_THRESHOLD};
    const subclassLikely =
      !gameOverTarget &&
      !mainMenuTarget &&
      !brightnessTarget &&
      (subclassPanelLikely ||
        (recognizedChoices === 0 &&
          fallbackChoiceScores[0] > 350 &&
          fallbackChoiceScores[2] < 120 &&
          (fallbackChoiceScores[0] > fallbackChoiceScores[1] * 2.4 ||
            Boolean(subclassStartTarget))));
    const structuralChoice = central > 0 && dark / central > 0.42 && choiceColumns >= 2;
    const choiceLikely =
      !gameOverTarget &&
      !subclassLikely &&
      !mainMenuTarget &&
      !brightnessTarget &&
      (strongChoice || structuralChoice);
    const screen = (${classifyScreen})({
      gameOver: Boolean(gameOverTarget),
      subclass: subclassLikely,
      mainMenu: Boolean(mainMenuTarget),
      brightness: Boolean(brightnessTarget) && central > 0 && dark / central > 0.54,
      choice: choiceLikely,
      gameplay: litRows.some((count) => count > width * 0.12),
    });
    const resumeWhiteRatio = resumeRegionPixels > 0
      ? resumeWhitePixels / resumeRegionPixels
      : 0;
    const resumeLikely =
      (screen === 'gameplay' || screen === 'choice' || screen === 'unknown') &&
      resumeWhiteRatio > ${RESUME_TEXT_WHITE_THRESHOLD};

    let gameplay;
    if (screen === 'gameplay') {
      const playerHealthBar = playerHealthComponents
        .filter((component) =>
          component.xRatio >= 0.025 && component.xRatio <= 0.975 &&
          component.yRatio >= 0.2 && component.yRatio <= 0.78)
        .sort((left, right) =>
          right.widthRatio * right.density - left.widthRatio * left.density)[0];
      const playerX = playerHealthBar?.xRatio ?? 0.5;
      const playerY = playerHealthBar
        ? Math.max(0.25, Math.min(0.78, playerHealthBar.yRatio + 0.085))
        : 0.53;
      const nearbyEnemies = enemyComponents
        .map((enemy) => {
          const dx = enemy.xRatio - playerX;
          const dy = enemy.yRatio - playerY;
          return { ...enemy, dx, dy, distance: Math.hypot(dx, dy) };
        })
        .filter((enemy) => enemy.distance > 0.035 && enemy.distance < 0.58);
      let threatX = 0;
      let threatY = 0;
      let threat = 0;
      for (const enemy of nearbyEnemies) {
        const proximity = Math.max(0, 1 - enemy.distance / 0.58);
        const weight = proximity * proximity * (0.8 + enemy.widthRatio * 12);
        threatX += (enemy.dx / enemy.distance) * weight;
        threatY += (enemy.dy / enemy.distance) * weight;
        threat += weight;
      }
      if (Math.hypot(threatX, threatY) < 0.08 && nearbyEnemies.length > 0) {
        const closest = [...nearbyEnemies].sort((left, right) => left.distance - right.distance)[0];
        if (closest) {
          threatX = closest.dx / Math.max(0.01, closest.distance);
          threatY = closest.dy / Math.max(0.01, closest.distance);
        }
      }

      const healthRatio = playerHealthBar
        ? Math.max(0.08, Math.min(1, playerHealthBar.widthRatio / 0.04))
        : undefined;

      const boundaryPixel = (x, y) => {
        const index = (y * width + x) * 4;
        const r = pixels[index];
        const g = pixels[index + 1];
        const b = pixels[index + 2];
        return b > 48 && b > g * 1.18 && b > r * 1.04;
      };
      const edgeDensity = (left, right, top, bottom) => {
        let count = 0;
        let boundary = 0;
        for (let y = top; y <= bottom; y += 2) {
          for (let x = left; x <= right; x += 2) {
            count++;
            if (boundaryPixel(x, y)) boundary++;
          }
        }
        return boundary / Math.max(1, count);
      };
      const edge = {
        left: edgeDensity(0, Math.floor(activeRight * 0.09), worldMinY, worldMaxY),
        right: edgeDensity(Math.floor(activeRight * 0.91), activeRight, worldMinY, worldMaxY),
        top: edgeDensity(0, activeRight, worldMinY, Math.floor(activeBottom * 0.22)),
        bottom: edgeDensity(0, activeRight, Math.floor(activeBottom * 0.84), worldMaxY),
      };
      const boundaryStrength = Math.max(edge.left, edge.right, edge.top, edge.bottom);
      const inwardX = Math.max(0, edge.left - 0.18) - Math.max(0, edge.right - 0.18);
      const inwardY = Math.max(0, edge.top - 0.18) - Math.max(0, edge.bottom - 0.18);

      const rawChestFingerprints = ${chestFingerprints};
      const chestFingerprints = rawChestFingerprints.map((fingerprint) => {
        const binary = atob(fingerprint.rgb);
        const rgb = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) rgb[index] = binary.charCodeAt(index);
        return { ...fingerprint, rgb };
      });
      const exactChestCandidates = [];
      for (const fingerprint of chestFingerprints) {
        const expectedWidth = activeRight * fingerprint.widthRatio;
        const expectedHeight = activeBottom * fingerprint.heightRatio;
        for (const sizeScale of [0.72, 0.84, 0.96, 1.08, 1.2, 1.34]) {
          const patchWidth = Math.max(7, expectedWidth * sizeScale);
          const patchHeight = Math.max(7, expectedHeight * sizeScale);
          const halfWidth = patchWidth / 2;
          const halfHeight = patchHeight / 2;
          for (let centerY = worldMinY + halfHeight; centerY <= worldMaxY - halfHeight; centerY += 3) {
            for (let centerX = halfWidth; centerX <= activeRight - halfWidth; centerX += 3) {
              let difference = 0;
              let sourceSum = 0;
              let targetSum = 0;
              let sourceSquareSum = 0;
              let targetSquareSum = 0;
              let productSum = 0;
              let compared = 0;
              for (let targetY = 0; targetY < 6; targetY++) {
                for (let targetX = 0; targetX < 6; targetX++) {
                  const targetIndex = (targetY * 6 + targetX) * 3;
                  const sourceX = Math.max(0, Math.min(width - 1,
                    Math.round(centerX - halfWidth + ((targetX + 0.5) / 6) * patchWidth)));
                  const sourceY = Math.max(0, Math.min(height - 1,
                    Math.round(centerY - halfHeight + ((targetY + 0.5) / 6) * patchHeight)));
                  const sourceIndex = (sourceY * width + sourceX) * 4;
                  for (let channel = 0; channel < 3; channel++) {
                    const sourceValue = pixels[sourceIndex + channel];
                    const targetValue = fingerprint.rgb[targetIndex + channel];
                    difference += Math.abs(sourceValue - targetValue);
                    sourceSum += sourceValue;
                    targetSum += targetValue;
                    sourceSquareSum += sourceValue * sourceValue;
                    targetSquareSum += targetValue * targetValue;
                    productSum += sourceValue * targetValue;
                    compared++;
                  }
                }
              }
              const error = difference / Math.max(1, compared * 255);
              if (error > 0.12) continue;
              const covariance = productSum - (sourceSum * targetSum) / compared;
              const sourceVariance = sourceSquareSum - (sourceSum * sourceSum) / compared;
              const targetVariance = targetSquareSum - (targetSum * targetSum) / compared;
              const correlation = covariance /
                Math.max(1, Math.sqrt(Math.max(0, sourceVariance) * Math.max(0, targetVariance)));
              if (correlation < 0.75) continue;
              exactChestCandidates.push({
                xRatio: centerX / Math.max(1, activeRight),
                yRatio: centerY / Math.max(1, activeBottom),
                widthRatio: patchWidth / width,
                heightRatio: patchHeight / height,
                score: (0.16 - error) * 1000 + correlation * 10,
                error,
                correlation,
              });
            }
          }
        }
      }
      exactChestCandidates.sort((left, right) => right.score - left.score);
      const distinctExactChests = exactChestCandidates.filter((candidate, index, all) =>
        all.slice(0, index).every((other) =>
          Math.hypot(candidate.xRatio - other.xRatio, candidate.yRatio - other.yRatio) > 0.045),
      ).slice(0, 8);
      const collectibleChests = distinctExactChests
        .filter((item) => item.xRatio > 0.12 && item.xRatio < 0.84);

      const pickupCandidates = [
        ...collectibleChests
          .map((item) => ({ ...item, kind: 'chest', source: 'template', priority: 7 })),
        ...crystalComponents
          .filter((item) => item.xRatio > 0.06 && item.xRatio < 0.94)
          .map((item) => ({ ...item, kind: 'crystal', source: 'colour', priority: 2.4 })),
      ].map((item) => {
        const dx = item.xRatio - playerX;
        const dy = item.yRatio - playerY;
        const distance = Math.hypot(dx, dy);
        return { ...item, dx, dy, distance, value: item.priority / (0.1 + distance) };
      }).filter((item) => item.distance > 0.045 && item.distance < 0.62)
        .sort((left, right) => right.value - left.value);
      const pickup = pickupCandidates[0];
      let dangerScore = Math.max(0, Math.min(1, threat / 3.4));
      const damagedUnderPressure =
        healthRatio !== undefined && healthRatio < 0.62 && dangerScore > 0.25;
      const criticalHealth = healthRatio !== undefined && healthRatio < 0.48;
      if (criticalHealth) dangerScore = Math.max(0.78, dangerScore);

      let mode = 'explore';
      let directionX = 0;
      let directionY = 0;
      if (dangerScore >= 0.72 || damagedUnderPressure) {
        mode = boundaryStrength > 0.27 ? 'escape' : 'retreat';
        directionX = -threatX * 1.45 + inwardX * 6.2;
        directionY = -threatY * 1.45 + inwardY * 6.2;
      } else if (boundaryStrength > 0.42) {
        mode = 'escape';
        directionX = inwardX + (pickup?.dx ?? 0) * 0.2;
        directionY = inwardY + (pickup?.dy ?? 0) * 0.2;
      } else if (pickup) {
        mode = 'collect';
        const lootWeight = pickup.kind === 'chest' ? 2.2 : 1.65;
        const kiteWeight = dangerScore > 0.3 ? 0.68 : 0.22;
        directionX = pickup.dx * lootWeight - threatX * kiteWeight + inwardX * 2.5;
        directionY = pickup.dy * lootWeight - threatY * kiteWeight + inwardY * 2.5;
      } else if (boundaryStrength > 0.29) {
        mode = 'escape';
        directionX = inwardX;
        directionY = inwardY;
      }
      const magnitude = Math.hypot(directionX, directionY);
      if (magnitude > 0.001) {
        directionX /= magnitude;
        directionY /= magnitude;
      }
      gameplay = {
        mode,
        directionX,
        directionY,
        dangerScore,
        enemyCount: nearbyEnemies.length,
        playerXRatio: playerX,
        playerYRatio: playerY,
        ...(healthRatio !== undefined ? { healthRatio } : {}),
        ...(pickup ? { pickupKind: pickup.kind, pickupDistance: pickup.distance } : {}),
        ...(pickup
          ? {
              pickupSource: pickup.source,
              pickupXRatio: pickup.xRatio,
              pickupYRatio: pickup.yRatio,
              ...(pickup.error !== undefined ? { pickupMatchError: pickup.error } : {}),
              ...(pickup.correlation !== undefined
                ? { pickupCorrelation: pickup.correlation }
                : {}),
            }
          : {}),
        interact: Boolean(pickup && pickup.kind === 'chest' && pickup.distance < 0.34),
        dash:
          dangerScore >= 0.52 ||
          Boolean(pickup && pickup.distance > (pickup.kind === 'chest' ? 0.1 : 0.16)),
        boundaryStrength,
        detectedChests: collectibleChests.length,
        detectedCrystals: crystalComponents.length,
      };
    }

    return {
      screen,
      subclassSelected: Boolean(subclassLikely && subclassStartTarget),
      resumeLikely,
      actionTarget: gameOverTarget || (subclassLikely ? subclassStartTarget : actionComponents[0]),
      menuTarget: mainMenuTarget || brightnessTarget,
      choiceLikely,
      subclassLayout,
      choiceScores,
      choiceNames: skillMatches.map((match) => match ? match.name : null),
      choiceMatchErrors: skillMatches.map((match) => match ? match.error : null),
      gameplay,
      activeRightRatio: Math.max(0.55, activeRight / width),
      activeBottomRatio: Math.max(0.55, activeBottom / height),
    };
  })()`;
}

/** Inspect the rendered Unity frame, including internal letterboxing and game entities. */
export async function analyzeTollanCanvas(page: Page): Promise<TollanCanvasAnalysis> {
  const canvas = (await page.$('canvas')) as ElementHandle | null;
  if (!canvas) return EMPTY_ANALYSIS;
  try {
    const screenshot = await canvas.screenshot({ type: 'png', encoding: 'base64' });
    const encoded =
      typeof screenshot === 'string' ? screenshot : Buffer.from(screenshot).toString('base64');
    const result = (await page.evaluate(analysisSource(encoded))) as TollanCanvasAnalysis | null;
    if (!result) return EMPTY_ANALYSIS;
    return result.choiceLikely && result.choiceScores
      ? { ...result, choiceTarget: preferredTollanChoice(result.choiceScores) }
      : result;
  } catch {
    return EMPTY_ANALYSIS;
  } finally {
    await canvas.dispose().catch(() => undefined);
  }
}
