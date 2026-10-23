import { UserRole } from './entities/user.entity';

/**
 * The parts of the app a manager or user is confined to. `roundup` is the
 * Sheet Roundup on its own: Critical Flow roles have it alongside `cf`, and
 * AHE Users have only it.
 */
export type AppSection = 'sm' | 'cf' | 'roundup';

const RANK: Record<UserRole, number> = {
  [UserRole.USER]: 1,
  [UserRole.SM_USER]: 1,
  [UserRole.CF_USER]: 1,
  [UserRole.AHE_USER]: 1,
  [UserRole.MANAGEMENT]: 2,
  [UserRole.SM_MANAGER]: 2,
  [UserRole.CF_MANAGER]: 2,
  [UserRole.ADMIN]: 3,
  [UserRole.SUPERADMIN]: 4,
};

const SECTIONS: Partial<Record<UserRole, AppSection[]>> = {
  [UserRole.SM_USER]: ['sm'],
  [UserRole.SM_MANAGER]: ['sm'],
  [UserRole.CF_USER]: ['cf', 'roundup'],
  [UserRole.CF_MANAGER]: ['cf', 'roundup'],
  [UserRole.AHE_USER]: ['roundup'],
};

/** At least `min` — so a superadmin passes every check an admin does. */
export function hasRole(role: string | null | undefined, min: UserRole): boolean {
  return (RANK[role as UserRole] ?? 0) >= RANK[min];
}

/** Admins are in every section; `user` and the old `management` are in none. */
export function inSection(role: string | null | undefined, section: AppSection): boolean {
  return hasRole(role, UserRole.ADMIN) || !!SECTIONS[role as UserRole]?.includes(section);
}

/** The roles the superadmin can hand out. Superadmin itself is env-defined only. */
export const ASSIGNABLE_ROLES: UserRole[] = [
  UserRole.USER,
  UserRole.SM_USER,
  UserRole.SM_MANAGER,
  UserRole.CF_USER,
  UserRole.CF_MANAGER,
  UserRole.AHE_USER,
  UserRole.ADMIN,
];
