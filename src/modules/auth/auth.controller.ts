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
import { RequestCodeDto, SetPasswordDto, VerifyCodeDto } from '../../common/dto/signup.dto';

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

function setSession(res: Response, apiKey: string, role: string) {
  res.cookie('auth_token', apiKey, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: THIRTY_DAYS,
  });
  setRoleCookie(res, role);
}

/** Readable by the UI for instant role hydration; never trusted by the server. */
function setRoleCookie(res: Response, role: string) {
  res.cookie('user_role', role, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: THIRTY_DAYS,
  });
}

function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || req.ip || '';
}

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

    setSession(res, apiKey, role);
    return { message, email: userEmail };
  }

  @Get('me')
  @SkipThrottle()
  async getMe(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const apiKey = req.cookies?.['auth_token'];
    if (!apiKey) throw new UnauthorizedException();
    const me = await this.authService.getMe(apiKey);
    // A role changed by the superadmin reaches the UI's cookie here.
    setRoleCookie(res, me.role);
    return me;
  }

  @Public()
  @Post('logout')
  async logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie('auth_token');
    res.clearCookie('user_role');
    return { message: 'Logged out successfully' };
  }

  // ── Sign-up / password reset by emailed code ──

  @Public()
  @Post('code')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  requestCode(@Body() body: RequestCodeDto, @Req() req: Request) {
    return this.authService.requestCode(body.email, clientIp(req), body.purpose ?? 'signup');
  }

  @Public()
  @Post('code/verify')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  verifyCode(@Body() body: VerifyCodeDto) {
    return this.authService.verifyCode(body.email, body.code);
  }

  @Public()
  @Post('password')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async setPassword(@Body() body: SetPasswordDto, @Res({ passthrough: true }) res: Response) {
    const session = await this.authService.setPassword(body.email, body.setupToken, body.password);
    setSession(res, session.apiKey, session.role);
    return { email: session.email, role: session.role, created: session.created };
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
