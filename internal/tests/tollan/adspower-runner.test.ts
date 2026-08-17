import { describe, expect, it } from 'vitest';
import {
  createTollanControlProfile,
  isTollanPracticeDocument,
  TOLLAN_DECISION_POLL_MS,
  TOLLAN_MAIN_MENU_TARGETS,
  TOLLAN_PRACTICE_START_TARGETS,
  TOLLAN_ORBIT_PHASES,
  tollanBatchOpenCount,
  tollanMovementKeys,
  tollanMovementTransition,
  tollanMainMenuClickTarget,
  tollanMissionActionTemplateEligible,
  tollanMissionBoardRequest,
  tollanMissionClaimRequest,
  tollanChoiceClickTarget,
  tollanCompletedRunAction,
  tollanPracticeScreenAction,
  tollanPracticeScoreBelongsToCurrentRun,
  tollanPracticeStartClickTarget,
  tollanSubclassClickTarget,
  tollanClientEndpoint,
  tollanRouteUrl,
  tollanRunActivitySignature,
  tollanResumeMovementKeys,
  tollanServerActionBodyIsReadOnly,
  tollanWorkerTabNeedsActivation,
  shouldAcceptTollanDialog,
} from '../../src/tollan/adspower-runner.js';
import {
  preferredTollanMainMenuTarget,
  preferredTollanChoice,
  tollanResumeOverlayLikely,
  tollanScreenFromSignals,
  tollanSubclassLayoutLikely,
} from '../../src/tollan/canvas-vision.js';
import { tollanSkillPriority } from '../../src/tollan/skill-fingerprints.js';

describe('Tollan AdsPower page detection', () => {
  it('does not mistake the canvas-backed marketing page for Practice', () => {
    expect(
      isTollanPracticeDocument(
        'https://hub.tollan.io/',
        'MASTER ELEMENTS. EARN YOUR LEGACY. PLAY NOW',
      ),
    ).toBe(false);
  });

  it('accepts only the authenticated Practice route', () => {
    expect(
      isTollanPracticeDocument(
        'https://hub.tollan.io/game/practice',
        'Tollan Universe Practice Wave 1 Sign Out',
      ),
    ).toBe(true);
    expect(isTollanPracticeDocument('https://hub.tollan.io/game/practice', 'Sign In to Play')).toBe(
      false,
    );
  });

  it('confirms only the browser prompt that protects an active Practice page', () => {
    expect(shouldAcceptTollanDialog('beforeunload')).toBe(true);
    expect(shouldAcceptTollanDialog('confirm')).toBe(false);
    expect(shouldAcceptTollanDialog('alert')).toBe(false);
  });

  it('separates client readiness from the authoritative Practice start', () => {
    expect(tollanClientEndpoint('https://hub.tollan.io/api/client/get-inventory')).toBe(
      'get-inventory',
    );
    expect(tollanClientEndpoint('https://hub.tollan.io/api/client/practice-start')).toBe(
      'practice-start',
    );
    expect(tollanClientEndpoint('https://hub.tollan.io/api/client/frodo-killed')).toBe(
      'frodo-killed',
    );
    expect(tollanClientEndpoint('https://hub.tollan.io/game/practice')).toBeNull();
    expect(tollanPracticeScoreBelongsToCurrentRun(0)).toBe(false);
    expect(tollanPracticeScoreBelongsToCurrentRun(Number.NaN)).toBe(false);
    expect(tollanPracticeScoreBelongsToCurrentRun(Date.now())).toBe(true);
  });

  it('keeps fallback targets while visual detection remains the primary start path', () => {
    expect(TOLLAN_PRACTICE_START_TARGETS[0]).toEqual([0.8, 0.875]);
    expect(TOLLAN_PRACTICE_START_TARGETS.every(([x, y]) => x >= 0.78 && y >= 0.86)).toBe(true);
  });

  it('uses the real Tollan hash routes while preserving the Abstract source', () => {
    const hubUrl = 'https://hub.tollan.io/?utm_source=abstract-portal';
    expect(tollanRouteUrl(hubUrl, '/')).toBe(hubUrl);
    expect(tollanRouteUrl(hubUrl, '/missions/daily')).toBe(
      'https://hub.tollan.io/?utm_source=abstract-portal#/missions/daily',
    );
    expect(tollanRouteUrl(hubUrl, '/missions/weekly')).toBe(
      'https://hub.tollan.io/?utm_source=abstract-portal#/missions/weekly',
    );
    expect(tollanRouteUrl(hubUrl, '/inventory/items')).toBe(
      'https://hub.tollan.io/?utm_source=abstract-portal#/inventory/items',
    );
  });

  it('reads the number of rewards selected by Tollan Batch Open', () => {
    expect(tollanBatchOpenCount('BATCH OPEN (3)')).toBe(3);
    expect(tollanBatchOpenCount('Batch Open (27)')).toBe(27);
    expect(tollanBatchOpenCount('OPEN')).toBe(1);
  });

  it('keeps a responsive fallback path while vision has no target', () => {
    expect(TOLLAN_ORBIT_PHASES).toHaveLength(8);
    expect(TOLLAN_ORBIT_PHASES).toContainEqual(['KeyD']);
    expect(TOLLAN_ORBIT_PHASES).toContainEqual(['KeyW', 'KeyA']);
    expect(TOLLAN_DECISION_POLL_MS[1]).toBeLessThanOrEqual(250);
  });

  it('changes direction without releasing every movement key first', () => {
    expect(tollanMovementTransition(['KeyW', 'KeyD'], ['KeyS', 'KeyD'])).toEqual({
      press: ['KeyS'],
      release: ['KeyW'],
    });
    expect(tollanMovementTransition(['KeyW'], ['KeyW', 'KeyA'])).toEqual({
      press: ['KeyA'],
      release: [],
    });
  });

  it('recognizes the movement-resume overlay even when card vision misclassifies it', () => {
    expect(tollanResumeOverlayLikely('gameplay', 0.094)).toBe(true);
    expect(tollanResumeOverlayLikely('choice', 0.094)).toBe(true);
    expect(tollanResumeOverlayLikely('gameplay', 0.044)).toBe(false);
    expect(tollanResumeOverlayLikely('game_over', 0.094)).toBe(false);
  });

  it('recognizes the asymmetric subclass menu before skill fingerprints', () => {
    expect(
      tollanSubclassLayoutLikely({
        leftLitRatio: 0.1244,
        rightLitRatio: 0,
        rightDarkRatio: 1,
      }),
    ).toBe(true);
    expect(
      tollanSubclassLayoutLikely({
        leftLitRatio: 0.12,
        rightLitRatio: 0.08,
        rightDarkRatio: 0.55,
      }),
    ).toBe(false);
    expect(
      tollanSubclassLayoutLikely({
        leftLitRatio: 0.01,
        rightLitRatio: 0,
        rightDarkRatio: 1,
      }),
    ).toBe(false);
  });

  it('uses a two-key native chord to resume a paused run', () => {
    expect(tollanResumeMovementKeys(['KeyW'], 0)).toEqual(['KeyW', 'KeyD']);
    expect(tollanResumeMovementKeys(['KeyS', 'KeyA'], 0)).toEqual(['KeyS', 'KeyA']);
    expect(tollanResumeMovementKeys([], 4)).toEqual(['KeyS', 'KeyA']);
  });

  it('reactivates only a hidden or frozen Practice tab', () => {
    expect(tollanWorkerTabNeedsActivation('visible')).toBe(false);
    expect(tollanWorkerTabNeedsActivation('hidden')).toBe(true);
    expect(tollanWorkerTabNeedsActivation('prerender')).toBe(true);
  });

  it('creates a bounded but run-specific control profile', () => {
    const low = createTollanControlProfile(() => 0.1);
    const high = createTollanControlProfile(() => 0.9);
    expect(low.clockwise).toBe(false);
    expect(high.clockwise).toBe(true);
    expect(low.directionCommitMs[0]).toBeGreaterThanOrEqual(180);
    expect(high.directionCommitMs[1]).toBeLessThanOrEqual(760);
    expect(low.chestMemoryMs).toBeGreaterThanOrEqual(3_800);
    expect(high.chestMemoryMs).toBeLessThanOrEqual(6_800);
    expect(low).not.toEqual(high);
  });

  it('translates visual vectors into responsive movement keys', () => {
    expect(tollanMovementKeys({ directionX: -0.8, directionY: -0.6 })).toEqual(['KeyW', 'KeyA']);
    expect(tollanMovementKeys({ directionX: 0.9, directionY: 0.1 })).toEqual(['KeyD']);
    expect(tollanMovementKeys({ directionX: 0, directionY: 0 }, 3)).toEqual(['KeyS']);
  });

  it('handles first-run brightness and the Unity main menu before START', () => {
    const base = {
      choiceLikely: false,
      activeRightRatio: 1,
      activeBottomRatio: 1,
    } as const;
    expect(tollanPracticeScreenAction({ ...base, screen: 'brightness' })?.target).toMatchObject({
      xRatio: 0.5,
      yRatio: 0.78,
    });
    expect(tollanPracticeScreenAction({ ...base, screen: 'main_menu' })?.target).toMatchObject({
      xRatio: 0.27,
      yRatio: 0.42,
    });
    expect(
      tollanPracticeScreenAction({
        ...base,
        screen: 'subclass',
        subclassSelected: true,
        actionTarget: { xRatio: 0.808, yRatio: 0.771, score: 1_100 },
      }),
    ).toMatchObject({
      target: { xRatio: 0.808, yRatio: 0.771 },
      message: 'Запускаем выбранный класс',
    });
    expect(
      tollanPracticeScreenAction(
        {
          ...base,
          screen: 'gameplay',
          actionTarget: { xRatio: 0.8, yRatio: 0.7, score: 20 },
        },
        false,
      ),
    ).toBeNull();
  });

  it('retries menu, subclass and START controls without leaving their hit areas', () => {
    const base = {
      screen: 'main_menu',
      choiceLikely: false,
      activeRightRatio: 1,
      activeBottomRatio: 1,
    } as const;
    expect(
      tollanMainMenuClickTarget(
        { ...base, menuTarget: { xRatio: 0.224, yRatio: 0.429, score: 1_400 } },
        0,
      ),
    ).toMatchObject({ xRatio: 0.224, yRatio: 0.429 });
    expect(tollanMainMenuClickTarget(base, 2)).toMatchObject({ xRatio: 0.275, yRatio: 0.435 });
    expect(tollanSubclassClickTarget('Monk', 0)).toMatchObject({
      xRatio: 0.21,
      yRatio: 0.48,
    });
    expect(tollanSubclassClickTarget('Monk', 3)).toMatchObject({
      xRatio: 0.21,
      yRatio: 0.498,
    });
    expect(
      tollanPracticeStartClickTarget(
        {
          ...base,
          screen: 'subclass',
          subclassSelected: true,
          actionTarget: { xRatio: 0.808, yRatio: 0.771, score: 1_100 },
        },
        0,
      ),
    ).toMatchObject({ xRatio: 0.808, yRatio: 0.771 });
    expect(tollanPracticeStartClickTarget(base, 1)).toMatchObject({
      xRatio: 0.78,
      yRatio: 0.86,
    });
  });

  it('prioritizes the real PLAY control over false skill fingerprints in the main menu', () => {
    const play = preferredTollanMainMenuTarget([
      {
        xRatio: 0.224,
        yRatio: 0.268,
        widthRatio: 0.11,
        heightRatio: 0.04,
        density: 0.5,
        score: 1_900,
      },
      {
        xRatio: 0.2693,
        yRatio: 0.4185,
        widthRatio: 0.14,
        heightRatio: 0.05,
        density: 0.55,
        score: 1_451,
      },
      {
        xRatio: 0.269,
        yRatio: 0.51,
        widthRatio: 0.14,
        heightRatio: 0.05,
        density: 0.5,
        score: 1_300,
      },
    ]);

    expect(play).toMatchObject({ xRatio: 0.2693, yRatio: 0.4185 });
    expect(
      tollanScreenFromSignals({
        gameOver: false,
        subclass: false,
        mainMenu: Boolean(play),
        brightness: false,
        choice: true,
        gameplay: true,
      }),
    ).toBe('main_menu');
    expect(TOLLAN_MAIN_MENU_TARGETS[0]).toEqual([0.27, 0.42]);
  });

  it('uses the strongest detected build option and the middle as a stable tie-breaker', () => {
    expect(preferredTollanChoice([30, 120, 10]).xRatio).toBe(0.5);
    expect(preferredTollanChoice([80, 20, 10]).xRatio).toBe(0.17);
    expect(preferredTollanChoice([0, 0, 0]).xRatio).toBe(0.5);
  });

  it('retries a choice inside the same preferred card and recognizes the run result', () => {
    const analysis = {
      screen: 'choice',
      choiceLikely: true,
      choiceTarget: { xRatio: 0.82, yRatio: 0.54, score: 1_000 },
      activeRightRatio: 1,
      activeBottomRatio: 1,
    } as const;
    expect(tollanChoiceClickTarget(analysis, 0)).toMatchObject({ xRatio: 0.82, yRatio: 0.54 });
    expect(tollanChoiceClickTarget(analysis, 1)).toMatchObject({ xRatio: 0.82, yRatio: 0.38 });
    expect(
      tollanCompletedRunAction({
        ...analysis,
        screen: 'game_over',
        choiceLikely: false,
        actionTarget: { xRatio: 0.5, yRatio: 0.64, score: 40 },
      }),
    ).toMatchObject({ target: { xRatio: 0.5, yRatio: 0.64 }, message: 'Нажимаем Continue' });
  });

  it('prioritizes regeneration, fire and the useful water skills', () => {
    expect(tollanSkillPriority('skill_icon_Collector')).toBeGreaterThan(
      tollanSkillPriority('skill_icon_Rejuvenation'),
    );
    expect(tollanSkillPriority('skill_icon_Rejuvenation')).toBeGreaterThan(
      tollanSkillPriority('skill_iconnew_Fireball'),
    );
    expect(tollanSkillPriority('skill_iconnew_Fireball')).toBeGreaterThan(
      tollanSkillPriority('skill_icon_Water_Spirits'),
    );
    expect(tollanSkillPriority('skill_icon_Water_Spirits')).toBeGreaterThan(
      tollanSkillPriority('skill_icon_Waterball'),
    );
    expect(tollanSkillPriority('skill_icon_Waterball')).toBeGreaterThan(
      tollanSkillPriority('skill_icon_ChainLighting'),
    );
    expect(tollanSkillPriority('skill_icon_ChainLighting')).toBeGreaterThan(
      tollanSkillPriority('skill_icon_ArcaneRay'),
    );
    expect(tollanSkillPriority('skill_icon_ArcaneRay')).toBeGreaterThan(
      tollanSkillPriority('skill_icon_WaterSlide'),
    );
  });

  it('replays only passive mission-board actions', () => {
    expect(tollanServerActionBodyIsReadOnly('[{}]')).toBe(true);
    expect(tollanServerActionBodyIsReadOnly('[]')).toBe(true);
    expect(tollanServerActionBodyIsReadOnly('[{"missionId":"daily-1"}]')).toBe(false);
    expect(tollanServerActionBodyIsReadOnly('[{"rewardId":"chest-1"}]')).toBe(false);
    expect(tollanServerActionBodyIsReadOnly('not-json')).toBe(false);
  });

  it('can reuse a passive home action when missions arrived in the page HTML', () => {
    expect(
      tollanMissionActionTemplateEligible({
        url: 'https://hub.tollan.io/?utm_source=abstract-portal',
        headers: { 'next-action': 'a'.repeat(40) },
        body: '[{}]',
      }),
    ).toBe(true);
    expect(
      tollanMissionActionTemplateEligible({
        url: 'https://hub.tollan.io/store',
        headers: { 'next-action': 'a'.repeat(40) },
        body: '[{}]',
      }),
    ).toBe(false);
    expect(
      tollanMissionActionTemplateEligible({
        url: 'https://hub.tollan.io/',
        headers: { 'next-action': 'a'.repeat(40) },
        body: '[{"missionId":"daily-1"}]',
      }),
    ).toBe(false);
  });

  it('builds a first-party mission claim from the captured board request', () => {
    expect(
      tollanMissionClaimRequest(
        {
          url: 'https://hub.tollan.io/',
          headers: { accept: 'text/x-component', 'next-action': 'a'.repeat(40) },
          body: '[{}]',
        },
        '6d9edff5194c9b25d732a52bc7aeb8e4439a12ae',
        'S39_LoginHub_DAILY_1',
      ),
    ).toMatchObject({
      headers: { 'next-action': '6d9edff5194c9b25d732a52bc7aeb8e4439a12ae' },
      body: '[{"missionId":"S39_LoginHub_DAILY_1"}]',
    });
  });

  it('builds a first-party mission-board refresh from any passive home action', () => {
    expect(
      tollanMissionBoardRequest(
        {
          url: 'https://hub.tollan.io/',
          headers: { accept: 'text/x-component', 'next-action': 'a'.repeat(40) },
          body: '[]',
        },
        '031544ec9b56fc927a468cc1de8ccd296438a9a9',
      ),
    ).toMatchObject({
      headers: { 'next-action': '031544ec9b56fc927a468cc1de8ccd296438a9a9' },
      body: '[{}]',
    });
  });

  it('changes the run activity signature only after meaningful visual progress', () => {
    const analysis = {
      screen: 'gameplay',
      choiceLikely: false,
      activeRightRatio: 1,
      activeBottomRatio: 1,
      gameplay: {
        mode: 'collect',
        directionX: 0.4,
        directionY: 0.2,
        dangerScore: 0.1,
        enemyCount: 3,
        playerXRatio: 0.5,
        playerYRatio: 0.5,
        pickupKind: 'crystal',
        pickupXRatio: 0.42,
        pickupYRatio: 0.5,
        interact: false,
        dash: true,
        boundaryStrength: 0.1,
        detectedChests: 0,
        detectedCrystals: 4,
      },
    } as const;
    expect(tollanRunActivitySignature(analysis, 2)).toBe(
      tollanRunActivitySignature(
        { ...analysis, gameplay: { ...analysis.gameplay, pickupXRatio: 0.43 } },
        2,
      ),
    );
    expect(tollanRunActivitySignature(analysis, 2)).not.toBe(
      tollanRunActivitySignature(
        { ...analysis, gameplay: { ...analysis.gameplay, pickupXRatio: 0.7 } },
        2,
      ),
    );
  });
});
