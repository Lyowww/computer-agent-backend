import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  createParamDecorator,
  SetMetadata,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export interface AuthUser {
  userId: string;
  email: string;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as AuthUser;
  },
);

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    // WebSocket auth is handled in the gateway handshake / REGISTER_DEVICE.
    // Applying Passport JWT here leaves Socket.IO ACKs hanging → client "operation has timed out".
    if (context.getType() !== 'http') {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

export function assertOwnership(
  resourceUserId: string,
  requesterUserId: string,
  resource = 'resource',
): void {
  if (resourceUserId !== requesterUserId) {
    throw new ForbiddenException(`You do not own this ${resource}`);
  }
}

export function requireUser(user: AuthUser | undefined): AuthUser {
  if (!user?.userId) {
    throw new UnauthorizedException('Authentication required');
  }
  return user;
}
