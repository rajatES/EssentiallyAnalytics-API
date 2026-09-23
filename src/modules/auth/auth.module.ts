import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD } from '@nestjs/core';
import { User } from './entities/user.entity';
import { AuthOtp } from './entities/auth-otp.entity';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { AuthController } from './auth.controller';
import { UsersController } from './users.controller';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';

@Module({
  imports: [TypeOrmModule.forFeature([User, AuthOtp])],
  controllers: [AuthController, UsersController],
  providers: [
    AuthService,
    OtpService,
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
