import { IsEmail, IsString, MinLength, IsOptional, IsIn } from 'class-validator';
import { UserRole } from '../../modules/auth/entities/user.entity';
import { ASSIGNABLE_ROLES } from '../../modules/auth/roles';

export class SetupDto {
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  password: string;

  @IsOptional()
  @IsIn(ASSIGNABLE_ROLES, { message: `Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}` })
  role?: UserRole;
}
