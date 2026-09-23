import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../../modules/auth/entities/user.entity';

export const MIN_ROLE_KEY = 'minRole';

/**
 * The lowest role allowed to call this route. Checked by ApiKeyGuard after
 * authentication, so the UI's role gates are enforced on the server too.
 */
export const MinRole = (role: UserRole) => SetMetadata(MIN_ROLE_KEY, role);
