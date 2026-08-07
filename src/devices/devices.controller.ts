import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { DevicesService } from './devices.service';
import { CurrentUser, type AuthUser } from '../common/guards/auth.guards';
import { ZodValidationPipe } from '../common/validation/zod.pipe';
import {
  createDeviceSchema,
  type CreateDeviceDto,
} from '../common/validation/schemas';

@Controller('devices')
export class DevicesController {
  constructor(private readonly devicesService: DevicesService) {}

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createDeviceSchema)) dto: CreateDeviceDto,
  ) {
    return this.devicesService.create(user.userId, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.devicesService.list(user.userId);
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.devicesService.getById(user.userId, id);
  }

  @Post(':id/revoke')
  revoke(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.devicesService.revoke(user.userId, id);
  }
}
