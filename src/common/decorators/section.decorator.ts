import { SetMetadata } from '@nestjs/common';
import type { AppSection } from '../../modules/auth/roles';

export const SECTION_KEY = 'section';

/**
 * The half of the app a controller belongs to — Social Media or Critical Flow.
 * Checked by ApiKeyGuard alongside `@MinRole`, so someone confined to one
 * section cannot read the other's data by calling the API directly.
 */
export const Section = (section: AppSection) => SetMetadata(SECTION_KEY, section);
