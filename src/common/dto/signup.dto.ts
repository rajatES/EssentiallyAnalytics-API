import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { UserRole } from '../../modules/auth/entities/user.entity';
import { ASSIGNABLE_ROLES } from '../../modules/auth/roles';

// Emails are checked against the allowed domain in AuthService, which gives a
// clearer message than a generic "must be an email".

export class RequestCodeDto {
  @IsString()
  @MaxLength(254)
  email: string;

  @IsOptional()
  @IsIn(['signup', 'reset'])
  purpose?: 'signup' | 'reset';
}

export class VerifyCodeDto {
  @IsString()
  @MaxLength(254)
  email: string;

  @IsString()
  @MaxLength(12)
  code: string;
}

export class SetPasswordDto {
  @IsString()
  @MaxLength(254)
  email: string;

  @IsString()
  @MaxLength(128)
  setupToken: string;

  @IsString()
  @MaxLength(256)
  password: string;
}

export class UpdateRoleDto {
  @IsIn(ASSIGNABLE_ROLES, { message: `Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}` })
  role: UserRole;
}
