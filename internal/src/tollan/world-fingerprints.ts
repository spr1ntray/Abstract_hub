export interface TollanWorldFingerprint {
  name: string;
  widthRatio: number;
  heightRatio: number;
  rgb: string;
}

/**
 * Compact 6x6 fingerprints of the three chest styles seen in Practice.
 * Structure and contrast are checked together so spell effects are not treated as loot.
 */
export const TOLLAN_CHEST_FINGERPRINTS: readonly TollanWorldFingerprint[] = [
  {
    name: 'wooden',
    widthRatio: 0.02877697841726619,
    heightRatio: 0.05010438413361169,
    rgb: 'XVdCdjYjgTYbgjMfbDglgVtAalEllTkkmT4imT8jjTQcZVgoalkwiDAfhyoXhyoZhTIlamAvYVIocCsibBULZRMDbigbY1wsST42ez4oVjItd153e0pbVEocXF92bTIiZCIXWSs3YTtMXVMj',
  },
  {
    name: 'steel',
    widthRatio: 0.02877697841726619,
    heightRatio: 0.05010438413361169,
    rgb: 'bG0mZlptSjtnZld3dGaERTVjbG0mbWB5aU6jemWZhHCXZUmcbG4oWlNqExE6OzVZT0RqEhE3YmYfQEpWREtgS0ddSEJYRkpeaGklGyErEhM1IR4/JR9AFBQ3bXEmSEsiQ0UkQEMfPEIfP0Ql',
  },
  {
    name: 'royal',
    widthRatio: 0.02877697841726619,
    heightRatio: 0.05010438413361169,
    rgb: 'GxwQJBwPJBwNIhwQIhkRJhsOQhkpSAsrd0lMWCAzQQspQSspNA8qMwAqhUZNUBYwMAEoPyUqKRQbGBIeVikjLRcaGxEcPhoWRhgXRx4gOBsePRsgRRobPw8ODwARDQAUDQAUDgAVCwAVGAMM',
  },
];
