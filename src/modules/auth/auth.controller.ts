import {
  Controller,
  Post,
  Get,
  Body,
  Headers,
  Req,
  UnauthorizedException,
  Res,
} from '@nestjs/common';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import type { Response, Request } from 'express';
import { AuthService } from './auth.service';
import { Public } from '../../common/decorators/public.decorator';
import { UserRole } from './entities/user.entity';
import { LoginDto } from '../../common/dto/login.dto';
import { SetupDto } from '../../common/dto/setup.dto';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async login(@Body() body: LoginDto, @Res({ passthrough: true }) res: Response) {
    const { email, password } = body;

    const {
      apiKey,
      message,
      email: userEmail,
      role,
    } = await this.authService.login(email, password);

    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

    res.cookie('auth_token', apiKey, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: THIRTY_DAYS,
    });

    res.cookie('user_role', role, {
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: THIRTY_DAYS,
    });

    return { message, email: userEmail };
  }

  @Get('me')
  @SkipThrottle()
  async getMe(@Req() req: Request) {
    const apiKey = req.cookies?.['auth_token'];
    if (!apiKey) throw new UnauthorizedException();
    return this.authService.getMe(apiKey);
  }

  @Public()
  @Post('logout')
  async logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie('auth_token');
    res.clearCookie('user_role');
    return { message: 'Logged out successfully' };
  }

  @Public()
  @Post('setup')
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  async setupAdmin(
    @Body() body: SetupDto,
    @Headers('x-setup-secret') setupSecret: string,
  ) {
    const validSetupSecret = process.env.SETUP_SECRET;

    if (!validSetupSecret) {
      throw new UnauthorizedException(
        'Setup secret is not configured on the server.',
      );
    }

    if (setupSecret !== validSetupSecret) {
      throw new UnauthorizedException('Invalid setup secret.');
    }

    const { email, password, role } = body;
    return this.authService.createUser(email, password, role || UserRole.ADMIN);
  }
}
