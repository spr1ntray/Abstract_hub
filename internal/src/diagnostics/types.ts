export interface DeveloperDiagnosticsStatus {
  available: boolean;
  enabled: boolean;
  directory: string;
  currentFile: string | null;
  files: string[];
}

export interface DeveloperDiagnosticsBridge {
  status(): DeveloperDiagnosticsStatus;
  setEnabled(enabled: boolean): DeveloperDiagnosticsStatus;
  record(source: string, event: string, data?: unknown): void;
  recent(limit?: number): unknown[];
  openFolder(): Promise<void>;
  saveImage?(source: string, label: string, buffer: Buffer): string | null;
}
