import { randomUUID } from 'node:crypto';

export type HubWorkModule = 'gigaverse' | 'tollan' | 'abstract-xp';

export interface AccountWorkRequest {
  module: HubWorkModule;
  label: string;
  accountAlias: string;
  displayName: string;
  address?: string;
  profileId?: string;
}

export interface AccountWorkSnapshot extends AccountWorkRequest {
  id: string;
  startedAt: string;
}

export interface AccountWorkLease {
  id: string;
  task: AccountWorkSnapshot;
  release: () => void;
}

const MODULE_NAMES: Record<HubWorkModule, string> = {
  gigaverse: 'Gigaverse',
  tollan: 'Tollan',
  'abstract-xp': 'Abstract XP',
};

function normalizedAddress(value: string | undefined): string | undefined {
  const address = value?.trim().toLowerCase();
  return address && /^0x[a-f0-9]{40}$/.test(address) ? address : undefined;
}

function resourcesFor(request: AccountWorkRequest): string[] {
  const address = normalizedAddress(request.address);
  const account = address ?? request.accountAlias.trim().toLowerCase();
  const resources = [`module:${request.module}:account:${account}`];
  const profile = request.profileId?.trim().toLowerCase();
  if (request.module === 'tollan') {
    resources.push(`interactive-browser:account:${account}`);
    if (profile) resources.push(`interactive-profile:${profile}`);
  }
  return resources;
}

export class AccountWorkConflictError extends Error {
  constructor(readonly task: AccountWorkSnapshot) {
    super(
      `${task.displayName} уже занят в ${MODULE_NAMES[task.module]}. ` +
        'Дождитесь завершения или остановите текущую задачу.',
    );
    this.name = 'AccountWorkConflictError';
  }
}

export class AccountWorkCoordinator {
  private readonly tasks = new Map<string, AccountWorkSnapshot>();
  private readonly resources = new Map<string, string>();
  private readonly taskResources = new Map<string, string[]>();

  acquire(request: AccountWorkRequest): AccountWorkLease {
    const requestedResources = resourcesFor(request);
    for (const resource of requestedResources) {
      const ownerId = this.resources.get(resource);
      const owner = ownerId ? this.tasks.get(ownerId) : undefined;
      if (owner) throw new AccountWorkConflictError(owner);
    }

    const id = randomUUID();
    const address = normalizedAddress(request.address);
    const profileId = request.profileId?.trim();
    const task: AccountWorkSnapshot = {
      module: request.module,
      label: request.label,
      accountAlias: request.accountAlias,
      displayName: request.displayName,
      ...(address ? { address } : {}),
      ...(profileId ? { profileId } : {}),
      id,
      startedAt: new Date().toISOString(),
    };
    this.tasks.set(id, task);
    this.taskResources.set(id, requestedResources);
    for (const resource of requestedResources) this.resources.set(resource, id);

    let released = false;
    return {
      id,
      task: structuredClone(task),
      release: () => {
        if (released) return;
        released = true;
        this.release(id);
      },
    };
  }

  acquireMany(requests: AccountWorkRequest[]): AccountWorkLease[] {
    const leases: AccountWorkLease[] = [];
    try {
      for (const request of requests) leases.push(this.acquire(request));
      return leases;
    } catch (error) {
      for (const lease of leases.reverse()) lease.release();
      throw error;
    }
  }

  snapshot(): AccountWorkSnapshot[] {
    return [...this.tasks.values()]
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .map((task) => structuredClone(task));
  }

  taskForAccount(accountAlias: string, address?: string): AccountWorkSnapshot | undefined {
    return this.tasksForAccount(accountAlias, address)[0];
  }

  tasksForAccount(accountAlias: string, address?: string): AccountWorkSnapshot[] {
    const normalized = normalizedAddress(address);
    const alias = accountAlias.trim().toLowerCase();
    return [...this.tasks.values()]
      .filter((task) => {
        const taskAddress = normalizedAddress(task.address);
        return normalized && taskAddress
          ? normalized === taskAddress
          : task.accountAlias.trim().toLowerCase() === alias;
      })
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .map((task) => structuredClone(task));
  }

  clear(): void {
    this.tasks.clear();
    this.resources.clear();
    this.taskResources.clear();
  }

  private release(id: string): void {
    for (const resource of this.taskResources.get(id) ?? []) {
      if (this.resources.get(resource) === id) this.resources.delete(resource);
    }
    this.taskResources.delete(id);
    this.tasks.delete(id);
  }
}
