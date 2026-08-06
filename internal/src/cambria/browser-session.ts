import type { CambriaHttpRequest, CambriaHttpResponse, CambriaSessionSeed } from './client.js';
import type { Proxy } from '../vault/schema.js';

export interface CambriaBrowserContext {
  sessionKey: string;
  address: string;
  lobbyUrl: string;
  apiBase: string;
  privyApiBase: string;
  privyAppId: string;
  privyClient: string;
  proxy: Proxy;
}

export interface CambriaBrowserPrepareInput extends CambriaBrowserContext {
  seed: CambriaSessionSeed;
}

export interface CambriaBrowserVerifyInput extends CambriaBrowserContext {
  seed?: CambriaSessionSeed;
  accountLabel?: string;
}

export interface CambriaBrowserRequestInput extends CambriaBrowserContext {
  request: CambriaHttpRequest;
}

/** Implemented by the Electron shell so API calls reuse Chromium's cookie jar. */
export interface CambriaBrowserSessionBridge {
  isReady(input: CambriaBrowserContext): Promise<boolean>;
  prepare(input: CambriaBrowserPrepareInput): Promise<void>;
  verify(input: CambriaBrowserVerifyInput): Promise<void>;
  request(input: CambriaBrowserRequestInput): Promise<CambriaHttpResponse>;
}
