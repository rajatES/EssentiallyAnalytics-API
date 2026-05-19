import { IsEmail, IsString, MinLength, IsOptional, IsEnum } from 'class-validator';
import { UserRole } from '../../modules/auth/entities/user.entity';

export class SetupDto {
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  password: string;

  @IsOptional()
  @IsEnum(UserRole, { message: 'Role must be one of: admin, management, user' })
  role?: UserRole;
}
