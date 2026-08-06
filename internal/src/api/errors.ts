export class HttpError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message?: string,
  ) {
    super(message ?? `HTTP ${status}`);
    this.name = 'HttpError';
  }
}

export class NoEnergyError extends Error {
  constructor() {
    super('no_energy');
    this.name = 'NoEnergyError';
  }
}

export class SessionExpiredError extends Error {
  constructor() {
    super('session_expired');
    this.name = 'SessionExpiredError';
  }
}

export class CaptchaRequiredError extends Error {
  constructor(
    public siteKey: string,
    public url: string,
  ) {
    super('captcha_required');
    this.name = 'CaptchaRequiredError';
  }
}
