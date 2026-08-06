/* global module */

const claimedEvents = new WeakSet();

function matchingProxyState(states, webContents, authInfo) {
  if (!authInfo?.isProxy) return undefined;
  const candidates = Array.from(states.values()).filter((candidate) => candidate.proxy?.username);
  if (webContents) {
    return candidates.find((candidate) => webContents.session === candidate.browserSession);
  }
  return candidates.find(
    (candidate) =>
      authInfo.host === candidate.proxy.host && Number(authInfo.port) === candidate.proxy.port,
  );
}

function answerProxyLogin(states, event, webContents, authInfo, callback) {
  if (!event || claimedEvents.has(event)) return false;
  const state = matchingProxyState(states, webContents, authInfo);
  if (!state) return false;

  claimedEvents.add(event);
  event.preventDefault();
  callback(state.proxy.username || '', state.proxy.password || '');
  return true;
}

module.exports = { answerProxyLogin, matchingProxyState };
