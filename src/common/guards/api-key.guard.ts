import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request } from 'express';
import { User, UserRole } from '../../modules/auth/entities/user.entity';
import { hasRole } from '../../modules/auth/roles';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { MIN_ROLE_KEY } from '../decorators/min-role.decorator';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    @InjectRepository(User)
    private userRepo: Repository<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();

    // Browser callers present the cookie the login flow set. Server-to-server
    // callers (the weekly risk routine) hold no cookie jar, so the same key is
    // also accepted as a header. Both resolve to the same `users.apiKey`
    // lookup below, so this widens how the key arrives, not who may use it.
    const headerKey = request.headers['x-api-key'];
    const apiKey =
      request.cookies?.['auth_token'] ??
      (Array.isArray(headerKey) ? headerKey[0] : headerKey);

    if (!apiKey) {
      throw new UnauthorizedException('Authentication token is missing');
    }

    const user = await this.userRepo.findOne({ where: { apiKey } });

    if (!user) {
      throw new UnauthorizedException(
        'Invalid or expired authentication token',
      );
    }

    request['user'] = user;

    const minRole = this.reflector.getAllAndOverride<UserRole | undefined>(MIN_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (minRole && !hasRole(user.role, minRole)) {
      throw new ForbiddenException('Your access level does not allow this action');
    }
    return true;
  }
}
