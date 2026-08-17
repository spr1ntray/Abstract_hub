export interface AdsPowerConfig {
  apiUrl: string;
  apiKey: string;
}

export interface AdsPowerProfile {
  id: string;
  serialNumber: string;
  name: string;
  groupId: string;
  groupName: string;
  lastOpenTime?: number;
}

export interface AdsPowerBrowserEndpoint {
  profileId: string;
  status: 'Active' | 'Inactive';
  puppeteerWs?: string;
  seleniumAddress?: string;
  debugPort?: string;
  webdriverPath?: string;
}
