import { UserRole } from './entities/user.entity';

const RANK: Record<UserRole, number> = {
  [UserRole.USER]: 1,
  [UserRole.MANAGEMENT]: 2,
  [UserRole.ADMIN]: 3,
  [UserRole.SUPERADMIN]: 4,
};

/** At least `min` — so a superadmin passes every check an admin does. */
export function hasRole(role: string | null | undefined, min: UserRole): boolean {
  return (RANK[role as UserRole] ?? 0) >= RANK[min];
}

/** The roles the superadmin can hand out. Superadmin itself is env-defined only. */
export const ASSIGNABLE_ROLES: UserRole[] = [
  UserRole.USER,
  UserRole.MANAGEMENT,
  UserRole.ADMIN,
];
