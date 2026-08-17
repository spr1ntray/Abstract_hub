import type { Page } from 'puppeteer-core';

/**
 * Runs before first-party code in every frame and keeps both media elements and
 * WebAudio silent. Unity resumes its AudioContext after pointer input, so a
 * one-time volume change is not sufficient.
 */
export const ADSPOWER_MUTE_AUDIO_SCRIPT = String.raw`(() => {
  const root = window;
  const marker = '__abstractHubAudioMute';
  const active = root[marker];
  if (active && typeof active.enforce === 'function') {
    active.enforce();
    return;
  }

  const contexts = new Set();
  const muteMedia = (media) => {
    try {
      media.muted = true;
      media.volume = 0;
    } catch {
      // Detached or protected media elements can disappear during navigation.
    }
  };
  const suspendContext = (context) => {
    if (!context) return;
    contexts.add(context);
    if (context.state !== 'suspended' && typeof context.suspend === 'function') {
      Promise.resolve(context.suspend()).catch(() => undefined);
    }
  };
  const enforce = () => {
    document.querySelectorAll('audio, video').forEach(muteMedia);
    contexts.forEach(suspendContext);
  };

  const mediaPrototype = root.HTMLMediaElement && root.HTMLMediaElement.prototype;
  if (mediaPrototype && !mediaPrototype.__abstractHubMutedPlay) {
    const nativePlay = mediaPrototype.play;
    Object.defineProperty(mediaPrototype, '__abstractHubMutedPlay', { value: true });
    Object.defineProperty(mediaPrototype, 'play', {
      configurable: true,
      writable: true,
      value: function (...args) {
        muteMedia(this);
        return nativePlay.apply(this, args);
      },
    });
  }

  const wrapAudioContext = (name) => {
    const NativeContext = root[name];
    if (typeof NativeContext !== 'function') return;
    const prototype = NativeContext.prototype;
    if (prototype && !prototype.__abstractHubMutedResume) {
      Object.defineProperty(prototype, '__abstractHubMutedResume', { value: true });
      Object.defineProperty(prototype, 'resume', {
        configurable: true,
        writable: true,
        value: function () {
          suspendContext(this);
          return Promise.resolve();
        },
      });
    }
    if (NativeContext.__abstractHubMutedConstructor) return;
    const WrappedContext = new Proxy(NativeContext, {
      construct(target, args) {
        const context = Reflect.construct(target, args, target);
        suspendContext(context);
        return context;
      },
    });
    Object.defineProperty(WrappedContext, '__abstractHubMutedConstructor', { value: true });
    try {
      Object.defineProperty(root, name, {
        configurable: true,
        writable: true,
        value: WrappedContext,
      });
    } catch {
      // The periodic enforcer still covers contexts exposed by the page.
    }
  };

  wrapAudioContext('AudioContext');
  wrapAudioContext('webkitAudioContext');
  document.addEventListener('play', (event) => muteMedia(event.target), true);
  document.addEventListener(
    'volumechange',
    (event) => {
      const media = event.target;
      if (media && (!media.muted || media.volume !== 0)) muteMedia(media);
    },
    true,
  );
  const observer = new MutationObserver(enforce);
  const observeDocument = () => {
    if (!document.documentElement) return;
    observer.observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.documentElement) observeDocument();
  else document.addEventListener('DOMContentLoaded', observeDocument, { once: true });
  root[marker] = {
    enforce,
    status: () => ({
      contexts: contexts.size,
      runningContexts: [...contexts].filter((context) => context.state === 'running').length,
      media: document.querySelectorAll('audio, video').length,
      audibleMedia: [...document.querySelectorAll('audio, video')].filter(
        (media) => !media.muted && media.volume > 0,
      ).length,
    }),
  };
  enforce();
  setInterval(enforce, 250);
})()`;

export async function muteAdsPowerPageAudio(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(ADSPOWER_MUTE_AUDIO_SCRIPT);
  await page.evaluate(ADSPOWER_MUTE_AUDIO_SCRIPT).catch(() => undefined);
}
