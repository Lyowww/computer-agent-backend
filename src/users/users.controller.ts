import { Controller, Get } from '@nestjs/common';
import { UsersService } from './users.service';
import { CurrentUser, type AuthUser } from '../common/guards/auth.guards';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.usersService.findById(user.userId);
  }
}
